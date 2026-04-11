/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionActionReceipt } from '../../actions/common/sessionActionReceipts.js';
import { SessionActionResult } from '../../actions/common/sessionActionTypes.js';
import { AutonomyContinuationDecision, AutonomyStopReason } from '../../autonomy/common/sessionAutonomyTypes.js';
import { SessionBudgetState } from '../../autonomy/common/sessionBudgetService.js';
import { SessionPlan, SessionPlanStep } from '../../planning/common/sessionPlanTypes.js';
import { SessionCheckpoint } from '../../checkpoints/common/sessionCheckpointTypes.js';

export interface SessionEvaluationIssue {
	readonly kind: 'scopeDrift' | 'noProgress' | 'failure' | 'budget' | 'policy' | 'capability';
	readonly message: string;
}

export interface SessionEvaluationRequest {
	readonly plan: SessionPlan;
	readonly step: SessionPlanStep;
	readonly result: SessionActionResult;
	readonly receipt?: SessionActionReceipt;
	readonly checkpoint?: SessionCheckpoint;
	readonly budgetState: SessionBudgetState;
}

export interface SessionEvaluationResult {
	readonly decision: AutonomyContinuationDecision;
	readonly stopReason?: AutonomyStopReason;
	readonly issues: readonly SessionEvaluationIssue[];
	readonly scopeDrift: boolean;
	readonly madeProgress: boolean;
	readonly summary: string;
}
