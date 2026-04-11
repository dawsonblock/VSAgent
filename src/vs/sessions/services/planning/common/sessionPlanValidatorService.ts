/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProviderCapabilitySet, SessionPolicySnapshot } from '../../actions/common/sessionActionPolicy.js';
import { SessionActionExecutionContext } from '../../actions/common/sessionActionTypes.js';
import { SessionPlan } from './sessionPlanTypes.js';

export const enum SessionPlanValidationIssueCode {
	MissingAction = 'missingAction',
	NonExecutableAction = 'nonExecutableAction',
	MismatchedActionKind = 'mismatchedActionKind',
	InvalidDependency = 'invalidDependency',
	DependencyCycle = 'dependencyCycle',
	BudgetExceeded = 'budgetExceeded',
	ScopeDenied = 'scopeDenied',
	PolicyDenied = 'policyDenied',
	MissingCheckpoint = 'missingCheckpoint',
	MissingApprovalEstimate = 'missingApprovalEstimate',
}

export interface SessionPlanValidationIssue {
	readonly code: SessionPlanValidationIssueCode;
	readonly message: string;
	readonly stepId?: string;
}

export interface SessionPlanValidationContext {
	readonly executionContext: SessionActionExecutionContext;
	readonly providerCapabilities: ProviderCapabilitySet;
	readonly requestedPermissionMode?: string;
	readonly policy?: SessionPolicySnapshot;
}

export interface SessionPlanValidationResult {
	readonly valid: boolean;
	readonly issues: readonly SessionPlanValidationIssue[];
}

export interface ISessionPlanValidatorService {
	readonly _serviceBrand: undefined;

	validatePlan(plan: SessionPlan, context: SessionPlanValidationContext): Promise<SessionPlanValidationResult>;
}

export const ISessionPlanValidatorService = createDecorator<ISessionPlanValidatorService>('sessionPlanValidatorService');
