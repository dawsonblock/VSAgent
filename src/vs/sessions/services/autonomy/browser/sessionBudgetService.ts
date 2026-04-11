/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionActionKind, SessionActionResult, SessionActionStatus, SessionWriteOperationStatus, WritePatchAction, WritePatchActionResult } from '../../actions/common/sessionActionTypes.js';
import { ISessionBudgetService, SessionBudgetExhaustion, SessionBudgetExhaustionReason, SessionBudgetReservationResult, SessionBudgetState } from '../common/sessionBudgetService.js';
import { estimateSessionPlanWritePatchModifiedFiles, estimateSessionPlanWritePatchWriteCount, SessionPlanBudget, SessionPlanStep, SessionPlanStepKind } from '../../planning/common/sessionPlanTypes.js';

export class SessionBudgetService extends Disposable implements ISessionBudgetService {
	declare readonly _serviceBrand: undefined;

	createBudgetState(requestedBudget: SessionPlanBudget, allowedBudget?: SessionPlanBudget): SessionBudgetState {
		return {
			budget: this._resolveBudget(requestedBudget, allowedBudget),
			startedAt: Date.now(),
			executedSteps: 0,
			executedCommands: 0,
			fileWrites: 0,
			modifiedFiles: [],
			failures: 0,
			attemptsByStep: {},
			elapsedMs: 0,
		};
	}

