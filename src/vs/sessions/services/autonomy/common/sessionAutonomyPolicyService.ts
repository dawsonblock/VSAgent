/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProviderCapabilitySet, SessionPolicySnapshot } from '../../actions/common/sessionActionPolicy.js';
import { SessionHostKind } from '../../actions/common/sessionActionTypes.js';
import { SessionPlanRiskClass, SessionPlanStepKind } from '../../planning/common/sessionPlanTypes.js';
import { AllowedRiskProfile, SessionAutonomyMode } from './sessionAutonomyTypes.js';

export interface SessionAutonomyPolicyRequest {
	readonly mode: SessionAutonomyMode;
	readonly providerCapabilities: ProviderCapabilitySet;
	readonly policy: SessionPolicySnapshot;
	readonly hostKind: SessionHostKind;
}

export interface SessionAutonomyPolicyDecision {
	readonly mode: SessionAutonomyMode;
	readonly allowedProfile: AllowedRiskProfile;
	readonly blockedStepKinds: readonly SessionPlanStepKind[];
	readonly blockedRiskClasses: readonly SessionPlanRiskClass[];
	readonly reasons: readonly string[];
}

export interface ISessionAutonomyPolicyService {
	readonly _serviceBrand: undefined;

	resolveProfile(request: SessionAutonomyPolicyRequest): SessionAutonomyPolicyDecision;
}

export const ISessionAutonomyPolicyService = createDecorator<ISessionAutonomyPolicyService>('sessionAutonomyPolicyService');
