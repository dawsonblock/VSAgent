/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionAutonomousExecutionResult, SessionAutonomousStepResult } from '../../autonomy/common/sessionAutonomousExecutionService.js';
import { SessionPlan } from '../../planning/common/sessionPlanTypes.js';
import { ISessionExecutionMemoryService, SessionExecutionMemoryEntry, SessionExecutionPhase, SessionExecutionProgress, sessionPlanStatusToExecutionPhase } from '../common/sessionExecutionMemoryService.js';

export class SessionExecutionMemoryService implements ISessionExecutionMemoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, ISettableObservable<SessionExecutionMemoryEntry | undefined>>();

	getSessionEntry(sessionId: string) {
		return this._getOrCreateEntry(sessionId);
	}

	getSessionEntryValue(sessionId: string): SessionExecutionMemoryEntry | undefined {
		return this._entries.get(sessionId)?.get();
	}

	beginPlanning(request: { sessionId: string; providerId: string; intent: string; summary?: string }): void {
		this._update(request.sessionId, (current, now) => ({
			sessionId: request.sessionId,
			providerId: request.providerId,
			intent: request.intent,
			summary: request.summary,
			phase: SessionExecutionPhase.Planning,
			plan: current?.plan,
			progress: current?.plan ? this._createProgress(current.plan, current.progress?.completedStepIds ?? [], current.progress?.lastStepId) : undefined,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	setPlan(plan: SessionPlan): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: SessionExecutionPhase.Ready,
			plan,
			progress: this._createProgress(plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId),
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	beginExecution(plan: SessionPlan): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: SessionExecutionPhase.Executing,
			plan,
			progress: this._createProgress(plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId),
			lastStepResult: current?.lastStepResult,
			startedAt: current?.startedAt ?? now,
			updatedAt: now,
		}));
	}

	recordStepResult(plan: SessionPlan, stepResult: SessionAutonomousStepResult): void {
		this._update(plan.sessionId, (current, now) => {
			const completedStepIds = new Set(current?.progress?.completedStepIds ?? []);
			completedStepIds.add(stepResult.stepId);

			return {
				sessionId: plan.sessionId,
				providerId: plan.providerId,
				intent: current?.intent ?? plan.intent,
				summary: current?.summary ?? plan.summary,
				phase: SessionExecutionPhase.Executing,
				plan,
				progress: this._createProgress(plan, [...completedStepIds], stepResult.stepId),
				lastStepResult: stepResult,
				errorMessage: stepResult.result.status === 'failed' ? stepResult.result.summary : current?.errorMessage,
				startedAt: current?.startedAt ?? now,
				updatedAt: now,
			};
		});
	}

	completeExecution(plan: SessionPlan, result: SessionAutonomousExecutionResult): void {
		this._update(plan.sessionId, (current, now) => ({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			intent: current?.intent ?? plan.intent,
			summary: current?.summary ?? plan.summary,
			phase: sessionPlanStatusToExecutionPhase(result.status),
			plan,
			result,
			progress: this._createProgress(plan, result.stepResults.map(step => step.stepId), result.stepResults[result.stepResults.length - 1]?.stepId),
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
			intent: request.intent ?? current?.intent,
			summary: request.summary ?? current?.summary,
			phase: SessionExecutionPhase.Failed,
			plan: request.plan ?? current?.plan,
			progress: request.plan ? this._createProgress(request.plan, current?.progress?.completedStepIds ?? [], current?.progress?.lastStepId) : current?.progress,
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
