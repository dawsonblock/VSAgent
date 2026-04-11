/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionActionResult } from '../../actions/common/sessionActionTypes.js';
import { ISession } from '../../sessions/common/session.js';
import { SessionBudgetState } from './sessionBudgetService.js';
import { AutonomyContinuationDecision, AutonomyStopReason, SessionAutonomyMode } from './sessionAutonomyTypes.js';
import { SessionPlan, SessionPlanStatus } from '../../planning/common/sessionPlanTypes.js';
import { SessionEvaluationResult } from '../../evaluation/common/sessionEvaluationTypes.js';

export interface SessionAutonomousExecutionRequest {
	readonly session: ISession;
	readonly plan: SessionPlan;
	readonly mode: SessionAutonomyMode;
	readonly requestedPermissionMode?: string;
}

export interface SessionAutonomousExecutionIssue {
	readonly stepId?: string;
	readonly message: string;
}

export interface SessionAutonomousStepResult {
	readonly stepId: string;
	readonly attempts: number;
	readonly checkpointId?: string;
	readonly receiptId?: string;
	readonly result: SessionActionResult;
	readonly evaluation: SessionEvaluationResult;
}

export interface SessionAutonomousExecutionResult {
	readonly planId: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly status: SessionPlanStatus;
	readonly decision: AutonomyContinuationDecision;
	readonly stopReason?: AutonomyStopReason;
	readonly stepResults: readonly SessionAutonomousStepResult[];
	readonly budgetState: SessionBudgetState;
	readonly issues: readonly SessionAutonomousExecutionIssue[];
	readonly reasons: readonly string[];
}

export interface ISessionAutonomousExecutionService {
	readonly _serviceBrand: undefined;

	executePlan(request: SessionAutonomousExecutionRequest): Promise<SessionAutonomousExecutionResult>;
}

export const ISessionAutonomousExecutionService = createDecorator<ISessionAutonomousExecutionService>('sessionAutonomousExecutionService');
