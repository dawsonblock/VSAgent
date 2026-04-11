/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { AgentSession, type IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import { toAgentHostUri } from '../../../../../../platform/agentHost/common/agentHostUri.js';
import { ActionType, isSessionAction } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import type { ISessionFileDiff } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { ChatSessionStatus, IChatSessionFileChange2, IChatSessionItem, IChatSessionItemController, IChatSessionItemsDelta } from '../../../common/chatSessionsService.js';
import { getAgentHostIcon } from '../agentSessions.js';

function mapDiffsToChanges(diffs: readonly ISessionFileDiff[] | readonly { readonly uri: string; readonly added?: number; readonly removed?: number }[] | undefined, connectionAuthority: string): readonly IChatSessionFileChange2[] | undefined {
	if (!diffs || diffs.length === 0) {
		return undefined;
	}
	return diffs.map(d => ({
		uri: toAgentHostUri(URI.parse(d.uri), connectionAuthority),
		insertions: d.added ?? 0,
		deletions: d.removed ?? 0,
	}));
}

/**
 * Provides session list items for the chat sessions sidebar by querying
 * active sessions from an agent host connection. Listens to protocol
 * notifications for incremental updates.
 *
 * Works with both local and remote agent host connections via the
 * {@link IAgentConnection} interface.
 */
export class AgentHostSessionListController extends Disposable implements IChatSessionItemController {

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<IChatSessionItemsDelta>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private _items: IChatSessionItem[] = [];

	constructor(
		private readonly _sessionType: string,
		private readonly _provider: string,
		private readonly _connection: IAgentConnection,
		private readonly _description: string | undefined,
		private readonly _connectionAuthority: string,
		@IProductService private readonly _productService: IProductService,
	) {
		super();

		// React to protocol notifications for session list changes
		this._register(this._connection.onDidNotification(n => {
			if (n.type === 'notify/sessionAdded' && n.summary.provider === this._provider) {
				const item = this._toItemFromNotification(n.summary);
				this._items.push(item);
				this._onDidChangeChatSessionItems.fire({ addedOrUpdated: [item] });
			} else if (n.type === 'notify/sessionRemoved' && AgentSession.provider(n.session) === this._provider) {
				const removedId = AgentSession.id(n.session);
				const idx = this._items.findIndex(item => item.resource.path === `/${removedId}`);
				if (idx >= 0) {
					const [removed] = this._items.splice(idx, 1);
					this._onDidChangeChatSessionItems.fire({ removed: [removed.resource] });
				}
			}
		}));

		// Refresh on turnComplete and diffsChanged actions for metadata updates
		this._register(this._connection.onDidAction(e => {
			if (!isSessionAction(e.action) || AgentSession.provider(e.action.session) !== this._provider) {
				return;
			}

			switch (e.action.type) {
				case ActionType.SessionTurnComplete:
				case ActionType.SessionDiffsChanged: {
					const cts = new CancellationTokenSource();
					this.refresh(cts.token).finally(() => cts.dispose());
					break;
				}
				case ActionType.SessionTitleChanged: {
					const action = e.action;
					this._updateItem(AgentSession.id(action.session), item => ({ ...item, label: action.title }));
					break;
				}
				case ActionType.SessionIsReadChanged: {
					const action = e.action;
					this._updateItem(AgentSession.id(action.session), item => ({ ...item, read: action.isRead }));
					break;
				}
				case ActionType.SessionIsDoneChanged: {
					const action = e.action;
					this._updateItem(AgentSession.id(action.session), item => ({ ...item, archived: action.isDone }));
					break;
				}
			}
		}));
	}

	get items(): readonly IChatSessionItem[] {
		return this._items;
	}

	setChatSessionArchived(sessionResource: URI, archived: boolean): boolean {
		const rawId = this._rawIdFromResource(sessionResource);
		if (!rawId) {
			return false;
		}

		this._connection.dispatch({
			type: ActionType.SessionIsDoneChanged,
			session: AgentSession.uri(this._provider, rawId).toString(),
			isDone: archived,
		});
		return true;
	}

	setChatSessionRead(sessionResource: URI, read: boolean): boolean {
		const rawId = this._rawIdFromResource(sessionResource);
		if (!rawId) {
			return false;
		}

		this._connection.dispatch({
			type: ActionType.SessionIsReadChanged,
			session: AgentSession.uri(this._provider, rawId).toString(),
			isRead: read,
		});
		return true;
	}

	async renameChatSession(sessionResource: URI, title: string): Promise<boolean> {
		const rawId = this._rawIdFromResource(sessionResource);
		if (!rawId) {
			return false;
		}

		this._connection.dispatch({
			type: ActionType.SessionTitleChanged,
			session: AgentSession.uri(this._provider, rawId).toString(),
			title,
		});
		return true;
	}

	async deleteChatSession(sessionResource: URI): Promise<boolean> {
		const rawId = this._rawIdFromResource(sessionResource);
		if (!rawId) {
			return false;
		}

		await this._connection.disposeSession(AgentSession.uri(this._provider, rawId));
		return true;
	}

	async refresh(_token: CancellationToken): Promise<void> {
		try {
			const sessions = await this._connection.listSessions();
			const filtered = sessions.filter(s => AgentSession.provider(s.session) === this._provider);
			this._items = filtered.map(s => this._toItemFromMetadata(s));
		} catch {
			this._items = [];
		}
		this._onDidChangeChatSessionItems.fire({ addedOrUpdated: this._items });
	}

	private _toItemFromNotification(summary: { readonly resource: string; readonly title?: string; readonly createdAt: number; readonly modifiedAt: number; readonly workingDirectory?: string; readonly diffs?: readonly ISessionFileDiff[] | readonly { readonly uri: string; readonly added?: number; readonly removed?: number }[]; readonly isDone?: boolean; readonly isRead?: boolean }): IChatSessionItem {
		const rawId = AgentSession.id(summary.resource);
		const workingDir = typeof summary.workingDirectory === 'string' ? URI.parse(summary.workingDirectory) : undefined;
		return {
			resource: URI.from({ scheme: this._sessionType, path: `/${rawId}` }),
			label: summary.title ?? `Session ${rawId.substring(0, 8)}`,
			description: this._description,
			iconPath: getAgentHostIcon(this._productService),
			status: ChatSessionStatus.Completed,
			metadata: this._buildMetadata(workingDir),
			timing: {
				created: summary.createdAt,
				lastRequestStarted: summary.modifiedAt,
				lastRequestEnded: summary.modifiedAt,
			},
			changes: mapDiffsToChanges(summary.diffs, this._connectionAuthority),
			archived: summary.isDone,
			read: summary.isRead,
		};
	}

	private _toItemFromMetadata(metadata: { readonly session: URI; readonly startTime: number; readonly modifiedTime: number; readonly summary?: string; readonly workingDirectory?: URI; readonly diffs?: readonly { readonly uri: string; readonly added?: number; readonly removed?: number }[]; readonly isRead?: boolean; readonly isDone?: boolean }): IChatSessionItem {
		const rawId = AgentSession.id(metadata.session);
		return {
			resource: URI.from({ scheme: this._sessionType, path: `/${rawId}` }),
			label: metadata.summary ?? `Session ${rawId.substring(0, 8)}`,
			description: this._description,
			iconPath: getAgentHostIcon(this._productService),
			status: ChatSessionStatus.Completed,
			metadata: this._buildMetadata(metadata.workingDirectory),
			timing: {
				created: metadata.startTime,
				lastRequestStarted: metadata.modifiedTime,
				lastRequestEnded: metadata.modifiedTime,
			},
			changes: mapDiffsToChanges(metadata.diffs, this._connectionAuthority),
			archived: metadata.isDone,
			read: metadata.isRead,
		};
	}

	private _updateItem(rawId: string, update: (item: IChatSessionItem) => IChatSessionItem): void {
		const index = this._items.findIndex(item => item.resource.path === `/${rawId}`);
		if (index < 0) {
			return;
		}

		const updatedItem = update(this._items[index]);
		this._items[index] = updatedItem;
		this._onDidChangeChatSessionItems.fire({ addedOrUpdated: [updatedItem] });
	}

	private _rawIdFromResource(sessionResource: URI): string | undefined {
		if (sessionResource.scheme !== this._sessionType) {
			return undefined;
		}

		return sessionResource.path.startsWith('/') ? sessionResource.path.substring(1) : sessionResource.path;
	}

	private _buildMetadata(workingDirectory?: URI): { readonly [key: string]: unknown } | undefined {
		if (!this._description) {
			return undefined;
		}
		const result: { [key: string]: unknown } = { remoteAgentHost: this._description };
		if (workingDirectory) {
			result.workingDirectoryPath = workingDirectory.fsPath;
		}
		return result;
	}
}
