/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionPlanBudget, SessionPlanRiskClass, SessionPlanStepKind } from '../../planning/common/sessionPlanTypes.js';

export const enum SessionAutonomyMode {
	ReviewOnly = 'review_only',
	SafeAutopilot = 'safe_autopilot',
	RepoRepair = 'repo_repair',
	SupervisedExtended = 'supervised_extended',
}

export interface AllowedRiskProfile {
	readonly stepKinds: readonly SessionPlanStepKind[];
	readonly riskClasses: readonly SessionPlanRiskClass[];
	readonly budget: SessionPlanBudget;
}

export const enum AutonomyContinuationDecision {
	Continue = 'continue',
	Stop = 'stop',
	Replan = 'replan',
}

export const enum AutonomyStopReason {
	Completed = 'completed',
	BudgetExceeded = 'budgetExceeded',
	PolicyDenied = 'policyDenied',
	CapabilityDenied = 'capabilityDenied',
	ScopeDrift = 'scopeDrift',
	RepeatedFailure = 'repeatedFailure',
	ApprovalRequired = 'approvalRequired',
	ValidationFailed = 'validationFailed',
	Interrupted = 'interrupted',
}
