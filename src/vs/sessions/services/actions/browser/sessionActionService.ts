/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PolicyDenialMetadata, ProviderCapabilitySet, SessionActionPolicyMode } from '../common/sessionActionPolicy.js';
import { ISessionActionReceiptService, SessionActionReceipt, SessionActionReceiptScopeSummary, SessionActionReceiptStatus } from '../common/sessionActionReceipts.js';
import { ISessionActionScopeService, NormalizedSessionActionScope } from '../common/sessionActionScope.js';
import { ISessionActionService, ISessionActionActiveChangeEvent, ISessionActionDenialEvent } from '../common/sessionActionService.js';
import { GitDiffAction, GitStatusAction, OpenWorktreeAction, ReadFileAction, RunCommandAction, SessionAction, SessionActionDenialReason, SessionActionExecutionContext, SessionActionKind, SessionActionResult, SessionActionStatus, SessionHostKind, WritePatchAction } from '../common/sessionActionTypes.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import { ISession } from '../../sessions/common/session.js';
import { ISessionActionApprovalService } from './sessionActionApprovalService.js';
import { ISessionActionExecutorBridge } from './sessionActionExecutorBridge.js';
import { ISessionActionPolicyService } from './sessionActionPolicyService.js';

export class SessionActionService extends Disposable implements ISessionActionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveAction = this._register(new Emitter<ISessionActionActiveChangeEvent>());
	readonly onDidChangeActiveAction = this._onDidChangeActiveAction.event;

	private readonly _onDidDenyAction = this._register(new Emitter<ISessionActionDenialEvent>());
	readonly onDidDenyAction = this._onDidDenyAction.event;

	readonly onDidAppendReceipt = this._receiptService.onDidAppendReceipt;

	constructor(
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@ISessionActionScopeService private readonly _scopeService: ISessionActionScopeService,
		@ISessionActionPolicyService private readonly _policyService: ISessionActionPolicyService,
		@ISessionActionApprovalService private readonly _approvalService: ISessionActionApprovalService,
		@ISessionActionExecutorBridge private readonly _executorBridge: ISessionActionExecutorBridge,
		@ISessionActionReceiptService private readonly _receiptService: ISessionActionReceiptService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getReceiptsForSession(sessionId: string) {
		return this._receiptService.getReceiptsForSession(sessionId);
	}

	async submitAction(sessionId: string, providerId: string, action: SessionAction): Promise<SessionActionResult> {
		return this._submitAction(sessionId, providerId, action, true);
	}

	async approveAction(sessionId: string, providerId: string, action: SessionAction): Promise<SessionActionResult> {
		return this._submitAction(sessionId, providerId, action, false);
	}

	private async _submitAction(sessionId: string, providerId: string, action: SessionAction, execute: boolean): Promise<SessionActionResult> {
		const normalizedAction = this._normalizeAction(action);
		const requestedAt = Date.now();
		let session: ISession | undefined;
		let executionContext: SessionActionExecutionContext | undefined;
		let normalizedScope: NormalizedSessionActionScope | undefined;
		let approval: SessionActionReceipt['approval'] | undefined;
		let decidedAt: number | undefined;
		this._onDidChangeActiveAction.fire({ sessionId, actionId: normalizedAction.id!, active: true });

		try {
			const provider = this._sessionsProvidersService.getProvider(providerId);
			if (!provider) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ProviderCapabilityMissing, 'No Sessions provider was found for this action.', undefined, undefined, undefined, undefined, undefined, requestedAt);
			}

			session = provider.getSessions().find(candidate => candidate.sessionId === sessionId);
			if (!session) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.PolicyDenied, 'No active session was found for this action.', undefined, undefined, undefined, undefined, undefined, requestedAt);
			}

			const capabilities = this._sessionsProvidersService.getProviderCapabilities(providerId, sessionId);
			if (!capabilities) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ProviderCapabilityMissing, 'The Sessions provider did not report a capability set.', session, undefined, undefined, undefined, undefined, requestedAt);
			}

			const capabilityDenial = this._sessionsProvidersService.getActionCapabilityDenial(providerId, normalizedAction.kind, sessionId);
			if (capabilityDenial) {
				return this._deny(sessionId, providerId, normalizedAction, capabilityDenial.reason, capabilityDenial.message, session, undefined, undefined, undefined, undefined, requestedAt);
			}

			executionContext = this._createExecutionContext(session, capabilities);
			const scopeResolution = this._scopeService.resolveScope(normalizedAction, executionContext, capabilities);
			if (!scopeResolution.scope || scopeResolution.denialReason) {
				return this._deny(sessionId, providerId, normalizedAction, scopeResolution.denialReason ?? SessionActionDenialReason.InvalidPathScope, scopeResolution.message ?? 'The action scope could not be normalized.', session, executionContext, undefined, undefined, undefined, requestedAt);
			}
			normalizedScope = scopeResolution.scope;

			const policySnapshot = await this._policyService.getPolicySnapshot(executionContext, this._collectPolicyRoots(executionContext));
			const policyDecision = this._policyService.evaluate({
				action: normalizedAction,
				normalizedScope,
				providerCapabilities: capabilities,
				executionContext,
				policy: policySnapshot,
				requestedPermissionMode: executionContext.permissionMode,
			});

			if (policyDecision.mode === SessionActionPolicyMode.Deny) {
				return this._deny(sessionId, providerId, normalizedAction, policyDecision.denialReason ?? SessionActionDenialReason.PolicyDenied, policyDecision.denialMetadata?.message ?? 'The Sessions action policy denied this request.', session, executionContext, normalizedScope, policyDecision.denialMetadata, undefined, requestedAt);
			}

			const approvalDecision = await this._approvalService.requestApproval(normalizedAction, policyDecision, capabilities);
			approval = approvalDecision.approval;
			if (!approvalDecision.approved) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ApprovalDenied, approvalDecision.approval.summary, session, executionContext, normalizedScope, undefined, approvalDecision.approval, requestedAt);
			}

			decidedAt = Date.now();

			if (!execute) {
				const approvedResult = this._createApprovedResult(normalizedAction, approvalDecision.approval);
				const receipt = this._createReceipt({
					action: normalizedAction,
					sessionId,
					providerId,
					executionContext,
					requestedScope: this._toScopeSummary(normalizedScope, executionContext.hostTarget),
					approvedScope: this._toScopeSummary(normalizedScope, executionContext.hostTarget),
					status: SessionActionReceiptStatus.Approved,
					requestedAt,
					decidedAt,
					completedAt: decidedAt,
					approval: approvalDecision.approval,
					executionResult: approvedResult,
				});
				this._receiptService.appendReceipt(receipt);

				return {
					...approvedResult,
					receiptId: receipt.id,
					approvedScope: policyDecision.approvedScope,
				};
			}

			if (!this._executorBridge.supports(normalizedAction.kind)) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.UnsupportedAction, `Action kind '${normalizedAction.kind}' is not yet mediated by the Sessions executor bridge.`, session, executionContext, normalizedScope, undefined, approvalDecision.approval, requestedAt, decidedAt, decidedAt);
			}

			const executionResult = await this._executorBridge.execute(normalizedAction, normalizedScope);
			const completedAt = Date.now();
			const receipt = this._createReceipt({
				action: normalizedAction,
				sessionId,
				providerId,
				executionContext,
				requestedScope: this._toScopeSummary(normalizedScope, executionContext.hostTarget),
				approvedScope: this._toScopeSummary(normalizedScope, executionContext.hostTarget),
				status: executionResult.status === SessionActionStatus.Executed ? SessionActionReceiptStatus.Executed : SessionActionReceiptStatus.Failed,
				requestedAt,
				decidedAt,
				completedAt,
				approval: approvalDecision.approval,
				executionResult,
			});
			this._receiptService.appendReceipt(receipt);

			return {
				...executionResult,
				receiptId: receipt.id,
				approvedScope: policyDecision.approvedScope,
			};
		} catch (error) {
			this._logService.error('[SessionActionService] submitAction failed', error);
			return this._fail(sessionId, providerId, normalizedAction, error instanceof Error ? error.message : 'An unknown error occurred while executing the Sessions action.', session, executionContext, normalizedScope, approval, requestedAt, decidedAt);
		} finally {
			this._onDidChangeActiveAction.fire({ sessionId, actionId: normalizedAction.id!, active: false });
		}
	}

	private _normalizeAction(action: SessionAction): SessionAction {
		if (action.id) {
			return action;
		}

		return {
			...action,
			id: generateUuid(),
		};
	}

	private _createExecutionContext(session: ISession, capabilities: ProviderCapabilitySet): SessionActionExecutionContext {
		const repository = session.workspace.get()?.repositories[0];
		const repositoryPath = repository?.uri;
		const worktreeRoot = repository?.workingDirectory;
		const projectRoot = worktreeRoot ?? repositoryPath;
		return {
			sessionId: session.sessionId,
			providerId: session.providerId,
			sessionResource: session.resource,
			workspaceRoot: repositoryPath,
			projectRoot,
			repositoryPath,
			worktreeRoot,
			hostTarget: {
				kind: capabilities.hostKind,
				providerId: session.providerId,
				authority: this._sessionsProvidersService.getProviderMetadata(session.providerId, session.sessionId)?.remoteAddress,
			},
			advisorySources: [],
			sessionType: session.sessionType,
		};
	}

	private _collectPolicyRoots(executionContext: SessionActionExecutionContext): URI[] {
		const roots = [
			executionContext.workspaceRoot,
			executionContext.projectRoot,
			executionContext.repositoryPath,
			executionContext.worktreeRoot,
		].filter((value): value is URI => !!value);
		return roots;
	}

	private _deny(sessionId: string, providerId: string, action: SessionAction, denialReason: SessionActionDenialReason, message: string, session: ISession | undefined, executionContext?: SessionActionExecutionContext, normalizedScope?: NormalizedSessionActionScope, denialMetadata?: PolicyDenialMetadata, approval?: SessionActionReceipt['approval'], requestedAt?: number, decidedAt?: number, completedAt?: number): SessionActionResult {
		const repository = session?.workspace.get()?.repositories[0];
		const context = executionContext ?? {
			sessionId,
			providerId,
			sessionResource: session?.resource ?? URI.parse(`session-action:/${sessionId}`),
			workspaceRoot: repository?.uri,
			projectRoot: repository?.workingDirectory ?? repository?.uri,
			repositoryPath: repository?.uri,
			worktreeRoot: repository?.workingDirectory,
			hostTarget: {
				kind: this._sessionsProvidersService.resolveProviderHostKind(providerId, sessionId) ?? SessionHostKind.Unknown,
				providerId,
				authority: this._sessionsProvidersService.getProviderMetadata(providerId, sessionId)?.remoteAddress,
			},
			advisorySources: action.advisorySources ?? [],
		};

		const scopeSummary = this._toScopeSummary(normalizedScope, context.hostTarget);
		const deniedResult = this._createDeniedResult(action, denialReason, message, '', action.id ?? generateUuid());
		const receiptRequestedAt = requestedAt ?? Date.now();
		const receiptDecidedAt = decidedAt ?? Date.now();
		const receiptCompletedAt = completedAt ?? receiptDecidedAt;
		const receipt = this._createReceipt({
			action,
			sessionId,
			providerId,
			executionContext: context,
			requestedScope: scopeSummary,
			approvedScope: scopeSummary,
			status: SessionActionReceiptStatus.Denied,
			requestedAt: receiptRequestedAt,
			decidedAt: receiptDecidedAt,
			completedAt: receiptCompletedAt,
			approval,
			executionResult: deniedResult,
			denial: denialMetadata,
		});
		this._receiptService.appendReceipt(receipt);
		this._onDidDenyAction.fire({ sessionId, providerId, actionId: action.id ?? receipt.actionId, denialReason, message });

		return {
			...deniedResult,
			receiptId: receipt.id,
			actionId: action.id ?? receipt.actionId,
		};
	}

	private _fail(sessionId: string, providerId: string, action: SessionAction, message: string, session: ISession | undefined, executionContext?: SessionActionExecutionContext, normalizedScope?: NormalizedSessionActionScope, approval?: SessionActionReceipt['approval'], requestedAt?: number, decidedAt?: number): SessionActionResult {
		const repository = session?.workspace.get()?.repositories[0];
		const context = executionContext ?? {
			sessionId,
			providerId,
			sessionResource: session?.resource ?? URI.parse(`session-action:/${sessionId}`),
			workspaceRoot: repository?.uri,
			projectRoot: repository?.workingDirectory ?? repository?.uri,
			repositoryPath: repository?.uri,
			worktreeRoot: repository?.workingDirectory,
			hostTarget: {
				kind: this._sessionsProvidersService.resolveProviderHostKind(providerId, sessionId) ?? SessionHostKind.Unknown,
				providerId,
				authority: this._sessionsProvidersService.getProviderMetadata(providerId, sessionId)?.remoteAddress,
			},
			advisorySources: action.advisorySources ?? [],
		};

		const scopeSummary = this._toScopeSummary(normalizedScope, context.hostTarget);
		const failedResult = this._createFailedResult(action, message, action.id ?? generateUuid());
		const receiptRequestedAt = requestedAt ?? Date.now();
		const receiptDecidedAt = decidedAt ?? Date.now();
		const receiptCompletedAt = Date.now();
		const receipt = this._createReceipt({
			action,
			sessionId,
			providerId,
			executionContext: context,
			requestedScope: scopeSummary,
			approvedScope: scopeSummary,
			status: SessionActionReceiptStatus.Failed,
			requestedAt: receiptRequestedAt,
			decidedAt: receiptDecidedAt,
			completedAt: receiptCompletedAt,
			approval,
			executionResult: failedResult,
		});
		this._receiptService.appendReceipt(receipt);

		return {
			...failedResult,
			receiptId: receipt.id,
			actionId: action.id ?? receipt.actionId,
		};
	}

	private _createReceipt(options: {
		action: SessionAction;
		sessionId: string;
		providerId: string;
		executionContext: SessionActionExecutionContext;
		requestedScope: SessionActionReceiptScopeSummary;
		approvedScope: SessionActionReceiptScopeSummary;
		status: SessionActionReceiptStatus;
		requestedAt: number;
		decidedAt: number;
		completedAt: number;
		executionResult: SessionActionResult;
		approval?: SessionActionReceipt['approval'];
		denial?: SessionActionReceipt['denial'];
	}): SessionActionReceipt {
		const executionResult = options.executionResult;
		return {
			id: generateUuid(),
			sessionId: options.sessionId,
			providerId: options.providerId,
			hostKind: options.executionContext.hostTarget.kind,
			hostTarget: options.executionContext.hostTarget,
			actionId: options.action.id ?? executionResult.actionId,
			actionKind: options.action.kind,
			query: this._getQuery(options.action),
			includePattern: this._getIncludePattern(options.action),
			isRegexp: this._getIsRegexp(options.action),
			maxResults: this._getMaxResults(options.action),
			resource: this._getResource(options.action, executionResult),
			startLine: this._getStartLine(options.action),
			endLine: this._getEndLine(options.action),
			ref: this._getRef(options.action),
			requestedScope: options.requestedScope,
			approvedScope: options.approvedScope,
			requestedAt: options.requestedAt,
			decidedAt: options.decidedAt,
			completedAt: options.completedAt,
			status: options.status,
			filesTouched: this._getFilesTouched(executionResult, options.approvedScope.files),
			cwd: options.approvedScope.cwd,
			repositoryPath: this._getRepositoryPath(options.action, options.approvedScope, executionResult),
			worktreePath: this._getWorktreePath(options.action, options.approvedScope, executionResult),
			command: this._getCommand(options.action),
			args: this._getCommandArgs(options.action),
			branch: this._getBranch(options.action, executionResult),
			stdout: this._getStdout(executionResult),
			stderr: this._getStderr(executionResult),
			approvalSummary: options.approval?.summary,
			approvalFingerprint: options.approval?.fingerprint,
			denialReason: executionResult.denialReason ?? options.denial?.reason,
			approval: options.approval,
			denial: options.denial,
			advisorySources: executionResult.advisorySources,
			executionSummary: executionResult.summary,
			error: executionResult.status === SessionActionStatus.Failed || executionResult.status === SessionActionStatus.Denied
				? {
					name: executionResult.denialReason ?? executionResult.status,
					message: executionResult.denialMessage ?? executionResult.summary ?? 'The Sessions action did not complete successfully.',
				}
				: undefined,
		};
	}

	private _createApprovedResult(action: SessionAction, approval: SessionActionReceipt['approval']): SessionActionResult {
		const base = {
			actionId: action.id ?? generateUuid(),
			status: SessionActionStatus.Approved,
			advisorySources: action.advisorySources ?? [],
			summary: approval?.summary ?? action.summary,
		};

		switch (action.kind) {
			case SessionActionKind.SearchWorkspace:
				return {
					...base,
					kind: SessionActionKind.SearchWorkspace,
				};
			case SessionActionKind.ReadFile:
				return {
					...base,
					kind: SessionActionKind.ReadFile,
					resource: (action as ReadFileAction).resource,
				};
			case SessionActionKind.WritePatch:
				return {
					...base,
					kind: SessionActionKind.WritePatch,
					filesTouched: (action as WritePatchAction).files,
					applied: false,
				};
			case SessionActionKind.RunCommand:
				return {
					...base,
					kind: SessionActionKind.RunCommand,
					command: (action as RunCommandAction).command,
					args: this._toCommandArgs((action as RunCommandAction).args),
					cwd: (action as RunCommandAction).cwd,
					commandLine: this._toCommandLine(action as RunCommandAction),
				};
			case SessionActionKind.GitStatus:
				return {
					...base,
					kind: SessionActionKind.GitStatus,
					repository: (action as GitStatusAction).repository,
				};
			case SessionActionKind.GitDiff:
				return {
					...base,
					kind: SessionActionKind.GitDiff,
					repository: (action as GitDiffAction).repository,
				};
			case SessionActionKind.OpenWorktree:
				return {
					...base,
					kind: SessionActionKind.OpenWorktree,
					repository: (action as OpenWorktreeAction).repository,
					worktreePath: (action as OpenWorktreeAction).worktreePath,
					branch: (action as OpenWorktreeAction).branch,
				};
		}
	}

	private _toScopeSummary(scope: NormalizedSessionActionScope | undefined, hostTarget: SessionActionExecutionContext['hostTarget']): SessionActionReceiptScopeSummary {
		return {
			workspaceRoot: scope?.workspaceRoot?.path,
			projectRoot: scope?.projectRoot?.path,
			repositoryPath: scope?.repositoryPath?.path,
			worktreeRoot: scope?.worktreeRoot?.path,
			cwd: scope?.cwd?.path,
			files: scope?.files.map(file => file.path) ?? [],
			hostTarget,
		};
	}

	private _getFilesTouched(result: SessionActionResult, fallback: readonly URI[]): readonly URI[] {
		if (result.kind === SessionActionKind.WritePatch) {
			return result.filesTouched;
		}

		return fallback;
	}

	private _getQuery(action: SessionAction): string | undefined {
		return action.kind === SessionActionKind.SearchWorkspace ? action.query : undefined;
	}

	private _getIncludePattern(action: SessionAction): string | undefined {
		return action.kind === SessionActionKind.SearchWorkspace ? action.includePattern : undefined;
	}

	private _getIsRegexp(action: SessionAction): boolean | undefined {
		return action.kind === SessionActionKind.SearchWorkspace ? action.isRegexp : undefined;
	}

	private _getMaxResults(action: SessionAction): number | undefined {
		return action.kind === SessionActionKind.SearchWorkspace ? action.maxResults : undefined;
	}

	private _getResource(action: SessionAction, result: SessionActionResult): URI | undefined {
		if (result.kind === SessionActionKind.ReadFile) {
			return result.resource;
		}

		return action.kind === SessionActionKind.ReadFile ? action.resource : undefined;
	}

	private _getStartLine(action: SessionAction): number | undefined {
		return action.kind === SessionActionKind.ReadFile ? action.startLine : undefined;
	}

	private _getEndLine(action: SessionAction): number | undefined {
		return action.kind === SessionActionKind.ReadFile ? action.endLine : undefined;
	}

	private _getRef(action: SessionAction): string | undefined {
		return action.kind === SessionActionKind.GitDiff ? action.ref : undefined;
	}

	private _getStdout(result: SessionActionResult): string | undefined {
		switch (result.kind) {
			case SessionActionKind.RunCommand:
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
				return result.stdout;
			case SessionActionKind.OpenWorktree:
				return result.stdout;
			default:
				return undefined;
		}
	}

	private _getStderr(result: SessionActionResult): string | undefined {
		switch (result.kind) {
			case SessionActionKind.RunCommand:
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
				return result.stderr;
			case SessionActionKind.OpenWorktree:
				return result.stderr;
			default:
				return undefined;
		}
	}

	private _getRepositoryPath(action: SessionAction, approvedScope: SessionActionReceiptScopeSummary, result: SessionActionResult): URI | undefined {
		switch (result.kind) {
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
			case SessionActionKind.OpenWorktree:
				return result.repository;
			default:
				return approvedScope.repositoryPath ?? (action.kind === SessionActionKind.OpenWorktree ? action.repository : undefined);
		}
	}

	private _getWorktreePath(action: SessionAction, approvedScope: SessionActionReceiptScopeSummary, result: SessionActionResult): URI | undefined {
		if (result.kind === SessionActionKind.OpenWorktree) {
			return result.worktreePath;
		}

		return approvedScope.worktreeRoot ?? (action.kind === SessionActionKind.OpenWorktree ? action.worktreePath : undefined);
	}

	private _getCommand(action: SessionAction): string | undefined {
		return action.kind === SessionActionKind.RunCommand ? action.command : undefined;
	}

	private _getCommandArgs(action: SessionAction): readonly string[] | undefined {
		if (action.kind !== SessionActionKind.RunCommand) {
			return undefined;
		}

		const args = this._toCommandArgs(action.args);
		return args.length > 0 ? args : undefined;
	}

	private _getBranch(action: SessionAction, result: SessionActionResult): string | undefined {
		if (result.kind === SessionActionKind.OpenWorktree) {
			return result.branch;
		}

		return action.kind === SessionActionKind.OpenWorktree ? action.branch : undefined;
	}

	private _toCommandLine(action: RunCommandAction): string {
		const parts = [action.command, ...this._toCommandArgs(action.args)];
		return parts.join(' ').trim();
	}

	private _toCommandArgs(args: readonly unknown[] | undefined): readonly string[] {
		return (args ?? []).map(arg => this._formatCommandArg(arg));
	}

	private _formatCommandArg(arg: unknown): string {
		if (typeof arg === 'string') {
			return arg;
		}

		if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null || arg === undefined) {
			return String(arg);
		}

		if (URI.isUri(arg)) {
			return arg.toString();
		}

		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}

	private _createDeniedResult(action: SessionAction, denialReason: SessionActionDenialReason, message: string, receiptId: string, actionId: string): SessionActionResult {
		const base = {
			actionId,
			status: SessionActionStatus.Denied,
			receiptId,
			advisorySources: action.advisorySources ?? [],
			denialReason,
			denialMessage: message,
			summary: message,
		};

		switch (action.kind) {
			case SessionActionKind.SearchWorkspace:
				return {
					...base,
					kind: SessionActionKind.SearchWorkspace,
				};
			case SessionActionKind.ReadFile:
				return {
					...base,
					kind: SessionActionKind.ReadFile,
					resource: (action as ReadFileAction).resource,
				};
			case SessionActionKind.WritePatch:
				return {
					...base,
					kind: SessionActionKind.WritePatch,
					filesTouched: (action as WritePatchAction).files,
				};
			case SessionActionKind.RunCommand:
				return {
					...base,
					kind: SessionActionKind.RunCommand,
					command: (action as RunCommandAction).command,
					args: this._toCommandArgs((action as RunCommandAction).args),
					cwd: (action as RunCommandAction).cwd,
					commandLine: this._toCommandLine(action as RunCommandAction),
				};
			case SessionActionKind.GitStatus:
				return {
					...base,
					kind: SessionActionKind.GitStatus,
					repository: (action as GitStatusAction).repository,
				};
			case SessionActionKind.GitDiff:
				return {
					...base,
					kind: SessionActionKind.GitDiff,
					repository: (action as GitDiffAction).repository,
				};
			case SessionActionKind.OpenWorktree:
				return {
					...base,
					kind: SessionActionKind.OpenWorktree,
					repository: (action as OpenWorktreeAction).repository,
					worktreePath: (action as OpenWorktreeAction).worktreePath,
					branch: (action as OpenWorktreeAction).branch,
				};
		}
	}

	private _createFailedResult(action: SessionAction, message: string, actionId: string): SessionActionResult {
		const base = {
			actionId,
			status: SessionActionStatus.Failed,
			advisorySources: action.advisorySources ?? [],
			denialReason: SessionActionDenialReason.ExecutionFailed,
			denialMessage: message,
			summary: message,
		};

		switch (action.kind) {
			case SessionActionKind.SearchWorkspace:
				return {
					...base,
					kind: SessionActionKind.SearchWorkspace,
				};
			case SessionActionKind.ReadFile:
				return {
					...base,
					kind: SessionActionKind.ReadFile,
					resource: (action as ReadFileAction).resource,
				};
			case SessionActionKind.WritePatch:
				return {
					...base,
					kind: SessionActionKind.WritePatch,
					filesTouched: (action as WritePatchAction).files,
					applied: false,
				};
			case SessionActionKind.RunCommand:
				return {
					...base,
					kind: SessionActionKind.RunCommand,
					command: (action as RunCommandAction).command,
					args: this._toCommandArgs((action as RunCommandAction).args),
					cwd: (action as RunCommandAction).cwd,
					commandLine: this._toCommandLine(action as RunCommandAction),
					stdout: '',
					stderr: message,
				};
			case SessionActionKind.GitStatus:
				return {
					...base,
					kind: SessionActionKind.GitStatus,
					repository: (action as GitStatusAction).repository,
					stdout: '',
					stderr: message,
				};
			case SessionActionKind.GitDiff:
				return {
					...base,
					kind: SessionActionKind.GitDiff,
					repository: (action as GitDiffAction).repository,
					stdout: '',
					stderr: message,
				};
			case SessionActionKind.OpenWorktree:
				return {
					...base,
					kind: SessionActionKind.OpenWorktree,
					repository: (action as OpenWorktreeAction).repository,
					worktreePath: (action as OpenWorktreeAction).worktreePath,
					branch: (action as OpenWorktreeAction).branch,
					opened: false,
					stdout: '',
					stderr: message,
				};
		}
	}
}

registerSingleton(ISessionActionService, SessionActionService, InstantiationType.Delayed);
