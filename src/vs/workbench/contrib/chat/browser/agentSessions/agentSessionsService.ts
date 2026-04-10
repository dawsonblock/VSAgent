/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { AgentSessionsModel, IAgentSession, IAgentSessionsModel } from './agentSessionsModel.js';

export interface IAgentSessionsService {

	readonly _serviceBrand: undefined;

	readonly model: IAgentSessionsModel;
	readonly onDidChangeSessionArchivedState: Event<IAgentSession>;

	getSession(resource: URI): IAgentSession | undefined;
	setSessionArchived(session: IAgentSession | URI, archived: boolean): boolean;
	setSessionRead(session: IAgentSession | URI, read: boolean): boolean;
	renameSession(session: IAgentSession | URI, title: string): Promise<boolean>;
	deleteSession(session: IAgentSession | URI): Promise<boolean>;
}

export class AgentSessionsService extends Disposable implements IAgentSessionsService {

	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeSessionArchivedState = this._register(new Emitter<IAgentSession>());
	readonly onDidChangeSessionArchivedState = this._onDidChangeSessionArchivedState.event;

	private _model: IAgentSessionsModel | undefined;
	get model(): IAgentSessionsModel {
		if (!this._model) {
			this._model = this._register(this.instantiationService.createInstance(AgentSessionsModel));
			this._register(this._model.onDidChangeSessionArchivedState(session => {
				if (session.isArchived()) {
					void this.chatService.cancelCurrentRequestForSession(session.resource, 'archive');
				}

				this._onDidChangeSessionArchivedState.fire(session);
			}));
			this._model.resolve(undefined /* all providers */);
		}

		return this._model;
	}

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
	) {
		super();
	}

	getSession(resource: URI): IAgentSession | undefined {
		return this.model.getSession(resource);
	}

	setSessionArchived(session: IAgentSession | URI, archived: boolean): boolean {
		const sessionItem = URI.isUri(session) ? this.getSession(session) : session;
		if (!sessionItem) {
			return false;
		}

		if (this.chatSessionsService.setChatSessionArchived?.(sessionItem.resource, archived)) {
			return true;
		}

		sessionItem.setArchived(archived);
		return true;
	}

	setSessionRead(session: IAgentSession | URI, read: boolean): boolean {
		const sessionItem = URI.isUri(session) ? this.getSession(session) : session;
		if (!sessionItem) {
			return false;
		}

		if (this.chatSessionsService.setChatSessionRead?.(sessionItem.resource, read)) {
			return true;
		}

		sessionItem.setRead(read);
		return true;
	}

	async renameSession(session: IAgentSession | URI, title: string): Promise<boolean> {
		const sessionItem = URI.isUri(session) ? this.getSession(session) : session;
		if (!sessionItem) {
			return false;
		}

		if (await this.chatSessionsService.renameChatSession?.(sessionItem.resource, title)) {
			return true;
		}

		await this.chatService.setChatSessionTitle(sessionItem.resource, title);
		return true;
	}

	async deleteSession(session: IAgentSession | URI): Promise<boolean> {
		const sessionItem = URI.isUri(session) ? this.getSession(session) : session;
		if (!sessionItem) {
			return false;
		}

		if (await this.chatSessionsService.deleteChatSession?.(sessionItem.resource)) {
			return true;
		}

		await this.chatService.removeHistoryEntry(sessionItem.resource);
		return true;
	}
}

export const IAgentSessionsService = createDecorator<IAgentSessionsService>('agentSessions');
