/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { parse } from '../../../../base/common/jsonc.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SessionPolicySnapshot } from '../common/sessionActionPolicy.js';
import { SessionActionExecutionContext } from '../common/sessionActionTypes.js';

const defaultSecretLikeSegments = [
	'.aws',
	'.azure',
	'.env',
	'.env.local',
	'.gnupg',
	'.kube',
	'.npmrc',
	'.pypirc',
	'.ssh',
	'id_ed25519',
	'id_rsa',
];

const defaultCommandAllowPatterns = [
	/^_git\./,
	/^_sessions\./,
	/^github\.copilot\.cli\.sessions\./,
];

const defaultCommandDenyPatterns = [
	/&&/,
	/\|\|/,
	/;/,
	/(^|\s)sudo(\s|$)/,
];

interface ISessionActionPolicyFileConfig {
	readonly deniedRoots?: readonly string[];
	readonly secretLikePathSegments?: readonly string[];
	readonly commandAllowPatterns?: readonly string[];
	readonly commandDenyPatterns?: readonly string[];
	readonly allowWorkspaceReads?: boolean;
	readonly allowWorkspaceWrites?: boolean;
	readonly allowCommands?: boolean;
	readonly allowGitMutation?: boolean;
	readonly allowWorktreeMutation?: boolean;
	readonly approvalMode?: 'default' | 'always';
}

interface IPolicyCacheEntry {
	readonly key: string;
	readonly policyRoot: URI;
	readonly policyUri: URI;
	watcher?: IDisposable;
	dirty: boolean;
	snapshot: SessionPolicySnapshot;
}

export function getDefaultSessionPolicySnapshot(allowedRoots: readonly URI[]): SessionPolicySnapshot {
	return {
		allowedRoots,
		deniedRoots: [],
		secretLikePathSegments: defaultSecretLikeSegments,
		commandAllowPatterns: defaultCommandAllowPatterns,
		commandDenyPatterns: defaultCommandDenyPatterns,
		allowWorkspaceReads: true,
		allowWorkspaceWrites: false,
		allowCommands: false,
		allowGitMutation: false,
		allowWorktreeMutation: false,
		approvalMode: 'default',
	};
}

export function getSessionActionPolicyRoot(executionContext: SessionActionExecutionContext): URI | undefined {
	return executionContext.worktreeRoot ?? executionContext.projectRoot ?? executionContext.repositoryPath ?? executionContext.workspaceRoot;
}

export interface ISessionActionPolicyConfigService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePolicy: Event<URI | undefined>;
	getPolicySnapshot(executionContext: SessionActionExecutionContext, allowedRoots: readonly URI[]): Promise<SessionPolicySnapshot>;
}

export const ISessionActionPolicyConfigService = createDecorator<ISessionActionPolicyConfigService>('sessionActionPolicyConfigService');

export class SessionActionPolicyConfigService extends Disposable implements ISessionActionPolicyConfigService {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, IPolicyCacheEntry>();
	private readonly _onDidChangePolicy = this._register(new Emitter<URI | undefined>());
	readonly onDidChangePolicy = this._onDidChangePolicy.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async getPolicySnapshot(executionContext: SessionActionExecutionContext, allowedRoots: readonly URI[]): Promise<SessionPolicySnapshot> {
		const policyRoot = getSessionActionPolicyRoot(executionContext);
		if (!policyRoot) {
			return getDefaultSessionPolicySnapshot(allowedRoots);
		}

		const policyUri = joinPath(policyRoot, '.vscode', 'vsagent-policy.json');
		const entry = this._getOrCreateEntry(policyRoot, policyUri, allowedRoots);
		if (entry.dirty) {
			entry.snapshot = await this._loadSnapshot(entry, allowedRoots);
			entry.dirty = false;
		}

		return {
			...entry.snapshot,
			allowedRoots,
		};
	}

	private _getOrCreateEntry(policyRoot: URI, policyUri: URI, allowedRoots: readonly URI[]): IPolicyCacheEntry {
		const key = policyUri.toString();
		let entry = this._entries.get(key);
		if (entry) {
			return entry;
		}

		entry = {
			key,
			policyRoot,
			policyUri,
			dirty: true,
			snapshot: getDefaultSessionPolicySnapshot(allowedRoots),
		};
		entry.watcher = this._fileService.watch(policyUri);
		this._entries.set(key, entry);

		const fileChangeListener = this._fileService.onDidFilesChange(e => {
			if (!e.affects(policyUri)) {
				return;
			}

			entry.dirty = true;
			this._onDidChangePolicy.fire(policyUri);
		});

		this._register(toDisposable(() => fileChangeListener.dispose()));
		this._register(toDisposable(() => {
			entry.watcher?.dispose();
			this._entries.delete(key);
		}));

		return entry;
	}

