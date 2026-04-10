/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, autorun, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ActiveSessionProviderIdContext, ActiveSessionTypeContext, IsActiveSessionBackgroundProviderContext, IsNewChatSessionContext } from '../../../common/contextkeys.js';
import { ISessionActionService } from '../../actions/common/sessionActionService.js';
import { SessionActionReceipt } from '../../actions/common/sessionActionReceipts.js';
import { SessionAction, SessionActionKind, SessionActionRequestSource, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind } from '../../actions/common/sessionActionTypes.js';
import { ActiveSessionSupportsMultiChatContext, IActiveSession, ISessionsChangeEvent, ISessionsManagementService } from '../common/sessionsManagement.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from './sessionsProvidersService.js';
import { ISendRequestOptions, ISessionChangeEvent, ISessionsProvider } from '../common/sessionsProvider.js';
import { COPILOT_CLI_SESSION_TYPE, IChat, ISession, ISessionWorkspace, SessionStatus, ISessionType } from '../common/session.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

const LAST_SELECTED_SESSION_KEY = 'agentSessions.lastSelectedSession';
const ACTIVE_PROVIDER_KEY = 'sessions.activeProviderId';

const enum SessionsManagementCommandId {
	ArchiveSession = '_sessions.archiveSession',
	UnarchiveSession = '_sessions.unarchiveSession',
	DeleteSession = '_sessions.deleteSession',
	DeleteChat = '_sessions.deleteChat',
	RenameChat = '_sessions.renameChat',
	SetRead = '_sessions.setRead',
}

interface ISessionMutationCommandArgs {
	readonly providerId: string;
	readonly sessionId: string;
}

interface IChatMutationCommandArgs extends ISessionMutationCommandArgs {
	readonly chatUri: URI;
}

interface IRenameChatCommandArgs extends IChatMutationCommandArgs {
	readonly title: string;
}

interface ISetReadCommandArgs extends ISessionMutationCommandArgs {
	readonly read: boolean;
}

