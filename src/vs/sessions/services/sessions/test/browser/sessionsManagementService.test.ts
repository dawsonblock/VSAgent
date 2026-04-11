/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extUri } from '../../../../../base/common/resources.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService, ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ISessionActionService } from '../../../../services/actions/common/sessionActionService.js';
import { SessionAction, SessionActionKind, SessionActionStatus, SessionHostKind } from '../../../../services/actions/common/sessionActionTypes.js';
import { ISessionAutonomousExecutionService } from '../../../../services/autonomy/common/sessionAutonomousExecutionService.js';
import { AutonomyContinuationDecision, AutonomyStopReason, SessionAutonomyMode } from '../../../../services/autonomy/common/sessionAutonomyTypes.js';
import { ISessionPlanningService } from '../../../../services/planning/common/sessionPlanningService.js';
import { getDefaultSessionPlanBudget, SessionPlanStatus, SessionPlanStepKind } from '../../../../services/planning/common/sessionPlanTypes.js';
import { ISessionsProvidersService } from '../../browser/sessionsProvidersService.js';
import { SessionsManagementService } from '../../browser/sessionsManagementService.js';
import { SessionStatus, ISession } from '../../common/session.js';
import { ISendRequestOptions, ISessionsProvider } from '../../common/sessionsProvider.js';

interface IProviderCalls {
	archiveSessions: string[];
	unarchiveSessions: string[];
	deletedSessions: string[];
	deletedChats: Array<{ sessionId: string; chatUri: URI }>;
	renameChats: Array<{ sessionId: string; chatUri: URI; title: string }>;
	readStates: Array<{ sessionId: string; read: boolean }>;
	sendRequests: ISendRequestOptions[];
}

function createProviderCalls(): IProviderCalls {
	return {
		archiveSessions: [],
		unarchiveSessions: [],
		deletedSessions: [],
		deletedChats: [],
		renameChats: [],
		readStates: [],
		sendRequests: [],
	};
}