	private async _loadSnapshot(entry: IPolicyCacheEntry, allowedRoots: readonly URI[]): Promise<SessionPolicySnapshot> {
		const fallback = getDefaultSessionPolicySnapshot(allowedRoots);
		try {
			if (!(await this._fileService.exists(entry.policyUri))) {
				return fallback;
			}

			const contents = await this._fileService.readFile(entry.policyUri);
			const rawConfig = parse<ISessionActionPolicyFileConfig>(contents.value.toString()) ?? {};
			return this._resolveSnapshot(rawConfig, entry.policyRoot, allowedRoots);
		} catch (error) {
			this._logService.warn('[SessionActionPolicyConfigService] Failed to load policy config', entry.policyUri.toString(), error);
			return fallback;
		}
	}

	private _resolveSnapshot(rawConfig: ISessionActionPolicyFileConfig, policyRoot: URI, allowedRoots: readonly URI[]): SessionPolicySnapshot {
		const fallback = getDefaultSessionPolicySnapshot(allowedRoots);
		return {
			allowedRoots,
			deniedRoots: this._resolveDeniedRoots(rawConfig.deniedRoots, policyRoot),
			secretLikePathSegments: this._coerceStringArray(rawConfig.secretLikePathSegments, fallback.secretLikePathSegments),
			commandAllowPatterns: this._compilePatterns(rawConfig.commandAllowPatterns, fallback.commandAllowPatterns, 'commandAllowPatterns'),
			commandDenyPatterns: this._compilePatterns(rawConfig.commandDenyPatterns, fallback.commandDenyPatterns, 'commandDenyPatterns'),
			allowWorkspaceReads: this._coerceBoolean(rawConfig.allowWorkspaceReads, fallback.allowWorkspaceReads),
			allowWorkspaceWrites: this._coerceBoolean(rawConfig.allowWorkspaceWrites, fallback.allowWorkspaceWrites),
			allowCommands: this._coerceBoolean(rawConfig.allowCommands, fallback.allowCommands),
			allowGitMutation: this._coerceBoolean(rawConfig.allowGitMutation, fallback.allowGitMutation),
			allowWorktreeMutation: this._coerceBoolean(rawConfig.allowWorktreeMutation, fallback.allowWorktreeMutation),
			approvalMode: rawConfig.approvalMode === 'always' ? 'always' : fallback.approvalMode,
		};
	}

	private _resolveDeniedRoots(values: readonly string[] | undefined, policyRoot: URI): readonly URI[] {
		if (!Array.isArray(values)) {
			return [];
		}

		return values.filter((value): value is string => typeof value === 'string' && value.length > 0).map(value => this._resolvePolicyPath(policyRoot, value));
	}

	private _resolvePolicyPath(policyRoot: URI, value: string): URI {
		const isUriValue = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value);
		if (isUriValue) {
			return URI.parse(value);
		}

		return joinPath(policyRoot, value);
	}

	private _coerceBoolean(value: boolean | undefined, fallback: boolean): boolean {
		return typeof value === 'boolean' ? value : fallback;
	}

	private _coerceStringArray(value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
		if (!Array.isArray(value)) {
			return fallback;
		}

		const filtered = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
		return filtered.length > 0 ? filtered : fallback;
	}

	private _compilePatterns(value: readonly string[] | undefined, fallback: readonly RegExp[], field: keyof Pick<ISessionActionPolicyFileConfig, 'commandAllowPatterns' | 'commandDenyPatterns'>): readonly RegExp[] {
		if (!Array.isArray(value)) {
			return fallback;
		}

		const compiled: RegExp[] = [];
		for (const entry of value) {
			if (typeof entry !== 'string' || entry.length === 0) {
				continue;
			}

			try {
				compiled.push(new RegExp(entry));
			} catch (error) {
				this._logService.warn(`[SessionActionPolicyConfigService] Ignoring invalid ${field} regex`, entry, error);
			}
		}

		return compiled.length > 0 ? compiled : fallback;
	}
}

registerSingleton(ISessionActionPolicyConfigService, SessionActionPolicyConfigService, InstantiationType.Delayed);
