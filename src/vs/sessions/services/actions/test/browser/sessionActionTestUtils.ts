/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISessionActionApprovalService, SessionActionApprovalDecision } from '../../browser/sessionActionApprovalService.js';
import { ISessionActionExecutorBridge } from '../../browser/sessionActionExecutorBridge.js';
import { getDefaultSessionPolicySnapshot, ISessionActionPolicyConfigService } from '../../browser/sessionActionPolicyConfigService.js';
import { SessionActionPolicyService } from '../../browser/sessionActionPolicyService.js';
import { SessionActionReceiptService } from '../../browser/sessionActionReceiptService.js';
import { SessionActionService } from '../../browser/sessionActionService.js';
import { ProviderCapabilitySet } from '../../common/sessionActionPolicy.js';
import { ISessionActionReceiptService, SessionActionApprovalReceipt } from '../../common/sessionActionReceipts.js';
import { ISessionActionScopeService, NormalizedSessionActionScope } from '../../common/sessionActionScope.js';
import { SessionAction, SessionActionDenialReason, SessionActionKind, SessionActionRequestSource, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind, SessionHostKind, SessionWriteOperationStatus } from '../../common/sessionActionTypes.js';
import { ISessionsProvidersService } from '../../../sessions/browser/sessionsProvidersService.js';
import { IChat, ISession, SessionStatus } from '../../../sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../sessions/common/sessionsManagement.js';
import { getSessionsProviderActionCapabilityDenial } from '../../../sessions/common/sessionsProvider.js';

export const testWorkspaceRoot = URI.file('/workspace');
export const testRepositoryRoot = URI.file('/workspace/repo');
export const testFileResource = URI.file('/workspace/repo/file.txt');
export const testWorktreeRoot = URI.file('/workspace/repo-worktree');
export const testProviderId = 'provider';
export const testSessionId = 'session';

export interface SessionActionHarnessOptions {
	readonly providerId?: string;
	readonly sessionId?: string;
	readonly providerCapabilityOverrides?: Partial<ProviderCapabilitySet>;
	readonly policyOverrides?: Partial<ReturnType<typeof getDefaultSessionPolicySnapshot>>;
	readonly approval?: SessionActionApprovalReceipt;
	readonly scope?: NormalizedSessionActionScope;
	readonly session?: ISession;
	readonly supports?: (kind: SessionActionKind) => boolean;
	readonly executor?: (action: SessionAction) => Promise<SessionActionResult>;
}

export function createProviderCapabilities(overrides?: Partial<ProviderCapabilitySet>): ProviderCapabilitySet {
	return {
		multipleChatsPerSession: false,
		hostKind: SessionHostKind.Local,
		canReadWorkspace: true,
		canWriteWorkspace: true,
		canRunCommands: true,
		canMutateGit: true,
		canOpenWorktrees: false,
		canUseExternalTools: true,
		requiresApprovalForWrites: true,
		requiresApprovalForCommands: true,
		requiresApprovalForGit: true,
		requiresApprovalForWorktreeActions: true,
		supportsStructuredApprovals: true,
		supportsReceiptMetadata: true,
		...overrides,
	};
}

export function createScope(providerId = testProviderId, hostKind = SessionHostKind.Local): NormalizedSessionActionScope {
	return {
		requestedScope: {
			workspaceRoot: testWorkspaceRoot,
			projectRoot: testRepositoryRoot,
			repositoryPath: testRepositoryRoot,
			worktreeRoot: testRepositoryRoot,
			cwd: testRepositoryRoot,
			hostTarget: {
				kind: hostKind,
				providerId,
			},
		},
		workspaceRoot: { path: testWorkspaceRoot, isDirectory: true },
		projectRoot: { path: testRepositoryRoot, isDirectory: true },
		repositoryPath: { path: testRepositoryRoot, isDirectory: true },
		worktreeRoot: { path: testRepositoryRoot, isDirectory: true },
		cwd: { path: testRepositoryRoot, isDirectory: true },
		files: [{ path: testFileResource, isDirectory: false }],
		hostTarget: {
			kind: hostKind,
			providerId,
		},
	};
}

