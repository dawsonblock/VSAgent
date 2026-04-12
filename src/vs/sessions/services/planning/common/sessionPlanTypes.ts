/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { NormalizedHostTarget, SessionAction, SessionActionKind, SessionActionScope, WritePatchAction } from '../../actions/common/sessionActionTypes.js';

export const enum SessionPlanStepKind {
	SearchWorkspace = 'searchWorkspace',
	ReadFile = 'readFile',
	WritePatch = 'writePatch',
	RunCommand = 'runCommand',
	GitStatus = 'gitStatus',
	GitDiff = 'gitDiff',
	OpenWorktree = 'openWorktree',
	Summarize = 'summarize',
	Compare = 'compare',
	Review = 'review',
}

export const enum SessionPlanStatus {
	Draft = 'draft',
	Validated = 'validated',
	Rejected = 'rejected',
	Executing = 'executing',
	Completed = 'completed',
	Stopped = 'stopped',
	Failed = 'failed',
}

export const enum SessionPlanRiskClass {
	ReadOnly = 'readOnly',
	LocalSafe = 'localSafe',
	RepoMutation = 'repoMutation',
	EnvironmentMutation = 'environmentMutation',
	Networked = 'networked',
	CredentialSensitive = 'credentialSensitive',
	RemoteHostSensitive = 'remoteHostSensitive',
}

export const enum SessionPlanCheckpointRequirement {
	None = 'none',
	Required = 'required',
}

export interface SessionPlanBudget {
	readonly maxSteps: number;
	readonly maxCommands: number;
	readonly maxFileWrites: number;
	readonly maxModifiedFiles: number;
	readonly maxWallClockMs: number;
	readonly maxFailures: number;
	readonly maxRetriesPerStep: number;
}

export interface SessionPlanScopeEstimate {
	readonly workspaceRoot?: URI;
	readonly projectRoot?: URI;
	readonly repositoryPath?: URI;
	readonly worktreeRoot?: URI;
	readonly cwd?: URI;
	readonly files: readonly URI[];
	readonly hostTarget?: NormalizedHostTarget;
}

export interface SessionPlanStepDraft {
	readonly id?: string;
	readonly kind: SessionPlanStepKind;
	readonly title: string;
	readonly description?: string;
	readonly dependsOn?: readonly string[];
	readonly action?: SessionAction;
	readonly estimatedScope?: SessionPlanScopeEstimate;
	readonly riskClasses?: readonly SessionPlanRiskClass[];
	readonly estimatedApprovalRequired?: boolean;
	readonly checkpointRequirement?: SessionPlanCheckpointRequirement;
}

export interface SessionPlanningRequest {
	readonly id?: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly intent: string;
	readonly summary?: string;
	readonly hostTarget: NormalizedHostTarget;
	readonly steps: readonly SessionPlanStepDraft[];
	readonly budget?: Partial<SessionPlanBudget>;
}

export interface SessionPlanStep {
	readonly id: string;
	readonly kind: SessionPlanStepKind;
	readonly title: string;
	readonly description?: string;
	readonly dependsOn: readonly string[];
	readonly action?: SessionAction;
	readonly estimatedScope: SessionPlanScopeEstimate;
	readonly riskClasses: readonly SessionPlanRiskClass[];
	readonly estimatedApprovalRequired: boolean;
	readonly checkpointRequirement: SessionPlanCheckpointRequirement;
}

export interface SessionPlan {
	readonly id: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly intent: string;
	readonly summary?: string;
	readonly hostTarget: NormalizedHostTarget;
	readonly steps: readonly SessionPlanStep[];
	readonly status: SessionPlanStatus;
	readonly budget: SessionPlanBudget;
	readonly createdAt: number;
	readonly updatedAt: number;
}

const executableStepKindToActionKind = new Map<SessionPlanStepKind, SessionActionKind>([
	[SessionPlanStepKind.SearchWorkspace, SessionActionKind.SearchWorkspace],
	[SessionPlanStepKind.ReadFile, SessionActionKind.ReadFile],
	[SessionPlanStepKind.WritePatch, SessionActionKind.WritePatch],
	[SessionPlanStepKind.RunCommand, SessionActionKind.RunCommand],
	[SessionPlanStepKind.GitStatus, SessionActionKind.GitStatus],
	[SessionPlanStepKind.GitDiff, SessionActionKind.GitDiff],
	[SessionPlanStepKind.OpenWorktree, SessionActionKind.OpenWorktree],
]);

const actionKindToPlanStepKind = new Map<SessionActionKind, SessionPlanStepKind>([
	[SessionActionKind.SearchWorkspace, SessionPlanStepKind.SearchWorkspace],
	[SessionActionKind.ReadFile, SessionPlanStepKind.ReadFile],
	[SessionActionKind.WritePatch, SessionPlanStepKind.WritePatch],
	[SessionActionKind.RunCommand, SessionPlanStepKind.RunCommand],
	[SessionActionKind.GitStatus, SessionPlanStepKind.GitStatus],
	[SessionActionKind.GitDiff, SessionPlanStepKind.GitDiff],
	[SessionActionKind.OpenWorktree, SessionPlanStepKind.OpenWorktree],
]);