function createSession(providerId = 'provider'): ISession {
	const resource = URI.parse(`testSessions:/${providerId}/session`);
	const workspaceRoot = URI.file('/workspace');
	const chat = {
		resource: URI.parse(`testSessions:/${providerId}/chat`),
		createdAt: new Date(0),
		title: observableValue('chatTitle', 'Chat'),
		updatedAt: observableValue('chatUpdatedAt', new Date(0)),
		status: observableValue('chatStatus', SessionStatus.Completed),
		changes: observableValue('chatChanges', []),
		modelId: observableValue('chatModelId', undefined),
		mode: observableValue('chatMode', undefined),
		isArchived: observableValue('chatIsArchived', false),
		isRead: observableValue('chatIsRead', true),
		description: observableValue('chatDescription', undefined),
		lastTurnEnd: observableValue('chatLastTurnEnd', undefined),
	};

	return {
		sessionId: `${providerId}:session`,
		providerId,
		resource,
		sessionType: 'test-session',
		icon: Codicon.vm,
		createdAt: new Date(0),
		workspace: observableValue('workspace', {
			label: 'workspace',
			icon: Codicon.folder,
			repositories: [{ uri: workspaceRoot, workingDirectory: workspaceRoot, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
			requiresWorkspaceTrust: false,
		}),
		title: observableValue('title', 'Session'),
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
		chats: observableValue('chats', [chat]),
		mainChat: chat,
	};
}

function createProvider(session: ISession, calls: IProviderCalls): ISessionsProvider {
	return {
		id: session.providerId,
		label: 'Provider',
		icon: Codicon.vm,
		sessionTypes: [],
		browseActions: [],
		resolveWorkspace: (repositoryUri: URI) => ({
			label: repositoryUri.path,
			icon: Codicon.folder,
			repositories: [{ uri: repositoryUri, workingDirectory: repositoryUri, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
			requiresWorkspaceTrust: false,
		}),
		onDidChangeSessions: Event.None,
		getSessions: () => [session],
		createNewSession: () => { throw new Error('Not implemented'); },
		setSessionType: () => session,
		getSessionTypes: () => [],
		renameChat: async (sessionId: string, chatUri: URI, title: string) => {
			calls.renameChats.push({ sessionId, chatUri, title });
		},
		setModel: () => { },
		archiveSession: async (sessionId: string) => {
			calls.archiveSessions.push(sessionId);
		},
		unarchiveSession: async (sessionId: string) => {
			calls.unarchiveSessions.push(sessionId);
		},
		deleteSession: async (sessionId: string) => {
			calls.deletedSessions.push(sessionId);
		},
		deleteChat: async (sessionId: string, chatUri: URI) => {
			calls.deletedChats.push({ sessionId, chatUri });
		},
		setRead: (sessionId: string, read: boolean) => {
			calls.readStates.push({ sessionId, read });
		},
		sendAndCreateChat: async (_sessionId: string, options: ISendRequestOptions) => {
			calls.sendRequests.push(options);
			return session;
		},
		capabilities: {
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
		},
	};
}

suite('SessionsManagementService', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createInstantiationService(provider: ISessionsProvider, sessionActionService: Partial<ISessionActionService>, runtimeServices?: { planning?: Partial<ISessionPlanningService>; autonomousExecution?: Partial<ISessionAutonomousExecutionService> }): TestInstantiationService {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IStorageService, disposables.add(new TestStorageService()));
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IChatWidgetService, {
			openSession: async () => undefined,
		});
		instantiationService.stub(ISessionsProvidersService, {
			onDidChangeProviders: Event.None,
			registerProvider: () => ({ dispose() { } }),
			getProviders: () => [provider],
			getProvider: <T extends ISessionsProvider>(providerId: string) => providerId === provider.id ? provider as T : undefined,
			getProviderCapabilities: () => provider.capabilities,
			getProviderMetadata: () => undefined,
			resolveProviderHostKind: () => provider.capabilities.hostKind,
		});
		instantiationService.stub(ISessionActionService, {
			submitAction: async () => {
				throw new Error('submitAction not stubbed');
			},
			getReceiptsForSession: () => [],
			...sessionActionService,
		});
		instantiationService.stub(ISessionPlanningService, {
			createPlan: async () => {
				throw new Error('createPlan not stubbed');
			},
			...runtimeServices?.planning,
		});
		instantiationService.stub(ISessionAutonomousExecutionService, {
			executePlan: async () => {
				throw new Error('executePlan not stubbed');
			},
			...runtimeServices?.autonomousExecution,
		});
		return instantiationService;
	}

	test('routes all session mutations through mediated run-command actions', async () => {
		const session = createSession();
		const calls = createProviderCalls();
		const provider = createProvider(session, calls);
		const chatUri = URI.parse('testSessions:/provider/chat-mutation');
		const submittedActions: SessionAction[] = [];

		const instantiationService = createInstantiationService(provider, {
			submitAction: async (_sessionId: string, _providerId: string, action: SessionAction) => {
				submittedActions.push(action);
				return {
					actionId: `action-${submittedActions.length}`,
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Executed,
					advisorySources: [],
					command: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
					args: ((action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).args ?? []).map(String),
					commandLine: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
				};
			},
		});

		const service = disposables.add(instantiationService.createInstance(SessionsManagementService));
		await service.archiveSession(session);
		await service.unarchiveSession(session);
		await service.deleteSession(session);
		await service.deleteChat(session, chatUri);
		await service.renameChat(session, chatUri, 'Renamed Chat');
		service.setRead(session, false);
		await Promise.resolve();

		assert.deepStrictEqual(calls, createProviderCalls());
		assert.strictEqual(submittedActions.length, 6);

		const [archiveAction, unarchiveAction, deleteSessionAction, deleteChatAction, renameChatAction, setReadAction] = submittedActions.map(action => action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>);

		assert.strictEqual(archiveAction.command, '_sessions.archiveSession');
		assert.deepStrictEqual(archiveAction.args, [{ providerId: session.providerId, sessionId: session.sessionId }]);

		assert.strictEqual(unarchiveAction.command, '_sessions.unarchiveSession');
		assert.deepStrictEqual(unarchiveAction.args, [{ providerId: session.providerId, sessionId: session.sessionId }]);

		assert.strictEqual(deleteSessionAction.command, '_sessions.deleteSession');
		assert.deepStrictEqual(deleteSessionAction.args, [{ providerId: session.providerId, sessionId: session.sessionId }]);

		assert.strictEqual(deleteChatAction.command, '_sessions.deleteChat');
		assert.deepStrictEqual((deleteChatAction.args ?? []).map(arg => ({
			...(arg as Record<string, unknown>),
			chatUri: URI.isUri((arg as { chatUri?: URI }).chatUri) ? (arg as { chatUri: URI }).chatUri.toString() : (arg as { chatUri?: string }).chatUri,
		})), [{ providerId: session.providerId, sessionId: session.sessionId, chatUri: chatUri.toString() }]);

		assert.strictEqual(renameChatAction.command, '_sessions.renameChat');
		assert.deepStrictEqual((renameChatAction.args ?? []).map(arg => ({
			...(arg as Record<string, unknown>),
			chatUri: URI.isUri((arg as { chatUri?: URI }).chatUri) ? (arg as { chatUri: URI }).chatUri.toString() : (arg as { chatUri?: string }).chatUri,
		})), [{ providerId: session.providerId, sessionId: session.sessionId, chatUri: chatUri.toString(), title: 'Renamed Chat' }]);

		assert.strictEqual(setReadAction.command, '_sessions.setRead');
		assert.deepStrictEqual(setReadAction.args, [{ providerId: session.providerId, sessionId: session.sessionId, read: false }]);
	});

	test('archives sessions through mediated run-command actions', async () => {
		const session = createSession();
		const calls = createProviderCalls();
		const provider = createProvider(session, calls);
		let submittedAction: SessionAction | undefined;

		const instantiationService = createInstantiationService(provider, {
			submitAction: async (_sessionId: string, _providerId: string, action: SessionAction) => {
				submittedAction = action;
				return {
					actionId: 'archive-action',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Executed,
					advisorySources: [],
					command: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
					args: ((action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).args ?? []).map(String),
					commandLine: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
				};
			},
		});

		const service = disposables.add(instantiationService.createInstance(SessionsManagementService));
		await service.archiveSession(session);

		assert.strictEqual(calls.archiveSessions.length, 0);
		assert.ok(submittedAction);
		assert.strictEqual(submittedAction.kind, SessionActionKind.RunCommand);
		assert.strictEqual((submittedAction as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command, '_sessions.archiveSession');
		assert.deepStrictEqual((submittedAction as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).args, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
		}]);
	});

	test('updates read state through mediated run-command actions', async () => {
		const session = createSession();
		const calls = createProviderCalls();
		const provider = createProvider(session, calls);
		let submittedAction: SessionAction | undefined;

		const instantiationService = createInstantiationService(provider, {
			submitAction: async (_sessionId: string, _providerId: string, action: SessionAction) => {
				submittedAction = action;
				return {
					actionId: 'read-action',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Executed,
					advisorySources: [],
					command: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
					args: ((action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).args ?? []).map(String),
					commandLine: (action as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command,
				};
			},
		});

		const service = disposables.add(instantiationService.createInstance(SessionsManagementService));
		service.setRead(session, false);
		await Promise.resolve();

		assert.strictEqual(calls.readStates.length, 0);
		assert.ok(submittedAction);
		assert.strictEqual((submittedAction as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).command, '_sessions.setRead');
		assert.deepStrictEqual((submittedAction as Extract<SessionAction, { kind: SessionActionKind.RunCommand }>).args, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
			read: false,
		}]);
	});

	test('internal Sessions commands delegate back to the owning provider', async () => {
		const session = createSession();
		const calls = createProviderCalls();
		const provider = createProvider(session, calls);
		const chatUri = URI.parse('testSessions:/provider/chat-rename');
		const instantiationService = createInstantiationService(provider, {});

		const archiveCommand = CommandsRegistry.getCommand('_sessions.archiveSession');
		const renameCommand = CommandsRegistry.getCommand('_sessions.renameChat');
		assert.ok(archiveCommand);
		assert.ok(renameCommand);

		await instantiationService.invokeFunction(archiveCommand.handler, {
			providerId: session.providerId,
			sessionId: session.sessionId,
		});
		await instantiationService.invokeFunction(renameCommand.handler, {
			providerId: session.providerId,
			sessionId: session.sessionId,
			chatUri,
			title: 'Renamed Chat',
		});

		assert.deepStrictEqual(calls.archiveSessions, [session.sessionId]);
		assert.deepStrictEqual(calls.renameChats.map(call => ({
			sessionId: call.sessionId,
			chatUri: call.chatUri.toString(),
			title: call.title,
		})), [{
			sessionId: session.sessionId,
			chatUri: chatUri.toString(),
			title: 'Renamed Chat',
		}]);
	});

	test('sendAndCreateChat routes advisory autonomy through runtime services and strips metadata before forwarding to providers', async () => {
		const session = createSession();
		const calls = createProviderCalls();
		const provider = createProvider(session, calls);
		let planningRequest: Parameters<ISessionPlanningService['createPlan']>[0] | undefined;
		let autonomousExecutionRequest: Parameters<ISessionAutonomousExecutionService['executePlan']>[0] | undefined;

		const plan = {
			id: 'plan-1',
			sessionId: session.sessionId,
			providerId: session.providerId,
			intent: 'Repair the repo',
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: session.providerId,
			},
			steps: [],
			status: SessionPlanStatus.Draft,
			budget: getDefaultSessionPlanBudget(),
			createdAt: 1,
			updatedAt: 1,
		};

		const instantiationService = createInstantiationService(provider, {}, {
			planning: {
				createPlan: async request => {
					planningRequest = request;
					return plan;
				},
			},
			autonomousExecution: {
				executePlan: async request => {
					autonomousExecutionRequest = request;
					return {
						planId: plan.id,
						sessionId: session.sessionId,
						providerId: session.providerId,
						status: SessionPlanStatus.Completed,
						decision: AutonomyContinuationDecision.Stop,
						stopReason: AutonomyStopReason.Completed,
						stepResults: [],
						budgetState: {
							budget: getDefaultSessionPlanBudget(),
							startedAt: 1,
							executedSteps: 0,
							executedCommands: 0,
							fileWrites: 0,
							modifiedFiles: [],
							failures: 0,
							attemptsByStep: {},
							elapsedMs: 0,
						},
						issues: [],
						reasons: [],
					};
				},
			},
		});

		const service = disposables.add(instantiationService.createInstance(SessionsManagementService));
		await service.sendAndCreateChat(session, {
			query: 'Repair the repo',
			advisoryAutonomy: {
				mode: SessionAutonomyMode.RepoRepair,
				steps: [{ kind: SessionPlanStepKind.Review, title: 'Review the diff' }],
			},
		});

		assert.ok(planningRequest);
		assert.strictEqual(planningRequest.intent, 'Repair the repo');
		assert.strictEqual(planningRequest.sessionId, session.sessionId);
		assert.ok(autonomousExecutionRequest);
		assert.strictEqual(autonomousExecutionRequest.plan, plan);
		assert.deepStrictEqual(calls.sendRequests, [{ query: 'Repair the repo', attachedContext: undefined }]);
	});
});