export function createExecutionContext(root: URI, providerId = testProviderId, sessionId = testSessionId, hostKind: SessionHostKind = root.scheme === 'file' ? SessionHostKind.Local : SessionHostKind.Remote) {
	return {
		sessionId,
		providerId,
		sessionResource: URI.parse(`session-action:/${sessionId}`),
		workspaceRoot: root,
		projectRoot: root,
		repositoryPath: root,
		worktreeRoot: root,
		hostTarget: {
			kind: hostKind,
			providerId,
			authority: root.authority || undefined,
		},
		advisorySources: [],
	};
}

export function createSession(providerId = testProviderId, sessionId = testSessionId): ISession {
	const mainChat = createChat(sessionId);
	const workspace = observableValue('workspace', {
		label: 'repo',
		icon: Codicon.folder,
		repositories: [{ uri: testRepositoryRoot, workingDirectory: testRepositoryRoot, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
		requiresWorkspaceTrust: true,
	});

	const session: ISession = {
		sessionId,
		providerId,
		resource: URI.parse(`session-action:/${sessionId}`),
		sessionType: 'test',
		icon: Codicon.account,
		createdAt: new Date(0),
		workspace,
		title: observableValue('title', 'session'),
		updatedAt: observableValue('updatedAt', new Date(0)),
		status: observableValue('status', SessionStatus.Completed),
		changes: observableValue('changes', []),
		modelId: observableValue('modelId', undefined),
		mode: observableValue('mode', undefined),
		loading: observableValue('loading', false),
		isArchived: observableValue('isArchived', false),
		isRead: observableValue('isRead', true),
		description: observableValue('description', undefined),
		lastTurnEnd: observableValue('lastTurnEnd', undefined),
		gitHubInfo: observableValue('gitHubInfo', undefined),
		chats: observableValue('chats', [mainChat]),
		mainChat,
	};

	return session;
}

export function createActiveSession(providerId = testProviderId, resource = URI.from({ scheme: 'agent-host-copilot', path: `/${testSessionId}` }), workspaceRoot = testRepositoryRoot, sessionId = testSessionId): IActiveSession {
	const session = createSession(providerId, sessionId);
	const activeSession: IActiveSession = {
		...session,
		resource,
		workspace: observableValue('workspace', {
			label: 'workspace',
			icon: Codicon.folder,
			repositories: [{ uri: workspaceRoot, workingDirectory: workspaceRoot, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
			requiresWorkspaceTrust: true,
		}),
		activeChat: observableValue('activeChat', session.mainChat),
	};

	return activeSession;
}

export function createSessionsManagementServiceStub(activeSession: IActiveSession | undefined): ISessionsManagementService {
	return {
		_serviceBrand: undefined,
		getSessions: () => activeSession ? [activeSession] : [],
		getSession: resource => activeSession && activeSession.resource.toString() === resource.toString() ? activeSession : undefined,
		getSessionTypes: () => [],
		getAllSessionTypes: () => [],
		onDidChangeSessionTypes: Event.None,
		onDidChangeSessions: Event.None,
		activeSession: observableValue('activeSession', activeSession),
		activeProviderId: observableValue('activeProviderId', activeSession?.providerId),
		setActiveProvider: () => { },
		openSession: async () => { },
		openChat: async () => { },
		openNewSessionView: () => { },
		createNewSession: () => createSession(activeSession?.providerId ?? testProviderId, activeSession?.sessionId ?? testSessionId),
		unsetNewSession: () => { },
		sendAndCreateChat: async () => { },
		setSessionType: async () => { },
		submitAction: async () => { throw new Error('Not implemented in test'); },
		getActionReceipts: () => [],
		archiveSession: async () => { },
		unarchiveSession: async () => { },
		deleteSession: async () => { },
		deleteChat: async () => { },
		renameChat: async () => { },
		setRead: () => { },
	};
}

export function createActionForKind(kind: SessionActionKind, requestedBy = SessionActionRequestSource.User): SessionAction {
	switch (kind) {
		case SessionActionKind.SearchWorkspace:
			return {
				kind,
				requestedBy,
				query: 'needle',
				maxResults: 5,
			};
		case SessionActionKind.ReadFile:
			return {
				kind,
				requestedBy,
				resource: testFileResource,
			};
		case SessionActionKind.WritePatch:
			return {
				kind,
				requestedBy,
				patch: 'patch',
				files: [testFileResource],
				operations: [{ resource: testFileResource, contents: 'updated' }],
			};
		case SessionActionKind.RunCommand:
			return {
				kind,
				requestedBy,
				command: 'npm',
				args: ['test'],
				cwd: testRepositoryRoot,
				launchKind: SessionCommandLaunchKind.Command,
			};
		case SessionActionKind.GitStatus:
			return {
				kind,
				requestedBy,
				repository: testRepositoryRoot,
			};
		case SessionActionKind.GitDiff:
			return {
				kind,
				requestedBy,
				repository: testRepositoryRoot,
				ref: 'HEAD~1',
			};
		case SessionActionKind.OpenWorktree:
			return {
				kind,
				requestedBy,
				repository: testRepositoryRoot,
				worktreePath: testWorktreeRoot,
				branch: 'feature',
			};
	}
}

function createDefaultExecutorResult(action: SessionAction): SessionActionResult {
	const actionId = action.id ?? 'action';
	const advisorySources = action.advisorySources ?? [];

	switch (action.kind) {
		case SessionActionKind.SearchWorkspace:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				resultCount: 1,
				matchCount: 1,
				limitHit: false,
				matches: [{ resource: testFileResource, lineNumber: 1, lineNumbers: [1], preview: 'needle', matchCount: 1 }],
				summary: 'Found 1 workspace search match.',
			};
		case SessionActionKind.ReadFile:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				resource: action.resource,
				contents: 'file contents',
				encoding: 'utf8',
				byteSize: 13,
				lineCount: 1,
				isPartial: false,
				summary: 'Read file.',
			};
		case SessionActionKind.WritePatch:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				filesTouched: action.files,
				applied: true,
				operationCount: action.operations?.length ?? action.files.length,
				operations: (action.operations ?? []).map(operation => ({
					resource: operation.resource,
					status: SessionWriteOperationStatus.Updated,
					bytesWritten: typeof operation.contents === 'string' ? operation.contents.length : undefined,
				})),
				summary: 'Applied file updates.',
			};
		case SessionActionKind.RunCommand: {
			const args = (action.args ?? []).map(String);
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				command: action.command,
				args,
				cwd: action.cwd,
				commandLine: [action.command, ...args].join(' ').trim(),
				exitCode: 0,
				stdout: 'command output',
				stderr: '',
				summary: 'Command completed successfully.',
			};
		}
		case SessionActionKind.GitStatus:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				repository: action.repository,
				operation: 'git status',
				branch: 'main',
				filesChanged: 1,
				mergeChanges: 0,
				indexChanges: 0,
				workingTreeChanges: 1,
				untrackedChanges: 0,
				hasChanges: true,
				stdout: JSON.stringify({ branch: 'main', filesChanged: 1, workingTreeChanges: 1 }, undefined, 2),
				stderr: '',
				summary: 'Inspected git status.',
			};
		case SessionActionKind.GitDiff:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Executed,
				advisorySources,
				repository: action.repository,
				operation: `git diff ${action.ref ?? 'HEAD'}`,
				ref: action.ref,
				filesChanged: 1,
				insertions: 1,
				deletions: 0,
				changes: [{ resource: testFileResource, insertions: 1, deletions: 0 }],
				stdout: `${testFileResource.toString()} (+1/-0)`,
				stderr: '',
				summary: 'Inspected git diff.',
			};
		case SessionActionKind.OpenWorktree:
			return {
				actionId,
				kind: action.kind,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.UnsupportedAction,
				denialMessage: 'Worktree creation is not yet supported by the Sessions executor bridge.',
				advisorySources,
				repository: action.repository,
				operation: 'git worktree add',
				worktreePath: action.worktreePath,
				branch: action.branch,
				opened: false,
				stdout: '',
				stderr: 'Worktree creation is not yet supported by the Sessions executor bridge.',
				summary: 'Worktree creation is not yet supported by the Sessions executor bridge.',
			};
	}
}

