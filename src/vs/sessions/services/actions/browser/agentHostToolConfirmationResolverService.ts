/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { AgentSession } from '../../../../platform/agentHost/common/agentService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IActiveSession, ISessionsManagementService } from '../../sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import { ISessionActionService } from '../common/sessionActionService.js';
import { SessionAction, SessionActionKind, SessionActionRequestSource, SessionActionStatus, SessionHostKind } from '../common/sessionActionTypes.js';
import { AgentHostToolConfirmationSource, IAgentHostToolConfirmationResolverRequest, IAgentHostToolConfirmationResolverService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostToolConfirmationResolverService.js';
import { IAgentHostToolConfirmationResolution } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.js';
import { IChatToolInvocation, ToolConfirmKind } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';

export class SessionsAgentHostToolConfirmationResolverService implements IAgentHostToolConfirmationResolverService {
	declare readonly _serviceBrand: undefined;

	private static readonly _readOnlyToolIds = new Set([
		'glob',
		'grep',
		'list_dir',
		'read_file',
		'search',
		'view',
	]);

	private static readonly _commandToolIds = new Set([
		'bash',
		'powershell',
		'run_in_terminal',
		'shell',
		'terminal',
	]);

	private static readonly _writeToolIds = new Set([
		'apply_patch',
		'create_file',
		'delete_file',
		'edit',
		'edit_file',
		'move_file',
		'patch',
		'rename_file',
		'write',
		'write_file',
	]);

	private static readonly _pathLikeKeys = new Set([
		'destination',
		'destinationPath',
		'file',
		'filePath',
		'newPath',
		'oldPath',
		'path',
		'targetPath',
		'uri',
	]);

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@ISessionActionService private readonly _sessionActionService: ISessionActionService,
	) { }

	async resolveToolConfirmation(request: IAgentHostToolConfirmationResolverRequest): Promise<IAgentHostToolConfirmationResolution | undefined> {
		if (request.confirmedReason.type === ToolConfirmKind.Denied || request.confirmedReason.type === ToolConfirmKind.Skipped) {
			return undefined;
		}

		const activeSession = this._sessionsManagementService.activeSession.get();
		if (!activeSession) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.noActiveSession', "Sessions couldn't confirm tool '{0}' because there is no active session context.", request.invocation.toolId));
		}

		const capabilities = this._sessionsProvidersService.getProviderCapabilities(activeSession.providerId, activeSession.sessionId);
		if (!capabilities) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.noCapabilities', "Sessions couldn't confirm tool '{0}' because the active provider did not report its capabilities.", request.invocation.toolId));
		}

		const expectedHostKind = request.source === AgentHostToolConfirmationSource.Local ? SessionHostKind.Local : SessionHostKind.Remote;
		if (capabilities.hostKind !== expectedHostKind) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.hostKindMismatch', "Sessions couldn't confirm tool '{0}' because the active session no longer matches this agent-host connection.", request.invocation.toolId));
		}

		if (!this._matchesActiveSession(activeSession, request.session)) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.sessionChanged', "Sessions couldn't confirm tool '{0}' because the active session changed before approval completed.", request.invocation.toolId));
		}

		const mediation = this._toMediatedAction(activeSession, request.invocation);
		if (mediation.action) {
			const result = await this._sessionActionService.approveAction(activeSession.sessionId, activeSession.providerId, mediation.action);
			if (result.status === SessionActionStatus.Approved || result.status === SessionActionStatus.Executed) {
				return {
					confirmedReason: { type: ToolConfirmKind.UserAction },
				};
			}

			return this._deny(result.denialMessage ?? nls.localize('sessionsAgentHostConfirmation.mediatedDenied', "Sessions denied tool '{0}' after applying its mediation policy.", request.invocation.toolId));
		}

		if (mediation.denialMessage) {
			return this._deny(mediation.denialMessage);
		}

		const toolId = request.invocation.toolId.toLowerCase();
		if (SessionsAgentHostToolConfirmationResolverService._readOnlyToolIds.has(toolId)) {
			if (capabilities.canReadWorkspace) {
				return undefined;
			}

			return this._deny(nls.localize('sessionsAgentHostConfirmation.readDenied', "The active Sessions provider can't approve workspace-read tool '{0}'.", request.invocation.toolId));
		}

		if (SessionsAgentHostToolConfirmationResolverService._commandToolIds.has(toolId)) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.commandUnsupported', "Sessions couldn't derive a typed command approval for tool '{0}'.", request.invocation.toolId));
		}

		if (SessionsAgentHostToolConfirmationResolverService._writeToolIds.has(toolId)) {
			return this._deny(nls.localize('sessionsAgentHostConfirmation.writeUnsupported', "Sessions couldn't derive typed workspace targets for tool '{0}'.", request.invocation.toolId));
		}

		return this._deny(nls.localize('sessionsAgentHostConfirmation.unknownTool', "Sessions denied tool '{0}' because its confirmation flow isn't yet mediated in the shared agent-host path.", request.invocation.toolId));
	}

	private _matchesActiveSession(activeSession: IActiveSession, session: URI): boolean {
		const rawId = AgentSession.id(session);
		return activeSession.resource.path === `/${rawId}`;
	}

	private _toMediatedAction(activeSession: IActiveSession, invocation: IChatToolInvocation): { action?: SessionAction; denialMessage?: string } {
		const toolId = invocation.toolId.toLowerCase();
		const workspaceRoot = this._getWorkspaceRoot(activeSession);

		if (SessionsAgentHostToolConfirmationResolverService._commandToolIds.has(toolId)) {
			const command = this._extractCommand(invocation);
			if (!command) {
				return {
					denialMessage: nls.localize('sessionsAgentHostConfirmation.commandMissing', "Sessions couldn't derive a command line for tool '{0}'.", invocation.toolId),
				};
			}

			return {
				action: {
					kind: SessionActionKind.RunCommand,
					requestedBy: SessionActionRequestSource.Session,
					command,
					cwd: workspaceRoot,
					summary: nls.localize('sessionsAgentHostConfirmation.commandSummary', "Agent-host tool '{0}' requested command approval.", invocation.toolId),
					advisorySources: ['agentHostToolConfirmation'],
				},
			};
		}

		if (SessionsAgentHostToolConfirmationResolverService._writeToolIds.has(toolId)) {
			if (!workspaceRoot) {
				return {
					denialMessage: nls.localize('sessionsAgentHostConfirmation.writeNoWorkspace', "Sessions couldn't derive workspace targets for tool '{0}' because the active session has no workspace root.", invocation.toolId),
				};
			}

			const files = this._extractFiles(invocation, workspaceRoot);
			if (files.length === 0) {
				return {
					denialMessage: nls.localize('sessionsAgentHostConfirmation.writeMissing', "Sessions couldn't derive workspace targets for tool '{0}'.", invocation.toolId),
				};
			}

			return {
				action: {
					kind: SessionActionKind.WritePatch,
					requestedBy: SessionActionRequestSource.Session,
					patch: invocation.toolId,
					files,
					summary: nls.localize('sessionsAgentHostConfirmation.writeSummary', "Agent-host tool '{0}' requested workspace-write approval.", invocation.toolId),
					advisorySources: ['agentHostToolConfirmation'],
				},
			};
		}

		return {};
	}

	private _extractCommand(invocation: IChatToolInvocation): string | undefined {
		const parameters = this._asRecord(this._getInvocationParameters(invocation));
		if (typeof parameters?.command === 'string' && parameters.command.trim().length > 0) {
			return parameters.command.trim();
		}

		const rawInput = this._getRawInput(invocation);
		return rawInput?.trim();
	}

	private _extractFiles(invocation: IChatToolInvocation, workspaceRoot: URI): URI[] {
		const candidates: string[] = [];
		this._collectPathCandidates(this._getInvocationParameters(invocation), candidates);

		const rawInput = this._getRawInput(invocation);
		if (rawInput) {
			this._collectPathCandidates(rawInput, candidates);
		}

		const seen = new Set<string>();
		const results: URI[] = [];
		for (const candidate of candidates) {
			const resource = this._toWorkspaceUri(candidate, workspaceRoot);
			if (!resource) {
				continue;
			}

			const key = resource.toString();
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			results.push(resource);
		}

		return results;
	}

	private _collectPathCandidates(value: unknown, results: string[]): void {
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (!trimmed) {
				return;
			}

			if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
				try {
					this._collectPathCandidates(JSON.parse(trimmed), results);
					return;
				} catch {
					// Fall through and treat the string as a possible path.
				}
			}

			return;
		}

		if (!value || typeof value !== 'object') {
			return;
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				this._collectPathCandidates(entry, results);
			}
			return;
		}

		for (const [key, entry] of Object.entries(value)) {
			if (typeof entry === 'string' && SessionsAgentHostToolConfirmationResolverService._pathLikeKeys.has(key) && entry.trim().length > 0) {
				results.push(entry.trim());
				continue;
			}

			this._collectPathCandidates(entry, results);
		}
	}

	private _toWorkspaceUri(candidate: string, workspaceRoot: URI): URI | undefined {
		try {
			if (candidate.includes('://')) {
				return URI.parse(candidate);
			}

			if (candidate.startsWith('/')) {
				return workspaceRoot.with({ path: candidate });
			}

			return joinPath(workspaceRoot, candidate);
		} catch {
			return undefined;
		}
	}

	private _getWorkspaceRoot(activeSession: IActiveSession): URI | undefined {
		const repository = activeSession.workspace.get()?.repositories[0];
		return repository?.workingDirectory ?? repository?.uri;
	}

	private _getInvocationParameters(invocation: IChatToolInvocation): unknown {
		const state = invocation.state.get();
		if (hasKey(state, { parameters: true })) {
			return state.parameters;
		}

		return undefined;
	}

	private _getRawInput(invocation: IChatToolInvocation): string | undefined {
		const toolSpecificData = invocation.toolSpecificData;
		if (toolSpecificData && typeof toolSpecificData === 'object' && hasKey(toolSpecificData, { rawInput: true })) {
			const rawInput = (toolSpecificData as { rawInput?: { input?: unknown } }).rawInput;
			if (rawInput && typeof rawInput === 'object' && typeof rawInput.input === 'string') {
				return rawInput.input;
			}
		}

		return undefined;
	}

	private _asRecord(value: unknown): Record<string, unknown> | undefined {
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				return undefined;
			}
		}

		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}

		return value as Record<string, unknown>;
	}

	private _deny(reasonMessage: string): IAgentHostToolConfirmationResolution {
		return {
			confirmedReason: { type: ToolConfirmKind.Denied },
			reasonMessage,
		};
	}
}

registerSingleton(IAgentHostToolConfirmationResolverService, SessionsAgentHostToolConfirmationResolverService, InstantiationType.Delayed);