const defaultSessionPlanBudget: SessionPlanBudget = {
	maxSteps: 12,
	maxCommands: 4,
	maxFileWrites: 20,
	maxModifiedFiles: 20,
	maxWallClockMs: 10 * 60 * 1000,
	maxFailures: 3,
	maxRetriesPerStep: 1,
};

export function getDefaultSessionPlanBudget(): SessionPlanBudget {
	return { ...defaultSessionPlanBudget };
}

export function mergeSessionPlanBudget(overrides?: Partial<SessionPlanBudget>): SessionPlanBudget {
	return {
		...defaultSessionPlanBudget,
		...overrides,
	};
}

export function estimateSessionPlanWritePatchWriteCount(action: WritePatchAction | undefined): number {
	if (!action) {
		return 0;
	}

	return action.operations?.length ?? action.files.length;
}

export function estimateSessionPlanWritePatchModifiedFiles(action: WritePatchAction | undefined): readonly URI[] {
	if (!action) {
		return [];
	}

	const resources = new Map<string, URI>();
	for (const resource of action.files) {
		resources.set(resource.toString(), resource);
	}
	for (const operation of action.operations ?? []) {
		resources.set(operation.resource.toString(), operation.resource);
	}

	return [...resources.values()];
}

export function isExecutableSessionPlanStepKind(kind: SessionPlanStepKind): boolean {
	return executableStepKindToActionKind.has(kind);
}

export function isSessionPlanStepKindSupportedByExecutor(kind: SessionPlanStepKind): boolean {
	return kind !== SessionPlanStepKind.OpenWorktree;
}

export function sessionPlanStepKindToActionKind(kind: SessionPlanStepKind): SessionActionKind | undefined {
	return executableStepKindToActionKind.get(kind);
}

export function sessionActionKindToPlanStepKind(kind: SessionActionKind): SessionPlanStepKind {
	const stepKind = actionKindToPlanStepKind.get(kind);
	if (!stepKind) {
		throw new Error(`Unsupported session action kind '${kind}'.`);
	}

	return stepKind;
}

export function isSessionPlanMutationRiskClass(riskClass: SessionPlanRiskClass): boolean {
	switch (riskClass) {
		case SessionPlanRiskClass.RepoMutation:
		case SessionPlanRiskClass.EnvironmentMutation:
		case SessionPlanRiskClass.Networked:
		case SessionPlanRiskClass.CredentialSensitive:
			return true;
		default:
			return false;
	}
}

export function createSessionPlanScopeEstimate(scope: SessionActionScope | undefined, hostTarget?: NormalizedHostTarget): SessionPlanScopeEstimate {
	const scopeHostTarget = scope?.hostTarget?.kind && scope.hostTarget.providerId
		? {
			kind: scope.hostTarget.kind,
			providerId: scope.hostTarget.providerId,
			authority: scope.hostTarget.authority,
		}
		: undefined;

	return {
		workspaceRoot: scope?.workspaceRoot,
		projectRoot: scope?.projectRoot,
		repositoryPath: scope?.repositoryPath,
		worktreeRoot: scope?.worktreeRoot,
		cwd: scope?.cwd,
		files: scope?.files ?? [],
		hostTarget: hostTarget ?? scopeHostTarget,
	};
}

export function deriveSessionPlanScopeEstimateFromAction(action: SessionAction | undefined, hostTarget?: NormalizedHostTarget): SessionPlanScopeEstimate {
	if (!action) {
		return {
			files: [],
			hostTarget,
		};
	}

	const scope = createSessionPlanScopeEstimate(action.scope, hostTarget);
	const files = new Map<string, URI>(scope.files.map(resource => [resource.toString(), resource]));

	switch (action.kind) {
		case SessionActionKind.ReadFile:
			files.set(action.resource.toString(), action.resource);
			break;
		case SessionActionKind.WritePatch:
			for (const resource of estimateSessionPlanWritePatchModifiedFiles(action)) {
				files.set(resource.toString(), resource);
			}
			break;
		case SessionActionKind.RunCommand:
			return {
				...scope,
				cwd: action.cwd ?? scope.cwd,
				files: [...files.values()],
			};
		case SessionActionKind.GitStatus:
		case SessionActionKind.GitDiff:
			return {
				...scope,
				repositoryPath: action.repository,
				files: [...files.values()],
			};
		case SessionActionKind.OpenWorktree:
			return {
				...scope,
				repositoryPath: action.repository,
				worktreeRoot: action.worktreePath ?? scope.worktreeRoot,
				files: [...files.values()],
			};
	}

	return {
		...scope,
		files: [...files.values()],
	};
}