export class SessionsManagementService extends Disposable implements ISessionsManagementService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionsChangeEvent>());
	readonly onDidChangeSessions: Event<ISessionsChangeEvent> = this._onDidChangeSessions.event;

	private readonly _onDidChangeSessionTypes = this._register(new Emitter<void>());
	readonly onDidChangeSessionTypes: Event<void> = this._onDidChangeSessionTypes.event;

	private _sessionTypes: readonly ISessionType[] = [];

	private readonly _activeSession = observableValue<IActiveSession | undefined>(this, undefined);
	readonly activeSession: IObservable<IActiveSession | undefined> = this._activeSession;
	private readonly _activeProviderId = observableValue<string | undefined>(this, undefined);
	readonly activeProviderId: IObservable<string | undefined> = this._activeProviderId;
	private lastSelectedSession: URI | undefined;
	private readonly isNewChatSessionContext: IContextKey<boolean>;
	private readonly _activeSessionProviderId: IContextKey<string>;
	private readonly _activeSessionType: IContextKey<string>;
	private readonly _isBackgroundProvider: IContextKey<boolean>;
	private readonly _supportsMultiChat: IContextKey<boolean>;
	private _activeChatObservable: ISettableObservable<IChat> | undefined;
	private _activeSessionDisposables = this._register(new DisposableStore());
	private readonly _providerListeners = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@ISessionActionService private readonly _sessionActionService: ISessionActionService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();

		// Bind context key to active session state.
		// isNewSession is false when there are any established sessions in the model.
		this.isNewChatSessionContext = IsNewChatSessionContext.bindTo(contextKeyService);
		this._activeSessionProviderId = ActiveSessionProviderIdContext.bindTo(contextKeyService);
		this._activeSessionType = ActiveSessionTypeContext.bindTo(contextKeyService);
		this._isBackgroundProvider = IsActiveSessionBackgroundProviderContext.bindTo(contextKeyService);
		this._supportsMultiChat = ActiveSessionSupportsMultiChatContext.bindTo(contextKeyService);

		// Load last selected session
		this.lastSelectedSession = this.loadLastSelectedSession();

		// Save on shutdown
		this._register(this.storageService.onWillSaveState(() => this.saveLastSelectedSession()));

		// Restore or auto-select active provider
		this._initActiveProvider();
		this._register(this.sessionsProvidersService.onDidChangeProviders(e => {
			this._onProvidersChanged(e);
			this._initActiveProvider();
			this._updateSessionTypes();
		}));
		this._subscribeToProviders(this.sessionsProvidersService.getProviders());
	}

	private _onProvidersChanged(e: ISessionsProvidersChangeEvent): void {
		for (const provider of e.removed) {
			this._providerListeners.deleteAndDispose(provider.id);
		}
		if (e.added.length) {
			this._subscribeToProviders(e.added);
		}
	}

	private _subscribeToProviders(providers: readonly ISessionsProvider[]): void {
		for (const provider of providers) {
			const disposables = new DisposableStore();
			disposables.add(provider.onDidChangeSessions(e => this.onDidChangeSessionsFromSessionsProviders(e)));
			if (provider.onDidReplaceSession) {
				disposables.add(provider.onDidReplaceSession(e => this.onDidReplaceSession(e.from, e.to)));
			}
			this._providerListeners.set(provider.id, disposables);
		}
	}

	private _initActiveProvider(): void {
		const providers = this.sessionsProvidersService.getProviders();
		if (providers.length === 0) {
			return;
		}

		// If already set and still valid, keep it
		const current = this._activeProviderId.get();
		if (current && providers.some(p => p.id === current)) {
			return;
		}

		// Try to restore from storage
		const stored = this.storageService.get(ACTIVE_PROVIDER_KEY, StorageScope.PROFILE);
		if (stored && providers.some(p => p.id === stored)) {
			this._activeProviderId.set(stored, undefined);
			return;
		}

		// Auto-select the first (or only) provider
		this._activeProviderId.set(providers[0].id, undefined);
	}

	setActiveProvider(providerId: string): void {
		this._activeProviderId.set(providerId, undefined);
		this.storageService.store(ACTIVE_PROVIDER_KEY, providerId, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private onDidReplaceSession(from: ISession, to: ISession): void {
		if (this._activeSession.get()?.sessionId === from.sessionId) {
			this.setActiveSession(to);
			this._onDidChangeSessions.fire({
				added: [],
				removed: [from],
				changed: [to],
			});
		}
	}

	private onDidChangeSessionsFromSessionsProviders(e: ISessionChangeEvent): void {
		this._onDidChangeSessions.fire(e);
		const currentActive = this._activeSession.get();

		if (!currentActive) {
			return;
		}

		if (e.removed.length) {
			if (e.removed.some(r => r.sessionId === currentActive.sessionId)) {
				this.openNewSessionView();
				return;
			}
		}
	}

	getSessions(): ISession[] {
		const sessions: ISession[] = [];
		for (const provider of this.sessionsProvidersService.getProviders()) {
			sessions.push(...provider.getSessions());
		}
		return sessions;
	}

	getSession(resource: URI): ISession | undefined {
		return this.getSessions().find(s =>
			this.uriIdentityService.extUri.isEqual(s.resource, resource)
		);
	}

	getSessionTypes(session: ISession): ISessionType[] {
		const provider = this.sessionsProvidersService.getProviders().find(p => p.id === session.providerId);
		if (!provider) {
			return [];
		}
		return provider.getSessionTypes(session.sessionId);
	}

	getAllSessionTypes(): ISessionType[] {
		return [...this._sessionTypes];
	}

	private _collectSessionTypes(): ISessionType[] {
		const types: ISessionType[] = [];
		const seen = new Set<string>();
		for (const provider of this.sessionsProvidersService.getProviders()) {
			for (const type of provider.sessionTypes) {
				if (!seen.has(type.id)) {
					seen.add(type.id);
					types.push(type);
				}
			}
		}
		return types;
	}

	private _updateSessionTypes(): void {
		const newTypes = this._collectSessionTypes();
		const oldIds = new Set(this._sessionTypes.map(t => t.id));
		const newIds = new Set(newTypes.map(t => t.id));
		if (oldIds.size !== newIds.size || [...oldIds].some(id => !newIds.has(id))) {
			this._sessionTypes = newTypes;
			this._onDidChangeSessionTypes.fire();
		}
	}

	async openChat(session: ISession, chatUri: URI): Promise<void> {
		this.logService.info(`[SessionsManagement] openChat: ${chatUri.toString()} provider=${session.providerId}`);
		this.isNewChatSessionContext.set(false);
		this.setActiveSession(session);

		// Update active chat
		if (this._activeChatObservable) {
			const activeSession = this._activeSession.get();
			if (activeSession) {
				const chat = activeSession.chats.get().find(c => this.uriIdentityService.extUri.isEqual(c.resource, chatUri));
				if (chat) {
					this._activeChatObservable.set(chat, undefined);
				}
			}
		}

		await this.chatWidgetService.openSession(chatUri, ChatViewPaneTarget);
	}

	async openSession(sessionResource: URI, options?: { preserveFocus?: boolean }): Promise<void> {
		const sessionData = this.getSession(sessionResource);
		if (!sessionData) {
			this.logService.warn(`[SessionsManagement] openSession: session not found: ${sessionResource.toString()}`);
			throw new Error(`Session with resource ${sessionResource.toString()} not found`);
		}
		this.logService.info(`[SessionsManagement] openSession: ${sessionResource.toString()} provider=${sessionData.providerId}`);
		this.isNewChatSessionContext.set(false);
		this.setActiveSession(sessionData);
		this.setRead(sessionData, true); // mark as read when opened

		await this.chatWidgetService.openSession(sessionData.resource, ChatViewPaneTarget, { preserveFocus: options?.preserveFocus });
	}

	unsetNewSession(): void {
		this.setActiveSession(undefined);
	}

	createNewSession(providerId: string, workspace: ISessionWorkspace): ISession {
		if (!this.isNewChatSessionContext.get()) {
			this.isNewChatSessionContext.set(true);
		}

		const provider = this.sessionsProvidersService.getProviders().find(p => p.id === providerId);
		if (!provider) {
			throw new Error(`Sessions provider '${providerId}' not found`);
		}

		const session = provider.createNewSession(workspace);
		this.setActiveSession(session);
		return session;
	}

	async setSessionType(session: ISession, type: ISessionType): Promise<void> {
		const provider = this.sessionsProvidersService.getProviders().find(p => p.id === session.providerId);
		if (!provider) {
			throw new Error(`Sessions provider '${session.providerId}' not found`);
		}

		const updatedSession = provider.setSessionType(session.sessionId, type);

		const activeSession = this._activeSession.get();
		if (activeSession && activeSession.sessionId === updatedSession.sessionId) {
			this.setActiveSession(updatedSession);
		}
	}

	submitAction(session: ISession, action: SessionAction): Promise<SessionActionResult> {
		return this._sessionActionService.submitAction(session.sessionId, session.providerId, action);
	}

	getActionReceipts(session: ISession): readonly SessionActionReceipt[] {
		return this._sessionActionService.getReceiptsForSession(session.sessionId);
	}

	async sendAndCreateChat(session: ISession, options: ISendRequestOptions): Promise<void> {
		this.isNewChatSessionContext.set(false);

		const setActiveChatToLast = () => {
			const activeSession = this._activeSession.get();
			if (this._activeChatObservable && activeSession?.sessionId === session.sessionId && this.uriIdentityService.extUri.isEqual(activeSession.activeChat.get().resource, (<IActiveSession>session).activeChat?.get().resource)) {
				const chats = activeSession.chats.get();
				const lastChat = chats[chats.length - 1];
				if (lastChat) {
					this._activeChatObservable.set(lastChat, undefined);
				}
			}
		};

		// Listen for chats changing during the send (subsequent chat appears in the group)
		const chatsListener = autorun(reader => {
			session.chats.read(reader);
			setActiveChatToLast();
		});

		try {
			const provider = this._getProvider(session);
			if (!provider) {
				throw new Error(`Sessions provider '${session.providerId}' not found`);
			}
			const updatedSession = await provider.sendAndCreateChat(session.sessionId, options);
			if (updatedSession.sessionId !== session.sessionId && this._activeSession.get()?.sessionId === session.sessionId) {
				this.logService.info(`[SessionsManagement] sendAndCreateChat: active session replaced: ${session.sessionId} -> ${updatedSession.sessionId}`);
				this.setActiveSession(updatedSession);
				setActiveChatToLast();
			}
		} finally {
			chatsListener.dispose();
		}
	}

	openNewSessionView(): void {
		// No-op if the current session is already a new session
		if (this.isNewChatSessionContext.get()) {
			return;
		}
		this.setActiveSession(undefined);
		this.isNewChatSessionContext.set(true);
	}

	private setActiveSession(session: ISession | undefined): void {
		if (this._activeSession.get()?.sessionId === session?.sessionId) {
			return;
		}

		// Update context keys from session data
		this._activeSessionProviderId.set(session?.providerId ?? '');
		this._activeSessionType.set(session?.sessionType ?? '');
		this._isBackgroundProvider.set(session?.sessionType === COPILOT_CLI_SESSION_TYPE);
		const provider = session ? this.sessionsProvidersService.getProviders().find(p => p.id === session.providerId) : undefined;
		this._supportsMultiChat.set(provider?.capabilities.multipleChatsPerSession ?? false);

		if (session && session.status.get() !== SessionStatus.Untitled) {
			this.lastSelectedSession = session.resource;
		}

		if (session) {
			this.logService.info(`[ActiveSessionService] Active session changed: ${session.resource.toString()}`);
		} else {
			this.logService.trace('[ActiveSessionService] Active session cleared');
		}

		this._activeSessionDisposables.clear();

		if (session) {
			// Create the active chat observable, defaulting to the first chat
			const activeChatObs = observableValue<IChat>(`activeChat-${session.sessionId}`, session.chats.get()[0]);
			this._activeChatObservable = activeChatObs;
			const activeSession: IActiveSession = {
				...session,
				activeChat: activeChatObs,
			};

			this._activeSession.set(activeSession, undefined);

			// Listen for the active session becoming archived
			if (!session.isArchived.get()) {
				this._activeSessionDisposables.add(autorun(reader => {
					if (session.isArchived.read(reader)) {
						this.openNewSessionView();
					}
				}));
			}
		} else {
			this._activeChatObservable = undefined;
			this._activeSession.set(undefined, undefined);
		}
	}

	private loadLastSelectedSession(): URI | undefined {
		const cached = this.storageService.get(LAST_SELECTED_SESSION_KEY, StorageScope.WORKSPACE);
		if (!cached) {
			return undefined;
		}

		try {
			return URI.parse(cached);
		} catch {
			return undefined;
		}
	}

	private saveLastSelectedSession(): void {
		if (this.lastSelectedSession) {
			this.storageService.store(LAST_SELECTED_SESSION_KEY, this.lastSelectedSession.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	// -- Session Actions --

	private _getProvider(session: ISession): ISessionsProvider | undefined {
		return this.sessionsProvidersService.getProviders().find(p => p.id === session.providerId);
	}

	async archiveSession(session: ISession): Promise<void> {
		await this._runManagementCommand(session, SessionsManagementCommandId.ArchiveSession, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
		}]);
	}

	async unarchiveSession(session: ISession): Promise<void> {
		await this._runManagementCommand(session, SessionsManagementCommandId.UnarchiveSession, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
		}]);
	}

	async deleteSession(session: ISession): Promise<void> {
		await this._runManagementCommand(session, SessionsManagementCommandId.DeleteSession, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
		}]);
	}

	async deleteChat(session: ISession, chatUri: URI): Promise<void> {
		await this._runManagementCommand(session, SessionsManagementCommandId.DeleteChat, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
			chatUri,
		}]);
	}

	async renameChat(session: ISession, chatUri: URI, title: string): Promise<void> {
		await this._runManagementCommand(session, SessionsManagementCommandId.RenameChat, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
			chatUri,
			title,
		}]);
	}

	setRead(session: ISession, read: boolean): void {
		void this._runManagementCommand(session, SessionsManagementCommandId.SetRead, [{
			providerId: session.providerId,
			sessionId: session.sessionId,
			read,
		}]).catch(error => {
			this.logService.warn('[SessionsManagement] Failed to update read state through Sessions action mediation.', error);
		});
	}

	private async _runManagementCommand(session: ISession, command: SessionsManagementCommandId, args: readonly unknown[]): Promise<void> {
		const result = await this.submitAction(session, {
			kind: SessionActionKind.RunCommand,
			requestedBy: SessionActionRequestSource.User,
			command,
			args,
			launchKind: SessionCommandLaunchKind.Command,
		});

		if (result.status !== SessionActionStatus.Executed) {
			throw new Error(result.summary ?? `Sessions management command '${command}' did not execute successfully.`);
		}
	}
}

