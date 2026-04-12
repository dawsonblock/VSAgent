/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISessionActionReceiptService, SessionActionReceipt, SessionActionReceiptStatus } from '../../actions/common/sessionActionReceipts.js';
import { SessionAutonomyMode } from '../../autonomy/common/sessionAutonomyTypes.js';
import { SessionAutonomousExecutionResult } from '../../autonomy/common/sessionAutonomousExecutionService.js';
import { SessionPlan } from '../../planning/common/sessionPlanTypes.js';
import { ISessionExecutionMemoryService, SessionExecutionMemoryEntry, SessionExecutionPhase, SessionExecutionProgress, sessionPlanStatusToExecutionPhase } from '../common/sessionExecutionMemoryService.js';

export class SessionExecutionMemoryService extends Disposable implements ISessionExecutionMemoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, ISettableObservable<SessionExecutionMemoryEntry | undefined>>();

	constructor(
		@ISessionActionReceiptService private readonly _receiptService: ISessionActionReceiptService,
	) {
		super();
		this._register(this._receiptService.onDidAppendReceipt(entry => this._applyReceipt(entry.receipt)));
	}

	getSessionEntry(sessionId: string) {
		return this._getOrCreateEntry(sessionId);
	}

	getSessionEntryValue(sessionId: string): SessionExecutionMemoryEntry | undefined {
		return this._entries.get(sessionId)?.get();
	}

	beginPlanning(request: { sessionId: string; providerId: string; mode: SessionAutonomyMode; intent: string; summary?: string }): void {
		this._update(request.sessionId, (current, now) => ({
			sessionId: request.sessionId,
			providerId: request.providerId,
			mode: request.mode,
			intent: request.intent,
			summary: request.summary,
			phase: SessionExecutionPhase.Planning,
			plan: current?.plan,
			result: undefined,
			budgetState: undefined,
			progress: current?.plan ? this._createProgress(current.plan, current.progress?.completedStepIds ?? [], current.progress?.lastStepId) : undefined,
			lastReceipt: undefined,
			lastStepResult: undefined,
			errorMessage: undefined,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	setPlan(plan: SessionPlan): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			mode: current?.mode,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: SessionExecutionPhase.Ready,
			plan,
			result: undefined,
			budgetState: undefined,
			progress: this._createProgress(plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId),
			lastReceipt: undefined,
			lastStepResult: undefined,
			errorMessage: undefined,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	beginExecution(plan: SessionPlan): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			mode: current?.mode,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: SessionExecutionPhase.Executing,
			plan,
			result: undefined,
			budgetState: current?.budgetState,
			progress: this._createProgress(plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId),
			lastReceipt: current?.lastReceipt,
			lastStepResult: current?.lastStepResult,
			errorMessage: undefined,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	completeExecution(plan: SessionPlan, result: SessionAutonomousExecutionResult): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			mode: current?.mode,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: sessionPlanStatusToExecutionPhase(result.status),
			plan,
			result,
			budgetState: result.budgetState,
			progress: this._createProgress(plan, this._mergeCompletedStepIds(current?.progress?.completedStepIds, result.stepResults.map(step => step.stepId)), result.stepResults[result.stepResults.length - 1]?.stepId ?? current?.progress?.lastStepId),
			lastReceipt: current?.lastReceipt,
			lastStepResult: result.stepResults[result.stepResults.length - 1] ?? current?.lastStepResult,
			errorMessage: result.status === 'failed' ? (result.issues[0]?.message ?? current?.errorMessage) : current?.errorMessage,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	failExecution(request: { sessionId: string; providerId: string; intent?: string; summary?: string; plan?: SessionPlan; message: string }): void {
		this._update(request.sessionId, (current, now) => ({
			sessionId: request.sessionId,
			providerId: request.providerId,
			mode: current?.mode,
			intent: request.intent ?? current?.intent,
			summary: request.summary ?? current?.summary,
			phase: SessionExecutionPhase.Failed,
			plan: request.plan ?? current?.plan,
			budgetState: current?.budgetState,
			progress: request.plan ? this._createProgress(request.plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId) : current?.progress,
			lastReceipt: current?.lastReceipt,
			lastStepResult: current?.lastStepResult,
			errorMessage: request.message,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	replaceSessionEntry(previousSessionId: string, nextSessionId: string, providerId: string): void {
		if (previousSessionId === nextSessionId) {
			return;
		}

		const previous = this._entries.get(previousSessionId)?.get();
		if (!previous) {
			return;
		}

		this._getOrCreateEntry(nextSessionId).set({
			...previous,
			sessionId: nextSessionId,
			providerId,
			updatedAt: Date.now(),
		}, undefined);
		this.clearSessionEntry(previousSessionId);
	}

	clearSessionEntry(sessionId: string): void {
		const entry = this._entries.get(sessionId);
		if (!entry) {
			return;
		}

		entry.set(undefined, undefined);
		this._entries.delete(sessionId);
	}

	private _getOrCreateEntry(sessionId: string): ISettableObservable<SessionExecutionMemoryEntry | undefined> {
		let entry = this._entries.get(sessionId);
		if (!entry) {
			entry = observableValue<SessionExecutionMemoryEntry | undefined>(`sessionExecutionMemory:${sessionId}`, undefined);
			this._entries.set(sessionId, entry);
		}

		return entry;
	}

	private _update(sessionId: string, update: (current: SessionExecutionMemoryEntry | undefined, now: number) => SessionExecutionMemoryEntry): void {
		const entry = this._getOrCreateEntry(sessionId);
		entry.set(update(entry.get(), Date.now()), undefined);
	}

	private _applyReceipt(receipt: SessionActionReceipt): void {
		if (!receipt.planId || !receipt.planStepId) {
			return;
		}

		const current = this.getSessionEntryValue(receipt.sessionId);
		if (!current?.plan || current.plan.id !== receipt.planId) {
			return;
		}

		const completedStepIds = this._mergeCompletedStepIds(current.progress?.completedStepIds, [receipt.planStepId]);
		const nextPhase = current.result ? sessionPlanStatusToExecutionPhase(current.result.status) : SessionExecutionPhase.Executing;
const errorMessage = receipt.status === SessionActionReceiptStatus.Denied || receipt.status === SessionActionReceiptStatus.Failed
			? (receipt.executionSummary ?? receipt.error?.message ?? current.errorMessage)
			: current.errorMessage;

		this._getOrCreateEntry(receipt.sessionId).set({
			...current,
			phase: nextPhase,
			progress: this._createProgress(current.plan, completedStepIds, receipt.planStepId),
			lastReceipt: receipt,
			budgetState: current.budgetState,
			errorMessage,
			updatedAt: Date.now(),
		}, undefined);
	}

	private _mergeCompletedStepIds(existing: readonly string[] | undefined, additional: readonly string[]): readonly string[] {
		const completedStepIds = new Set(existing ?? []);
		for (const stepId of additional) {
			completedStepIds.add(stepId);
		}

		return [...completedStepIds];
	}

	private _createProgress(plan: SessionPlan, completedStepIds: readonly string[], lastStepId: string | undefined): SessionExecutionProgress {
		return {
			totalSteps: plan.steps.length,
			completedSteps: completedStepIds.length,
			completedStepIds,
			lastStepId,
		};
	}
}

registerSingleton(ISessionExecutionMemoryService, SessionExecutionMemoryService, InstantiationType.Delayed);
