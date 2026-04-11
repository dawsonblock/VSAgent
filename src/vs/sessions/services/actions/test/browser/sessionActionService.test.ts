/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { getDefaultSessionPolicySnapshot, ISessionActionPolicyConfigService } from '../../browser/sessionActionPolicyConfigService.js';
import { SessionActionPolicyService } from '../../browser/sessionActionPolicyService.js';
import { SessionActionReceiptService } from '../../browser/sessionActionReceiptService.js';
import { SessionActionScopeService } from '../../browser/sessionActionScopeService.js';
import { SessionActionService } from '../../browser/sessionActionService.js';
import { SessionActionApprovalDecision, ISessionActionApprovalService } from '../../browser/sessionActionApprovalService.js';
import { ISessionActionExecutorBridge } from '../../browser/sessionActionExecutorBridge.js';
import { ISessionActionReceiptService, SessionActionApprovalReceipt, SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { ISessionActionScopeService, NormalizedSessionActionScope } from '../../common/sessionActionScope.js';
import { ProviderCapabilitySet } from '../../common/sessionActionPolicy.js';
import { RunCommandAction, SessionAction, SessionActionDenialReason, SessionActionKind, SessionActionRequestSource, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind, SessionHostKind } from '../../common/sessionActionTypes.js';
import { ISessionsProvidersService } from '../../../sessions/browser/sessionsProvidersService.js';
import { getSessionsProviderActionCapabilityDenial } from '../../../sessions/common/sessionsProvider.js';
import { ISession, SessionStatus } from '../../../sessions/common/session.js';
import { createExecutionContext, createProviderCapabilities as createActionProviderCapabilities, testProviderId, testRepositoryRoot, testSessionId, testWorktreeRoot } from './sessionActionTestUtils.js';

suite('SessionActionService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	const workspaceRoot = URI.file('/workspace');
	const repositoryRoot = URI.file('/workspace/repo');
	const providerId = 'provider';
	const sessionId = 'session';

	function createProviderCapabilities(overrides?: Partial<ProviderCapabilitySet>): ProviderCapabilitySet {
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

	function createScope(): NormalizedSessionActionScope {
		return {
			requestedScope: {
				workspaceRoot,
				projectRoot: repositoryRoot,
				repositoryPath: repositoryRoot,
				worktreeRoot: repositoryRoot,
				cwd: repositoryRoot,
				hostTarget: {
					kind: SessionHostKind.Local,
					providerId,
				},
			},
			workspaceRoot: { path: workspaceRoot, isDirectory: true },
			projectRoot: { path: repositoryRoot, isDirectory: true },
			repositoryPath: { path: repositoryRoot, isDirectory: true },
			worktreeRoot: { path: repositoryRoot, isDirectory: true },
			cwd: { path: repositoryRoot, isDirectory: true },
			files: [],
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId,
			},
		};
	}

	function createSession(): ISession {
		const workspace = observableValue('workspace', {
			label: 'repo',
			icon: Codicon.folder,
			repositories: [{ uri: repositoryRoot, workingDirectory: repositoryRoot, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
			requiresWorkspaceTrust: true,
		});

		return {
			sessionId,
			providerId,
			resource: URI.parse('session-action:/session'),
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
			chats: observableValue('chats', []),
			mainChat: {} as ISession['mainChat'],
		} as ISession;
	}

	function createCommandAction(command: string, requestedBy: SessionActionRequestSource): RunCommandAction {
		return {
			kind: SessionActionKind.RunCommand,
			requestedBy,
			command,
			args: command.startsWith('_sessions.') ? [{ sessionId }] : ['test'],
			cwd: repositoryRoot,
			launchKind: SessionCommandLaunchKind.Command,
		};
	}

	function createHarness(options?: {
		policyOverrides?: Partial<ReturnType<typeof getDefaultSessionPolicySnapshot>>;
		providerCapabilityOverrides?: Partial<ProviderCapabilitySet>;
		approval?: SessionActionApprovalReceipt;
		executorStatus?: SessionActionStatus.Executed | SessionActionStatus.Failed;
	}) {
		const session = createSession();
		const providerCapabilities = createProviderCapabilities(options?.providerCapabilityOverrides);
		const approval = options?.approval ?? {
			required: false,
			granted: true,
			source: 'implicit',
			summary: 'No additional approval was required for this action.',
			fingerprint: 'test-fingerprint',
		};

		let approvalCalls = 0;
		let executeCalls = 0;
		let lastExecutedAction: SessionAction | undefined;

		const providersService = {
			_serviceBrand: undefined,
			onDidChangeProviders: Event.None,
			registerProvider: () => { throw new Error('Not implemented in test'); },
			getProviders: () => [],
			getProvider: (candidateProviderId: string) => candidateProviderId === providerId ? {
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
			} : undefined,
			getProviderCapabilities: (candidateProviderId: string) => candidateProviderId === providerId ? providerCapabilities : undefined,
			getActionCapabilityDenial: (candidateProviderId: string, actionKind: SessionActionKind) => candidateProviderId === providerId ? getSessionsProviderActionCapabilityDenial(actionKind, providerCapabilities) : undefined,
			getProviderMetadata: () => undefined,
			resolveProviderHostKind: () => providerCapabilities.hostKind,
		} as ISessionsProvidersService;

		const scopeService = {
			_serviceBrand: undefined,
			resolveScope: () => ({ scope: createScope() }),
		} as ISessionActionScopeService;

		const policyService = new SessionActionPolicyService({
			onDidChangePolicy: Event.None,
			async getPolicySnapshot(_executionContext, allowedRoots) {
				return {
					...getDefaultSessionPolicySnapshot(allowedRoots),
					...options?.policyOverrides,
					allowedRoots,
				};
			},
		} as ISessionActionPolicyConfigService);

		const approvalService = {
			_serviceBrand: undefined,
			async requestApproval(): Promise<SessionActionApprovalDecision> {
				approvalCalls++;
				return {
					approved: approval.granted,
					approval,
				};
			},
		} as ISessionActionApprovalService;

		const executorBridge = {
			_serviceBrand: undefined,
			supports: kind => kind === SessionActionKind.RunCommand,
			async execute(action): Promise<SessionActionResult> {
				executeCalls++;
				lastExecutedAction = action;
				const runCommandAction = action as RunCommandAction;
				const args = (runCommandAction.args ?? []).map(String);
				return {
					actionId: runCommandAction.id ?? 'unknown',
					kind: SessionActionKind.RunCommand,
					status: options?.executorStatus ?? SessionActionStatus.Executed,
					denialReason: options?.executorStatus === SessionActionStatus.Failed ? SessionActionDenialReason.ExecutionFailed : undefined,
					denialMessage: options?.executorStatus === SessionActionStatus.Failed ? 'command failed' : undefined,
					advisorySources: runCommandAction.advisorySources ?? [],
					command: runCommandAction.command,
					args,
					cwd: runCommandAction.cwd,
					commandLine: [runCommandAction.command, ...args].join(' ').trim(),
					exitCode: options?.executorStatus === SessionActionStatus.Failed ? 1 : 0,
					stdout: options?.executorStatus === SessionActionStatus.Failed ? '' : 'command output',
					stderr: options?.executorStatus === SessionActionStatus.Failed ? 'command failed' : '',
					summary: options?.executorStatus === SessionActionStatus.Failed ? 'Command failed.' : 'Command completed successfully.',
				};
			},
		} as ISessionActionExecutorBridge;

		const receiptService = disposables.add(new SessionActionReceiptService()) as ISessionActionReceiptService;
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
			getApprovalCalls: () => approvalCalls,
			getExecuteCalls: () => executeCalls,
			getLastExecutedAction: () => lastExecutedAction,
		};
	}

	test('submitAction denies policy-blocked commands and records a denied receipt', async () => {
		const harness = createHarness();
		const deniedEvent = Event.toPromise(harness.service.onDidDenyAction);
		const action = createCommandAction('npm', SessionActionRequestSource.User);

		const result = await harness.service.submitAction(sessionId, providerId, action);
		const denied = await deniedEvent;
		const receipts = harness.service.getReceiptsForSession(sessionId);

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(result.kind, SessionActionKind.RunCommand);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(harness.getApprovalCalls(), 0);
		assert.strictEqual(harness.getExecuteCalls(), 0);
		assert.strictEqual(denied.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.ok(denied.message?.includes('not permitted by the active Sessions policy'));
		assert.strictEqual(receipts.length, 1);
		assert.strictEqual(receipts[0].status, SessionActionReceiptStatus.Denied);
		assert.strictEqual(receipts[0].denialReason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(receipts[0].denial?.reason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(receipts[0].approval, undefined);
		assert.ok(receipts[0].error?.message.includes('not permitted by the active Sessions policy'));
	});

	test('submitAction denies actions when provider capability mapping blocks the action kind', async () => {
		const harness = createHarness({
			providerCapabilityOverrides: { canMutateGit: false },
			policyOverrides: { allowGitMutation: true },
		});
		const result = await harness.service.submitAction(sessionId, providerId, {
			kind: SessionActionKind.GitStatus,
			requestedBy: SessionActionRequestSource.User,
			repository: repositoryRoot,
		});
		const receipts = harness.service.getReceiptsForSession(sessionId);

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
		assert.strictEqual(harness.getApprovalCalls(), 0);
		assert.strictEqual(harness.getExecuteCalls(), 0);
		assert.strictEqual(receipts[0].denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
	});

	test('approveAction records an approved receipt without executing the action', async () => {
		const harness = createHarness({
			policyOverrides: { allowWorkspaceWrites: true },
			approval: {
				required: true,
				granted: true,
				source: 'dialog',
				summary: 'Approved internal command.',
				fingerprint: 'approval-fingerprint',
			},
		});
		const receiptEvent = Event.toPromise(harness.service.onDidAppendReceipt);
		const action = createCommandAction('_sessions.archiveSession', SessionActionRequestSource.Session);

		const result = await harness.service.approveAction(sessionId, providerId, action);
		const receipt = (await receiptEvent).receipt;

		assert.strictEqual(result.status, SessionActionStatus.Approved);
		assert.strictEqual(result.kind, SessionActionKind.RunCommand);
		assert.strictEqual(harness.getApprovalCalls(), 1);
		assert.strictEqual(harness.getExecuteCalls(), 0);
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Approved);
		assert.strictEqual(receipt.approval?.granted, true);
		assert.strictEqual(receipt.approval?.source, 'dialog');
		assert.strictEqual(receipt.approvalSummary, 'Approved internal command.');
		assert.strictEqual(receipt.approvalFingerprint, 'approval-fingerprint');
		assert.strictEqual(receipt.executionSummary, 'Approved internal command.');
	});

	test('submitAction executes allowed commands and appends an executed receipt', async () => {
		const harness = createHarness({
			policyOverrides: { allowCommands: true },
		});
		const receiptEvent = Event.toPromise(harness.service.onDidAppendReceipt);
		const action = createCommandAction('npm', SessionActionRequestSource.User);

		const result = await harness.service.submitAction(sessionId, providerId, action);
		const receipt = (await receiptEvent).receipt;

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(result.kind, SessionActionKind.RunCommand);
		assert.strictEqual(harness.getApprovalCalls(), 1);
		assert.strictEqual(harness.getExecuteCalls(), 1);
		assert.strictEqual((harness.getLastExecutedAction() as RunCommandAction | undefined)?.command, 'npm');
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Executed);
		assert.strictEqual(receipt.command, 'npm');
		assert.deepStrictEqual(receipt.args, ['test']);
		assert.strictEqual(receipt.stdout, 'command output');
		assert.strictEqual(receipt.stderr, '');
		assert.strictEqual(receipt.executionSummary, 'Command completed successfully.');
	});

	test('submitAction records executor exceptions as failed receipts instead of denials', async () => {
		const session = createSession();
		const providerCapabilities = createProviderCapabilities();
		const providersService = {
			_serviceBrand: undefined,
			onDidChangeProviders: Event.None,
			registerProvider: () => { throw new Error('Not implemented in test'); },
			getProviders: () => [],
			getProvider: () => ({
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
			}),
			getProviderCapabilities: () => providerCapabilities,
			getActionCapabilityDenial: (_providerId: string, actionKind: SessionActionKind) => getSessionsProviderActionCapabilityDenial(actionKind, providerCapabilities),
			getProviderMetadata: () => undefined,
			resolveProviderHostKind: () => providerCapabilities.hostKind,
		} as ISessionsProvidersService;
		const scopeService = {
			_serviceBrand: undefined,
			resolveScope: () => ({ scope: createScope() }),
		} as ISessionActionScopeService;
		const policyService = new SessionActionPolicyService({
			onDidChangePolicy: Event.None,
			async getPolicySnapshot(_executionContext, allowedRoots) {
				return {
					...getDefaultSessionPolicySnapshot(allowedRoots),
					allowCommands: true,
					allowedRoots,
				};
			},
		} as ISessionActionPolicyConfigService);
		const approvalService = {
			_serviceBrand: undefined,
			async requestApproval(): Promise<SessionActionApprovalDecision> {
				return {
					approved: true,
					approval: {
						required: false,
						granted: true,
						source: 'implicit',
						summary: 'Approved.',
					},
				};
			},
		} as ISessionActionApprovalService;
		const executorBridge = {
			_serviceBrand: undefined,
			supports: () => true,
			async execute(): Promise<SessionActionResult> {
				throw new Error('executor blew up');
			},
		} as ISessionActionExecutorBridge;
		const receiptService = disposables.add(new SessionActionReceiptService()) as ISessionActionReceiptService;
		const service = disposables.add(new SessionActionService(
			providersService,
			scopeService,
			policyService,
			approvalService,
			executorBridge,
			receiptService,
			new NullLogService(),
		));

		const result = await service.submitAction(sessionId, providerId, createCommandAction('npm', SessionActionRequestSource.User));
		const receipts = service.getReceiptsForSession(sessionId);

		assert.strictEqual(result.status, SessionActionStatus.Failed);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.ExecutionFailed);
		assert.strictEqual(receipts.length, 1);
		assert.strictEqual(receipts[0].status, SessionActionReceiptStatus.Failed);
		assert.strictEqual(receipts[0].denialReason, SessionActionDenialReason.ExecutionFailed);
		assert.ok(receipts[0].error?.message.includes('executor blew up'));
	});

	test('submitAction records ordered receipt timestamps across mediation and execution', async () => {
		const harness = createHarness({
			policyOverrides: { allowCommands: true },
		});
		const originalDateNow = Date.now;
		let tick = 0;
		Date.now = () => {
			tick += 100;
			return tick;
		};

		try {
			const receiptEvent = Event.toPromise(harness.service.onDidAppendReceipt);
			await harness.service.submitAction(sessionId, providerId, createCommandAction('npm', SessionActionRequestSource.User));
			const receipt = (await receiptEvent).receipt;

			assert.ok(receipt.requestedAt < receipt.decidedAt);
			assert.ok(receipt.decidedAt < (receipt.completedAt ?? 0));
		} finally {
			Date.now = originalDateNow;
		}
	});
});

suite('SessionActionScopeService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createUriIdentityService(): IUriIdentityService {
		return {
			_serviceBrand: undefined,
			extUri,
			asCanonicalUri: uri => uri,
		};
	}

	function createScopeService(): SessionActionScopeService {
		return new SessionActionScopeService(createUriIdentityService());
	}

	test('denies secret-like file paths such as .ssh', () => {
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.ReadFile,
			requestedBy: SessionActionRequestSource.User,
			resource: URI.file('/workspace/repo/.ssh/id_rsa'),
		}, createExecutionContext(testRepositoryRoot, testProviderId, testSessionId), createActionProviderCapabilities());

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.SecretPath);
		assert.ok(resolution.message?.includes('id_rsa'));
	});

	test('denies secret-like command cwd values such as .env.local', () => {
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.RunCommand,
			requestedBy: SessionActionRequestSource.User,
			command: 'npm',
			args: ['test'],
			cwd: URI.file('/workspace/repo/.env.local'),
			launchKind: SessionCommandLaunchKind.Command,
		}, createExecutionContext(testRepositoryRoot, testProviderId, testSessionId), createActionProviderCapabilities());

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.SecretPath);
		assert.ok(resolution.message?.includes('.env.local'));
	});

	test('denies file targets that escape the active session roots', () => {
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.ReadFile,
			requestedBy: SessionActionRequestSource.User,
			resource: URI.file('/outside/file.txt'),
		}, createExecutionContext(testRepositoryRoot, testProviderId, testSessionId), createActionProviderCapabilities());

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.RootEscape);
		assert.ok(resolution.message?.includes('/outside/file.txt'));
	});

	test('denies requested worktree roots that do not match the active session worktree', () => {
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.ReadFile,
			requestedBy: SessionActionRequestSource.User,
			resource: URI.file('/workspace/repo/file.txt'),
			scope: {
				worktreeRoot: testWorktreeRoot,
			},
		}, createExecutionContext(testRepositoryRoot, testProviderId, testSessionId), createActionProviderCapabilities());

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.WorktreeMismatch);
		assert.ok(resolution.message?.includes('worktree root'));
	});

	test('denies host-kind mismatches between the requested scope and provider host', () => {
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.SearchWorkspace,
			requestedBy: SessionActionRequestSource.User,
			query: 'needle',
			scope: {
				hostTarget: {
					kind: SessionHostKind.Remote,
				},
			},
		}, createExecutionContext(testRepositoryRoot, testProviderId, testSessionId), createActionProviderCapabilities());

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.HostTargetMismatch);
		assert.ok(resolution.message?.includes('host kind'));
	});

	test('denies host-authority mismatches between the requested scope and provider host', () => {
		const remoteRoot = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-host', path: '/workspace/repo' });
		const resolution = createScopeService().resolveScope({
			kind: SessionActionKind.SearchWorkspace,
			requestedBy: SessionActionRequestSource.User,
			query: 'needle',
			scope: {
				hostTarget: {
					kind: SessionHostKind.Remote,
					authority: 'other-host',
				},
			},
		}, createExecutionContext(remoteRoot, testProviderId, testSessionId, SessionHostKind.Remote), createActionProviderCapabilities({ hostKind: SessionHostKind.Remote }));

		assert.strictEqual(resolution.denialReason, SessionActionDenialReason.HostTargetMismatch);
		assert.ok(resolution.message?.includes('host authority'));
	});
});
