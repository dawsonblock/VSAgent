/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export const enum SessionActionKind {
	SearchWorkspace = 'searchWorkspace',
	ReadFile = 'readFile',
	WritePatch = 'writePatch',
	RunCommand = 'runCommand',
	GitStatus = 'gitStatus',
	GitDiff = 'gitDiff',
	OpenWorktree = 'openWorktree',
}

export const enum SessionActionRequestSource {
	User = 'user',
	Session = 'session',
	System = 'system',
}

export const enum SessionActionStatus {
	Denied = 'denied',
	ApprovalRequired = 'approvalRequired',
	Approved = 'approved',
	Executed = 'executed',
	Failed = 'failed',
}

export const enum SessionActionDenialReason {
	ProviderCapabilityMissing = 'providerCapabilityMissing',
	PolicyDenied = 'policyDenied',
	ApprovalDenied = 'approvalDenied',
	InvalidPathScope = 'invalidPathScope',
	RootEscape = 'rootEscape',
	SecretPath = 'secretPath',
	WorktreeMismatch = 'worktreeMismatch',
	HostTargetMismatch = 'hostTargetMismatch',
	UnsupportedAction = 'unsupportedAction',
	ExecutionFailed = 'executionFailed',
}

export const enum ApprovalRequirement {
	None = 'none',
	Required = 'required',
}

export const enum SessionHostKind {
	Local = 'local',
	Remote = 'remote',
	Copilot = 'copilot',
	Unknown = 'unknown',
}

export const enum SessionCommandLaunchKind {
	Command = 'command',
	Task = 'task',
	Terminal = 'terminal',
}

export interface NormalizedPathScope {
	readonly path: URI;
	readonly isDirectory: boolean;
	readonly label?: string;
}

export interface NormalizedHostTarget {
	readonly kind: SessionHostKind;
	readonly providerId: string;
	readonly authority?: string;
}

export interface SessionActionScope {
	readonly workspaceRoot?: URI;
	readonly projectRoot?: URI;
	readonly repositoryPath?: URI;
	readonly worktreeRoot?: URI;
	readonly cwd?: URI;
	readonly files?: readonly URI[];
	readonly hostTarget?: Readonly<Partial<NormalizedHostTarget>>;
}

export interface SessionActionExecutionContext {
	readonly sessionId: string;
	readonly providerId: string;
	readonly sessionResource: URI;
	readonly workspaceRoot?: URI;
	readonly projectRoot?: URI;
	readonly repositoryPath?: URI;
	readonly worktreeRoot?: URI;
	readonly hostTarget: NormalizedHostTarget;
	readonly advisorySources: readonly string[];
	readonly permissionMode?: string;
	readonly sessionType?: string;
}

export interface SessionActionExecutionTrace {
	readonly planId: string;
	readonly planStepId: string;
	readonly checkpointId?: string;
}

interface SessionActionBase {
	readonly id?: string;
	readonly kind: SessionActionKind;
	readonly requestedBy: SessionActionRequestSource;
	readonly summary?: string;
	readonly advisorySources?: readonly string[];
	readonly trace?: SessionActionExecutionTrace;
	readonly scope?: SessionActionScope;
}

export interface SearchWorkspaceAction extends SessionActionBase {
	readonly kind: SessionActionKind.SearchWorkspace;
	readonly query: string;
	readonly includePattern?: string;
	readonly isRegexp?: boolean;
	readonly maxResults?: number;
}

export interface ReadFileAction extends SessionActionBase {
	readonly kind: SessionActionKind.ReadFile;
	readonly resource: URI;
	readonly startLine?: number;
	readonly endLine?: number;
}

export interface WritePatchAction extends SessionActionBase {
	readonly kind: SessionActionKind.WritePatch;
	readonly patch: string;
	readonly files: readonly URI[];
	readonly operations?: readonly {
		readonly resource: URI;
		readonly contents?: string;
		readonly delete?: boolean;
		readonly useTrash?: boolean;
	}[];
}

export interface RunCommandAction extends SessionActionBase {
	readonly kind: SessionActionKind.RunCommand;
	readonly command: string;
	readonly args?: readonly unknown[];
	readonly cwd?: URI;
	readonly launchKind?: SessionCommandLaunchKind;
	readonly taskLabel?: string;
}