export function createSessionActionHarness(disposables: Pick<DisposableStore, 'add'>, options: SessionActionHarnessOptions = {}) {
	const providerId = options.providerId ?? testProviderId;
	const sessionId = options.sessionId ?? testSessionId;
	const providerCapabilities = createProviderCapabilities(options.providerCapabilityOverrides);
	const session = options.session ?? createSession(providerId, sessionId);
	const scope = options.scope ?? createScope(providerId, providerCapabilities.hostKind);
	const approval = options.approval ?? {
		required: false,
		granted: true,
		source: 'implicit',
		summary: 'Approved.',
		fingerprint: 'approval-fingerprint',
	};

	let approvalCalls = 0;
	let executeCalls = 0;
	let lastExecutedAction: SessionAction | undefined;
	const provider = {
		id: providerId,
		label: 'Provider',
		icon: Codicon.account,
		sessionTypes: [],
		capabilities: providerCapabilities,
		browseActions: [],
		resolveWorkspace: () => session.workspace.get()!,
		getSessions: () => [session],
		onDidChangeSessions: Event.None,
		createNewSession: () => session,
		setSessionType: () => session,
		getSessionTypes: () => [],
		renameChat: async () => { },
		setModel: () => { },
		archiveSession: async () => { },
		unarchiveSession: async () => { },
		deleteSession: async () => { },
		deleteChat: async () => { },
		setRead: () => { },
		sendAndCreateChat: async () => session,
	};

	const providersService: ISessionsProvidersService = {
		_serviceBrand: undefined,
		onDidChangeProviders: Event.None,
		registerProvider: () => { throw new Error('Not implemented in test'); },
		getProviders: () => [],
		getProvider<T>(candidateProviderId: string): T | undefined {
			return candidateProviderId === providerId ? provider as T : undefined;
		},
		getProviderCapabilities: (candidateProviderId: string) => candidateProviderId === providerId ? providerCapabilities : undefined,
		getActionCapabilityDenial: (candidateProviderId: string, actionKind: SessionActionKind) => candidateProviderId === providerId ? getSessionsProviderActionCapabilityDenial(actionKind, providerCapabilities) : undefined,
		getProviderMetadata: () => undefined,
		resolveProviderHostKind: () => providerCapabilities.hostKind,
	};

	const scopeService: ISessionActionScopeService = {
		_serviceBrand: undefined,
		resolveScope: () => ({ scope }),
	};

	const policyConfigService: ISessionActionPolicyConfigService = {
		_serviceBrand: undefined,
		onDidChangePolicy: Event.None,
		async getPolicySnapshot(_executionContext, allowedRoots) {
			return {
				...getDefaultSessionPolicySnapshot(allowedRoots),
				...options.policyOverrides,
				allowedRoots,
			};
		},
	};
	const policyService = new SessionActionPolicyService(policyConfigService);

	const approvalService: ISessionActionApprovalService = {
		_serviceBrand: undefined,
		async requestApproval(): Promise<SessionActionApprovalDecision> {
			approvalCalls++;
			return {
				approved: approval.granted,
				approval,
			};
		},
	};

	const executorBridge: ISessionActionExecutorBridge = {
		_serviceBrand: undefined,
		supports: (kind: SessionActionKind) => options.supports ? options.supports(kind) : true,
		async execute(action: SessionAction): Promise<SessionActionResult> {
			executeCalls++;
			lastExecutedAction = action;
			return options.executor ? options.executor(action) : createDefaultExecutorResult(action);
		},
	};

	const receiptService: ISessionActionReceiptService = disposables.add(new SessionActionReceiptService());
	const service = disposables.add(new SessionActionService(
		providersService,
		scopeService,
		policyService,
		approvalService,
		executorBridge,
		receiptService,
		new NullLogService(),
	));

	return {
		service,
		session,
		providerCapabilities,
		providersService,
		receiptService,
		scope,
		getApprovalCalls: () => approvalCalls,
		getExecuteCalls: () => executeCalls,
		getLastExecutedAction: () => lastExecutedAction,
	};
}

function createChat(sessionId: string): IChat {
	return {
		resource: URI.parse(`session-action:/${sessionId}/chat`),
		createdAt: new Date(0),
		title: observableValue('chatTitle', 'chat'),
		updatedAt: observableValue('chatUpdatedAt', new Date(0)),
		status: observableValue('chatStatus', SessionStatus.Completed),
		changes: observableValue('chatChanges', []),
		modelId: observableValue('chatModelId', undefined),
		mode: observableValue('chatMode', undefined),
		isArchived: observableValue('chatArchived', false),
		isRead: observableValue('chatRead', true),
		description: observableValue('chatDescription', undefined),
		lastTurnEnd: observableValue('chatLastTurnEnd', undefined),
	};
}
