/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionAutonomousExecutionResult, SessionAutonomousStepResult } from '../../autonomy/common/sessionAutonomousExecutionService.js';
import { SessionPlan, SessionPlanStatus } from '../../planning/common/sessionPlanTypes.js';

export const enum SessionExecutionPhase {
	Planning = 'planning',
	Ready = 'ready',
	Executing = 'executing',
	Completed = 'completed',
	Stopped = 'stopped',
	Rejected = 'rejected',
	Failed = 'failed',
}

export interface SessionExecutionProgress {
	readonly totalSteps: number;
	readonly completedSteps: number;
	readonly completedStepIds: readonly string[];
	readonly lastStepId?: string;
}

export interface SessionExecutionMemoryEntry {
	readonly sessionId: string;
	readonly providerId: string;
	readonly intent?: string;
	readonly summary?: string;
	readonly phase: SessionExecutionPhase;
	readonly plan?: SessionPlan;
	readonly result?: SessionAutonomousExecutionResult;
	readonly progress?: SessionExecutionProgress;
	readonly lastStepResult?: SessionAutonomousStepResult;
	readonly errorMessage?: string;
	readonly startedAt: number;
	readonly updatedAt: number;
}

export interface ISessionExecutionMemoryService {
	readonly _serviceBrand: undefined;

	getSessionEntry(sessionId: string): IObservable<SessionExecutionMemoryEntry | undefined>;
	getSessionEntryValue(sessionId: string): SessionExecutionMemoryEntry | undefined;
	beginPlanning(request: { sessionId: string; providerId: string; intent: string; summary?: string }): void;
	setPlan(plan: SessionPlan): void;
	beginExecution(plan: SessionPlan): void;
	recordStepResult(plan: SessionPlan, stepResult: SessionAutonomousStepResult): void;
	completeExecution(plan: SessionPlan, result: SessionAutonomousExecutionResult): void;
	failExecution(request: { sessionId: string; providerId: string; intent?: string; summary?: string; plan?: SessionPlan; message: string }): void;
	replaceSessionEntry(previousSessionId: string, nextSessionId: string, providerId: string): void;
	clearSessionEntry(sessionId: string): void;
}

export const ISessionExecutionMemoryService = createDecorator<ISessionExecutionMemoryService>('sessionExecutionMemoryService');

export function sessionPlanStatusToExecutionPhase(status: SessionPlanStatus): SessionExecutionPhase {
	switch (status) {
		case SessionPlanStatus.Completed:
			return SessionExecutionPhase.Completed;
		case SessionPlanStatus.Stopped:
			return SessionExecutionPhase.Stopped;
		case SessionPlanStatus.Rejected:
			return SessionExecutionPhase.Rejected;
		case SessionPlanStatus.Failed:
			return SessionExecutionPhase.Failed;
		case SessionPlanStatus.Executing:
			return SessionExecutionPhase.Executing;
		case SessionPlanStatus.Validated:
		case SessionPlanStatus.Draft:
		default:
			return SessionExecutionPhase.Ready;
	}
}
