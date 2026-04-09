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
		this._onDidChangeActiveAction.fire({ sessionId, actionId: normalizedAction.id!, active: true });

		try {
			const provider = this._sessionsProvidersService.getProvider(providerId);
			if (!provider) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ProviderCapabilityMissing, 'No Sessions provider was found for this action.', undefined);
			}

			const session = provider.getSessions().find(candidate => candidate.sessionId === sessionId);
			if (!session) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.PolicyDenied, 'No active session was found for this action.', undefined);
			}

			const capabilities = this._sessionsProvidersService.getProviderCapabilities(providerId, sessionId);
			if (!capabilities) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ProviderCapabilityMissing, 'The Sessions provider did not report a capability set.', session);
			}

			const executionContext = this._createExecutionContext(session, capabilities);
			const scopeResolution = this._scopeService.resolveScope(normalizedAction, executionContext, capabilities);
			if (!scopeResolution.scope || scopeResolution.denialReason) {
				return this._deny(sessionId, providerId, normalizedAction, scopeResolution.denialReason ?? SessionActionDenialReason.InvalidPathScope, scopeResolution.message ?? 'The action scope could not be normalized.', session, executionContext);
			}

			const policySnapshot = this._policyService.getPolicySnapshot(this._collectPolicyRoots(executionContext));
			const policyDecision = this._policyService.evaluate({
				action: normalizedAction,
				normalizedScope: scopeResolution.scope,
				providerCapabilities: capabilities,
				executionContext,
				policy: policySnapshot,
				requestedPermissionMode: executionContext.permissionMode,
			});

			if (policyDecision.mode === SessionActionPolicyMode.Deny) {
				return this._deny(sessionId, providerId, normalizedAction, policyDecision.denialReason ?? SessionActionDenialReason.PolicyDenied, policyDecision.denialMetadata?.message ?? 'The Sessions action policy denied this request.', session, executionContext, scopeResolution.scope, policyDecision.denialMetadata);
			}

			const approvalDecision = await this._approvalService.requestApproval(normalizedAction, policyDecision, capabilities);
			if (!approvalDecision.approved) {
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ApprovalDenied, approvalDecision.approval.summary, session, executionContext, scopeResolution.scope, undefined, approvalDecision.approval);
			}

			if (!execute) {
				const approvedResult = this._createApprovedResult(normalizedAction, approvalDecision.approval);
				const receipt = this._createReceipt({
					action: normalizedAction,
					sessionId,
					providerId,
					executionContext,
					requestedScope: this._toScopeSummary(scopeResolution.scope, executionContext.hostTarget),
					approvedScope: this._toScopeSummary(scopeResolution.scope, executionContext.hostTarget),
					status: SessionActionReceiptStatus.Approved,
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
				return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.UnsupportedAction, `Action kind '${normalizedAction.kind}' is not yet mediated by the Sessions executor bridge.`, session, executionContext, scopeResolution.scope, undefined, approvalDecision.approval);
			}

			const executionResult = await this._executorBridge.execute(normalizedAction, scopeResolution.scope);
			const receipt = this._createReceipt({
				action: normalizedAction,
				sessionId,
				providerId,
				executionContext,
				requestedScope: this._toScopeSummary(scopeResolution.scope, executionContext.hostTarget),
				approvedScope: this._toScopeSummary(scopeResolution.scope, executionContext.hostTarget),
				status: executionResult.status === SessionActionStatus.Executed ? SessionActionReceiptStatus.Executed : SessionActionReceiptStatus.Failed,
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
			return this._deny(sessionId, providerId, normalizedAction, SessionActionDenialReason.ExecutionFailed, error instanceof Error ? error.message : 'An unknown error occurred while executing the Sessions action.', undefined);
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

	private _deny(sessionId: string, providerId: string, action: SessionAction, denialReason: SessionActionDenialReason, message: string, session: ISession | undefined, executionContext?: SessionActionExecutionContext, normalizedScope?: NormalizedSessionActionScope, denialMetadata?: PolicyDenialMetadata, approval?: SessionActionReceipt['approval']): SessionActionResult {
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
		const receipt = this._createReceipt({
			action,
			sessionId,
			providerId,
			executionContext: context,
			requestedScope: scopeSummary,
			approvedScope: scopeSummary,
			status: SessionActionReceiptStatus.Denied,
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

	private _createReceipt(options: {
		action: SessionAction;
		sessionId: string;
		providerId: string;
		executionContext: SessionActionExecutionContext;
		requestedScope: SessionActionReceiptScopeSummary;
		approvedScope: SessionActionReceiptScopeSummary;
		status: SessionActionReceiptStatus;
		executionResult: SessionActionResult;
		approval?: SessionActionReceipt['approval'];
		denial?: SessionActionReceipt['denial'];
	}): SessionActionReceipt {
		const now = Date.now();
		const executionResult = options.executionResult;
		return {
			id: generateUuid(),
			sessionId: options.sessionId,
			providerId: options.providerId,
			hostKind: options.executionContext.hostTarget.kind,
			hostTarget: options.executionContext.hostTarget,
			actionId: options.action.id ?? executionResult.actionId,
			actionKind: options.action.kind,
			requestedScope: options.requestedScope,
			approvedScope: options.approvedScope,
			requestedAt: now,
			decidedAt: now,
			completedAt: now,
			status: options.status,
			filesTouched: this._getFilesTouched(executionResult, options.approvedScope.files),
			cwd: options.approvedScope.cwd,
			repositoryPath: options.approvedScope.repositoryPath,
			worktreePath: options.approvedScope.worktreeRoot,
			stdoutExcerpt: this._getStdoutExcerpt(executionResult),
			stderrExcerpt: this._getStderrExcerpt(executionResult),
			approval: options.approval,
			denial: options.denial,
			advisorySources: executionResult.advisorySources,
			executionSummary: executionResult.summary,
			error: executionResult.status === SessionActionStatus.Failed || executionResult.status === SessionActionStatus.Denied
				? {
					name: executionResult.status,
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

	private _getStdoutExcerpt(result: SessionActionResult): string | undefined {
		switch (result.kind) {
			case SessionActionKind.RunCommand:
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
				return result.stdoutExcerpt;
			default:
				return undefined;
		}
	}

	private _getStderrExcerpt(result: SessionActionResult): string | undefined {
		switch (result.kind) {
			case SessionActionKind.RunCommand:
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
				return result.stderrExcerpt;
			default:
				return undefined;
		}
	}

	private _toCommandLine(action: RunCommandAction): string {
		const parts = [action.command, ...(action.args ?? []).map(arg => this._formatCommandArg(arg))];
		return parts.join(' ').trim();
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
					commandLine: (action as RunCommandAction).command,
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
				};
		}
	}
}

registerSingleton(ISessionActionService, SessionActionService, InstantiationType.Delayed);
