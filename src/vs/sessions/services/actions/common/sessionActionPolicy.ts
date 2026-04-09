/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ISessionsProviderCapabilities } from '../../sessions/common/sessionsProvider.js';
import { ApprovalRequirement, SessionAction, SessionActionDenialReason, SessionActionExecutionContext, SessionActionScope, SessionHostKind } from './sessionActionTypes.js';
import { NormalizedSessionActionScope } from './sessionActionScope.js';

export type ProviderCapabilitySet = ISessionsProviderCapabilities;

export interface SessionPolicySnapshot {
	readonly allowedRoots: readonly URI[];
	readonly deniedRoots: readonly URI[];
	readonly secretLikePathSegments: readonly string[];
	readonly commandAllowPatterns: readonly RegExp[];
	readonly commandDenyPatterns: readonly RegExp[];
	readonly allowWorkspaceReads: boolean;
	readonly allowWorkspaceWrites: boolean;
	readonly allowCommands: boolean;
	readonly allowGitMutation: boolean;
	readonly allowWorktreeMutation: boolean;
	readonly approvalMode: 'default' | 'always';
}

export interface ScopeConstraint {
	readonly kind: 'workspaceRoot' | 'projectRoot' | 'repositoryPath' | 'worktreeRoot' | 'cwd' | 'files';
	readonly paths: readonly URI[];
}

export const enum SessionActionPolicyMode {
	Allow = 'allow',
	Deny = 'deny',
	RequireApproval = 'requireApproval',
}

export const enum CommandRiskClass {
	None = 'none',
	ReadOnly = 'readOnly',
	WorkspaceWrite = 'workspaceWrite',
	ProcessExecution = 'processExecution',
	GitMutation = 'gitMutation',
}

export interface PolicyDenialMetadata {
	readonly reason: SessionActionDenialReason;
	readonly message?: string;
	readonly blockedPath?: URI;
	readonly blockedCommand?: string;
	readonly blockedHostKind?: SessionHostKind;
}

export interface SessionActionPolicyInput {
	readonly action: SessionAction;
	readonly normalizedScope: NormalizedSessionActionScope;
	readonly providerCapabilities: ProviderCapabilitySet;
	readonly executionContext: SessionActionExecutionContext;
	readonly policy: SessionPolicySnapshot;
	readonly requestedPermissionMode?: string;
}

export interface SessionActionPolicyDecision {
	readonly mode: SessionActionPolicyMode;
	readonly denialReason?: SessionActionDenialReason;
	readonly approvalRequirement: ApprovalRequirement;
	readonly approvedScope: SessionActionScope;
	readonly commandRiskClass: CommandRiskClass;
	readonly scopeConstraints: readonly ScopeConstraint[];
	readonly denialMetadata?: PolicyDenialMetadata;
}
