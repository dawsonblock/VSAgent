/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionActionResult } from '../../actions/common/sessionActionTypes.js';
import { SessionPlanBudget, SessionPlanStep } from '../../planning/common/sessionPlanTypes.js';

export const enum SessionBudgetExhaustionReason {
	MaxSteps = 'maxSteps',
	MaxCommands = 'maxCommands',
	MaxFileWrites = 'maxFileWrites',
	MaxModifiedFiles = 'maxModifiedFiles',
	MaxWallClockMs = 'maxWallClockMs',
	MaxFailures = 'maxFailures',
	MaxRetriesPerStep = 'maxRetriesPerStep',
}

export interface SessionBudgetExhaustion {
	readonly reason: SessionBudgetExhaustionReason;
	readonly message: string;
	readonly stepId?: string;
}

export interface SessionBudgetState {
	readonly budget: SessionPlanBudget;
	readonly startedAt: number;
	readonly executedSteps: number;
	readonly executedCommands: number;
	readonly fileWrites: number;
	readonly modifiedFiles: readonly URI[];
	readonly failures: number;
	readonly attemptsByStep: Readonly<Record<string, number>>;
	readonly elapsedMs: number;
	readonly exhaustion?: SessionBudgetExhaustion;
}

export interface SessionBudgetReservationResult {
	readonly allowed: boolean;
	readonly state: SessionBudgetState;
	readonly exhaustion?: SessionBudgetExhaustion;
}

export interface ISessionBudgetService {
	readonly _serviceBrand: undefined;

	createBudgetState(requestedBudget: SessionPlanBudget, allowedBudget?: SessionPlanBudget): SessionBudgetState;
	reserveStep(state: SessionBudgetState, step: SessionPlanStep): SessionBudgetReservationResult;
	finalizeStep(state: SessionBudgetState, step: SessionPlanStep, result: SessionActionResult): SessionBudgetState;
	canRetryStep(state: SessionBudgetState, stepId: string): boolean;
}

export const ISessionBudgetService = createDecorator<ISessionBudgetService>('sessionBudgetService');
