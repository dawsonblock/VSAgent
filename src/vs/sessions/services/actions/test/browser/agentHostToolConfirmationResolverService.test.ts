/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IChatToolInvocation, ToolConfirmKind } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { AgentHostToolConfirmationSource } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostToolConfirmationResolverService.js';
import { ISessionActionService } from '../../../../services/actions/common/sessionActionService.js';
import { SessionAction, SessionActionKind, SessionActionRequestSource, SessionActionStatus, SessionHostKind } from '../../../../services/actions/common/sessionActionTypes.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { SessionsAgentHostToolConfirmationResolverService } from '../../browser/agentHostToolConfirmationResolverService.js';

function createActiveSession(providerId: string, resource: URI, workspaceRoot: URI): IActiveSession {
	const workspace = observableValue('workspace', {
		label: 'workspace',
		icon: Codicon.folder,
		repositories: [{ uri: workspaceRoot, workingDirectory: workspaceRoot, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
		requiresWorkspaceTrust: true,
	});

	return {
		sessionId: `${providerId}:${resource.toString()}`,
		providerId,
		resource,
		sessionType: 'agent-host-copilot',
		icon: Codicon.vm,
		createdAt: new Date(),
		workspace,
		title: observableValue('title', 'session'),
		updatedAt: observableValue('updatedAt', new Date()),
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
		mainChat: {} as IActiveSession['mainChat'],
		chats: observableValue('chats', []),
		activeChat: observableValue('activeChat', {} as IActiveSession['mainChat']),
	} as IActiveSession;
}

function createInvocation(toolId: string, parameters: unknown, rawInput?: string): IChatToolInvocation {
	return {
		kind: 'toolInvocation',
		toolId,
		toolCallId: `tc-${toolId}`,
		invocationMessage: rawInput ?? toolId,
		state: observableValue('state', {
			type: IChatToolInvocation.StateKind.WaitingForConfirmation,
			parameters,
			confirm: () => { },
		}),
		toolSpecificData: rawInput ? { kind: 'input', rawInput: { input: rawInput } } : undefined,
	} as unknown as IChatToolInvocation;
}

suite('SessionsAgentHostToolConfirmationResolverService', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('mediates local write tools through approval-only Sessions actions', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const activeSession = createActiveSession('local-agent-host', URI.from({ scheme: 'agent-host-copilot', path: '/sess-1' }), URI.file('/workspace'));
		let approvedAction: SessionAction | undefined;

		instantiationService.stub(ISessionsManagementService, {
			activeSession: observableValue('activeSession', activeSession),
		});
		instantiationService.stub(ISessionsProvidersService, {
			getProviderCapabilities: () => ({
				multipleChatsPerSession: false,
				hostKind: SessionHostKind.Local,
				canReadWorkspace: true,
				canWriteWorkspace: true,
				canRunCommands: true,
				canOpenWorktrees: false,
				requiresApprovalForWrites: true,
				requiresApprovalForCommands: true,
			}),
		});
		instantiationService.stub(ISessionActionService, {
			approveAction: async (_sessionId: string, _providerId: string, action: SessionAction) => {
				approvedAction = action;
				return {
					actionId: 'approved-write',
					kind: SessionActionKind.WritePatch,
					status: SessionActionStatus.Approved,
					advisorySources: [],
					filesTouched: (action as Extract<SessionAction, { kind: SessionActionKind.WritePatch }>).files,
					applied: false,
				};
			},
		});

		const service = instantiationService.createInstance(SessionsAgentHostToolConfirmationResolverService);
		const result = await service.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Local,
			connectionAuthority: 'local',
			session: AgentSession.uri('copilot', 'sess-1'),
			turnId: 'turn-1',
			toolCallId: 'tc-write',
			invocation: createInvocation('write', { path: '/workspace/file.ts' }, '{"path":"/workspace/file.ts"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});

		assert.ok(approvedAction);
		assert.strictEqual(approvedAction.kind, SessionActionKind.WritePatch);
		assert.strictEqual(approvedAction.requestedBy, SessionActionRequestSource.Session);
		assert.deepStrictEqual((approvedAction as Extract<SessionAction, { kind: SessionActionKind.WritePatch }>).files.map(file => file.toString()), [URI.file('/workspace/file.ts').toString()]);
		assert.deepStrictEqual(result, { confirmedReason: { type: ToolConfirmKind.UserAction } });
	});

	test('mediates remote command tools through approval-only Sessions actions', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const remoteRoot = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-host', path: '/workspace' });
		const activeSession = createActiveSession('remote-agent-host-1', URI.from({ scheme: 'remote-copilot', path: '/sess-remote' }), remoteRoot);
		let approvedAction: SessionAction | undefined;

		instantiationService.stub(ISessionsManagementService, {
			activeSession: observableValue('activeSession', activeSession),
		});
		instantiationService.stub(ISessionsProvidersService, {
			getProviderCapabilities: () => ({
				multipleChatsPerSession: false,
				hostKind: SessionHostKind.Remote,
				canReadWorkspace: true,
				canWriteWorkspace: true,
				canRunCommands: true,
				canOpenWorktrees: false,
				requiresApprovalForWrites: true,
				requiresApprovalForCommands: true,
			}),
		});
		instantiationService.stub(ISessionActionService, {
			approveAction: async (_sessionId: string, _providerId: string, action: SessionAction) => {
				approvedAction = action;
				return {
					actionId: 'approved-command',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Denied,
					advisorySources: [],
					commandLine: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
					denialMessage: 'Denied by Sessions approval.',
				};
			},
		});

		const service = instantiationService.createInstance(SessionsAgentHostToolConfirmationResolverService);
		const result = await service.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Remote,
			connectionAuthority: 'remote-host',
			session: AgentSession.uri('copilot', 'sess-remote'),
			turnId: 'turn-1',
			toolCallId: 'tc-bash',
			invocation: createInvocation('bash', { command: 'npm test' }, 'npm test'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});

		assert.ok(approvedAction);
		assert.strictEqual(approvedAction.kind, SessionActionKind.RunCommand);
		assert.strictEqual((approvedAction as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command, 'npm test');
		assert.deepStrictEqual(result, {
			confirmedReason: { type: ToolConfirmKind.Denied },
			reasonMessage: 'Denied by Sessions approval.',
		});
	});

	test('allows read-only tools to pass through when provider capabilities allow reads', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const activeSession = createActiveSession('remote-agent-host-1', URI.from({ scheme: 'remote-copilot', path: '/sess-read' }), URI.file('/workspace'));
		let approveCalls = 0;

		instantiationService.stub(ISessionsManagementService, {
			activeSession: observableValue('activeSession', activeSession),
		});
		instantiationService.stub(ISessionsProvidersService, {
			getProviderCapabilities: () => ({
				multipleChatsPerSession: false,
				hostKind: SessionHostKind.Remote,
				canReadWorkspace: true,
				canWriteWorkspace: true,
				canRunCommands: true,
				canOpenWorktrees: false,
				requiresApprovalForWrites: true,
				requiresApprovalForCommands: true,
			}),
		});
		instantiationService.stub(ISessionActionService, {
			approveAction: async () => {
				approveCalls++;
				throw new Error('approveAction should not be called for read-only tools');
			},
		});

		const service = instantiationService.createInstance(SessionsAgentHostToolConfirmationResolverService);
		const result = await service.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Remote,
			connectionAuthority: 'remote-host',
			session: AgentSession.uri('copilot', 'sess-read'),
			turnId: 'turn-1',
			toolCallId: 'tc-read',
			invocation: createInvocation('view', { path: '/workspace/file.ts' }, '{"path":"/workspace/file.ts"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});

		assert.strictEqual(approveCalls, 0);
		assert.strictEqual(result, undefined);
	});
});