function getSessionsProvider(service: ISessionsProvidersService, providerId: string): ISessionsProvider {
	const provider = service.getProvider(providerId);
	if (!provider) {
		throw new Error(`Sessions provider '${providerId}' not found`);
	}

	return provider;
}

CommandsRegistry.registerCommand(SessionsManagementCommandId.ArchiveSession, async (accessor, args: ISessionMutationCommandArgs) => {
	await getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).archiveSession(args.sessionId);
});

CommandsRegistry.registerCommand(SessionsManagementCommandId.UnarchiveSession, async (accessor, args: ISessionMutationCommandArgs) => {
	await getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).unarchiveSession(args.sessionId);
});

CommandsRegistry.registerCommand(SessionsManagementCommandId.DeleteSession, async (accessor, args: ISessionMutationCommandArgs) => {
	await getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).deleteSession(args.sessionId);
});

CommandsRegistry.registerCommand(SessionsManagementCommandId.DeleteChat, async (accessor, args: IChatMutationCommandArgs) => {
	await getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).deleteChat(args.sessionId, URI.revive(args.chatUri));
});

CommandsRegistry.registerCommand(SessionsManagementCommandId.RenameChat, async (accessor, args: IRenameChatCommandArgs) => {
	await getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).renameChat(args.sessionId, URI.revive(args.chatUri), args.title);
});

CommandsRegistry.registerCommand(SessionsManagementCommandId.SetRead, (accessor, args: ISetReadCommandArgs) => {
	getSessionsProvider(accessor.get(ISessionsProvidersService), args.providerId).setRead(args.sessionId, args.read);
});

registerSingleton(ISessionsManagementService, SessionsManagementService, InstantiationType.Delayed);