export interface GitStatusAction extends SessionActionBase {
	readonly kind: SessionActionKind.GitStatus;
	readonly repository: URI;
}

export interface GitDiffAction extends SessionActionBase {
	readonly kind: SessionActionKind.GitDiff;
	readonly repository: URI;
	readonly ref?: string;
}

export interface OpenWorktreeAction extends SessionActionBase {
	readonly kind: SessionActionKind.OpenWorktree;
	readonly repository: URI;
	readonly worktreePath?: URI;
	readonly branch?: string;
}

export type SessionAction =
	| SearchWorkspaceAction
	| ReadFileAction
	| WritePatchAction
	| RunCommandAction
	| GitStatusAction
	| GitDiffAction
	| OpenWorktreeAction;

type SessionActionValue = object | string | number | boolean | null | undefined;

export interface SessionActionSearchMatch {
	readonly resource: URI;
	readonly lineNumber: number;
	readonly lineNumbers: readonly number[];
	readonly preview: string;
	readonly matchCount: number;
}

export const enum SessionWriteOperationStatus {
	Created = 'created',
	Updated = 'updated',
	Deleted = 'deleted',
	Failed = 'failed',
	Skipped = 'skipped',
}

export interface SessionWriteOperationResult {
	readonly resource: URI;
	readonly status: SessionWriteOperationStatus;
	readonly bytesWritten?: number;
	readonly error?: string;
}

export interface SessionGitChangeSummary {
	readonly resource: URI;
	readonly insertions: number;
	readonly deletions: number;
}

interface SessionActionResultBase {
	readonly actionId: string;
	readonly kind: SessionActionKind;
	readonly status: SessionActionStatus;
	readonly receiptId?: string;
	readonly denialReason?: SessionActionDenialReason;
	readonly denialMessage?: string;
	readonly approvedScope?: SessionActionScope;
	readonly advisorySources: readonly string[];
	readonly summary?: string;
}

export interface SearchWorkspaceActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.SearchWorkspace;
	readonly resultCount: number;
	readonly matchCount: number;
	readonly limitHit: boolean;
	readonly matches: readonly SessionActionSearchMatch[];
}

export interface ReadFileActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.ReadFile;
	readonly resource: URI;
	readonly contents?: string;
	readonly encoding?: string;
	readonly byteSize?: number;
	readonly lineCount?: number;
	readonly isPartial?: boolean;
}

export interface WritePatchActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.WritePatch;
	readonly filesTouched: readonly URI[];
	readonly applied: boolean;
	readonly operationCount: number;
	readonly operations: readonly SessionWriteOperationResult[];
}

export interface RunCommandActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.RunCommand;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: URI;
	readonly commandLine: string;
	readonly exitCode?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly value?: SessionActionValue;
}

export interface GitStatusActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.GitStatus;
	readonly repository: URI;
	readonly operation: string;
	readonly branch?: string;
	readonly filesChanged?: number;
	readonly mergeChanges?: number;
	readonly indexChanges?: number;
	readonly workingTreeChanges?: number;
	readonly untrackedChanges?: number;
	readonly hasChanges?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly value?: SessionActionValue;
}

export interface GitDiffActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.GitDiff;
	readonly repository: URI;
	readonly operation: string;
	readonly ref?: string;
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	readonly changes?: readonly SessionGitChangeSummary[];
	readonly stdout?: string;
	readonly stderr?: string;
	readonly value?: SessionActionValue;
}

export interface OpenWorktreeActionResult extends SessionActionResultBase {
	readonly kind: SessionActionKind.OpenWorktree;
	readonly repository: URI;
	readonly operation: string;
	readonly worktreePath?: URI;
	readonly branch?: string;
	readonly opened?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly value?: SessionActionValue;
}

export type SessionActionResult =
	| SearchWorkspaceActionResult
	| ReadFileActionResult
	| WritePatchActionResult
	| RunCommandActionResult
	| GitStatusActionResult
	| GitDiffActionResult
	| OpenWorktreeActionResult;