	reserveStep(state: SessionBudgetState, step: SessionPlanStep): SessionBudgetReservationResult {
		if (state.exhaustion) {
			return { allowed: false, state, exhaustion: state.exhaustion };
		}

		const elapsedMs = Date.now() - state.startedAt;
		if (elapsedMs > state.budget.maxWallClockMs) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxWallClockMs, `Execution exceeded the ${state.budget.maxWallClockMs}ms wall-clock budget before step '${step.id}'.`, step.id), elapsedMs);
		}

		const attemptCount = (state.attemptsByStep[step.id] ?? 0) + 1;
		if (attemptCount > state.budget.maxRetriesPerStep + 1) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxRetriesPerStep, `Step '${step.id}' exhausted the retry budget.`, step.id), elapsedMs);
		}

		const executedSteps = state.executedSteps + 1;
		if (executedSteps > state.budget.maxSteps) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxSteps, `Executing step '${step.id}' would exceed the maxSteps budget.`, step.id), elapsedMs);
		}

		const executedCommands = state.executedCommands + (step.kind === SessionPlanStepKind.RunCommand ? 1 : 0);
		if (executedCommands > state.budget.maxCommands) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxCommands, `Executing step '${step.id}' would exceed the command budget.`, step.id), elapsedMs);
		}

		const projectedFileWrites = state.fileWrites + this._estimateFileWrites(step);
		if (projectedFileWrites > state.budget.maxFileWrites) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxFileWrites, `Executing step '${step.id}' would exceed the file-write budget.`, step.id), elapsedMs);
		}

		const projectedModifiedFiles = this._mergeResources(state.modifiedFiles, this._estimateModifiedFiles(step));
		if (projectedModifiedFiles.length > state.budget.maxModifiedFiles) {
			return this._deny(state, this._createExhaustion(SessionBudgetExhaustionReason.MaxModifiedFiles, `Executing step '${step.id}' would exceed the modified-file budget.`, step.id), elapsedMs);
		}

		return {
			allowed: true,
			state: {
				...state,
				executedSteps,
				executedCommands,
				attemptsByStep: {
					...state.attemptsByStep,
					[step.id]: attemptCount,
				},
				elapsedMs,
			},
		};
	}

	finalizeStep(state: SessionBudgetState, step: SessionPlanStep, result: SessionActionResult): SessionBudgetState {
		const elapsedMs = Date.now() - state.startedAt;
		const fileWrites = state.fileWrites + this._resultFileWrites(result);
		const modifiedFiles = this._mergeResources(state.modifiedFiles, this._resultModifiedFiles(result));
		const failures = state.failures + (result.status === SessionActionStatus.Executed ? 0 : 1);
		let exhaustion = state.exhaustion;

		if (!exhaustion && elapsedMs > state.budget.maxWallClockMs) {
			exhaustion = this._createExhaustion(SessionBudgetExhaustionReason.MaxWallClockMs, `Execution exceeded the ${state.budget.maxWallClockMs}ms wall-clock budget after step '${step.id}'.`, step.id);
		}

		if (!exhaustion && fileWrites > state.budget.maxFileWrites) {
			exhaustion = this._createExhaustion(SessionBudgetExhaustionReason.MaxFileWrites, `Step '${step.id}' exceeded the file-write budget with actual write operations.`, step.id);
		}

		if (!exhaustion && modifiedFiles.length > state.budget.maxModifiedFiles) {
			exhaustion = this._createExhaustion(SessionBudgetExhaustionReason.MaxModifiedFiles, `Step '${step.id}' touched files outside the remaining modified-file budget.`, step.id);
		}

		if (!exhaustion && failures > state.budget.maxFailures) {
			exhaustion = this._createExhaustion(SessionBudgetExhaustionReason.MaxFailures, `Execution exceeded the failure budget after step '${step.id}'.`, step.id);
		}

		return {
			...state,
			fileWrites,
			modifiedFiles,
			failures,
			elapsedMs,
			exhaustion,
		};
	}

	canRetryStep(state: SessionBudgetState, stepId: string): boolean {
		if (state.exhaustion) {
			return false;
		}

		const attempts = state.attemptsByStep[stepId] ?? 0;
		return attempts < state.budget.maxRetriesPerStep + 1;
	}

	private _resolveBudget(requestedBudget: SessionPlanBudget, allowedBudget: SessionPlanBudget | undefined): SessionPlanBudget {
		if (!allowedBudget) {
			return { ...requestedBudget };
		}

		return {
			maxSteps: Math.min(requestedBudget.maxSteps, allowedBudget.maxSteps),
			maxCommands: Math.min(requestedBudget.maxCommands, allowedBudget.maxCommands),
			maxFileWrites: Math.min(requestedBudget.maxFileWrites, allowedBudget.maxFileWrites),
			maxModifiedFiles: Math.min(requestedBudget.maxModifiedFiles, allowedBudget.maxModifiedFiles),
			maxWallClockMs: Math.min(requestedBudget.maxWallClockMs, allowedBudget.maxWallClockMs),
			maxFailures: Math.min(requestedBudget.maxFailures, allowedBudget.maxFailures),
			maxRetriesPerStep: Math.min(requestedBudget.maxRetriesPerStep, allowedBudget.maxRetriesPerStep),
		};
	}

	private _estimateFileWrites(step: SessionPlanStep): number {
		const action = this._asWritePatchAction(step);
		return estimateSessionPlanWritePatchWriteCount(action);
	}

	private _estimateModifiedFiles(step: SessionPlanStep): readonly URI[] {
		const action = this._asWritePatchAction(step);
		return estimateSessionPlanWritePatchModifiedFiles(action);
	}

	private _resultFileWrites(result: SessionActionResult): number {
		if (result.kind !== SessionActionKind.WritePatch) {
			return 0;
		}

		const writePatchResult = result as WritePatchActionResult;
		if (writePatchResult.operations.length === 0) {
			return writePatchResult.filesTouched.length;
		}

		return writePatchResult.operations.filter(operation => operation.status === SessionWriteOperationStatus.Created || operation.status === SessionWriteOperationStatus.Updated || operation.status === SessionWriteOperationStatus.Deleted).length;
	}

	private _resultModifiedFiles(result: SessionActionResult): readonly URI[] {
		if (result.kind === SessionActionKind.WritePatch) {
			return (result as WritePatchActionResult).filesTouched;
		}

		return [];
	}

	private _asWritePatchAction(step: SessionPlanStep): WritePatchAction | undefined {
		if (step.kind !== SessionPlanStepKind.WritePatch || !step.action || step.action.kind !== SessionActionKind.WritePatch) {
			return undefined;
		}

		return step.action;
	}

	private _mergeResources(current: readonly URI[], additions: readonly URI[]): readonly URI[] {
		const merged = new Map<string, URI>();
		for (const resource of current) {
			merged.set(resource.toString(), resource);
		}
		for (const resource of additions) {
			merged.set(resource.toString(), resource);
		}
		return [...merged.values()];
	}

	private _createExhaustion(reason: SessionBudgetExhaustionReason, message: string, stepId?: string): SessionBudgetExhaustion {
		return { reason, message, stepId };
	}

	private _deny(state: SessionBudgetState, exhaustion: SessionBudgetExhaustion, elapsedMs: number): SessionBudgetReservationResult {
		return {
			allowed: false,
			exhaustion,
			state: {
				...state,
				elapsedMs,
				exhaustion,
			},
		};
	}
}

registerSingleton(ISessionBudgetService, SessionBudgetService, InstantiationType.Delayed);
