/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ProviderCapabilitySet } from '../common/sessionActionPolicy.js';
import { ISessionActionScopeService, NormalizedSessionActionScope, SessionActionScopeResolution } from '../common/sessionActionScope.js';
import { NormalizedPathScope, ReadFileAction, RunCommandAction, SessionAction, SessionActionDenialReason, SessionActionExecutionContext, SessionActionKind, SessionActionScope, WritePatchAction } from '../common/sessionActionTypes.js';

const secretLikePathSegments = new Set([
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
]);

export class SessionActionScopeService implements ISessionActionScopeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
	) { }

	resolveScope(action: SessionAction, executionContext: SessionActionExecutionContext, providerCapabilities: ProviderCapabilitySet): SessionActionScopeResolution {
		const requestedScope = action.scope ?? {};
		const hostTarget = {
			kind: providerCapabilities.hostKind,
			providerId: executionContext.providerId,
			authority: executionContext.hostTarget.authority,
		};

		if (requestedScope.hostTarget?.kind && requestedScope.hostTarget.kind !== hostTarget.kind) {
			return {
				denialReason: SessionActionDenialReason.HostTargetMismatch,
				message: 'Requested host kind does not match the provider host kind.',
			};
		}

		if (requestedScope.hostTarget?.authority && requestedScope.hostTarget.authority !== hostTarget.authority) {
			return {
				denialReason: SessionActionDenialReason.HostTargetMismatch,
				message: 'Requested host authority does not match the provider host authority.',
			};
		}

		const roots = this._distinctUris([
			executionContext.workspaceRoot,
			executionContext.projectRoot,
			executionContext.repositoryPath,
			executionContext.worktreeRoot,
		]);

		const scope: NormalizedSessionActionScope = {
			requestedScope,
			workspaceRoot: this._normalizePath(requestedScope.workspaceRoot ?? executionContext.workspaceRoot, true),
			projectRoot: this._normalizePath(requestedScope.projectRoot ?? executionContext.projectRoot ?? executionContext.workspaceRoot, true),
			repositoryPath: this._normalizePath(this._getRepositoryPath(action, requestedScope, executionContext), true),
			worktreeRoot: this._normalizePath(this._getWorktreePath(action, requestedScope, executionContext), true),
			cwd: this._normalizePath(this._getCwd(action, requestedScope, executionContext), true),
			files: this._getFiles(action).map(resource => this._normalizePath(resource, false)).filter((value): value is NormalizedPathScope => !!value),
			hostTarget,
		};

		if (requestedScope.worktreeRoot && executionContext.worktreeRoot) {
			const requestedWorktree = this._normalizePath(requestedScope.worktreeRoot, true);
			const actualWorktree = this._normalizePath(executionContext.worktreeRoot, true);
			if (requestedWorktree && actualWorktree && !this._uriIdentityService.extUri.isEqual(requestedWorktree.path, actualWorktree.path)) {
				return {
					denialReason: SessionActionDenialReason.WorktreeMismatch,
					message: 'Requested worktree root does not match the active session worktree.',
				};
			}
		}

		for (const path of this._collectPaths(scope)) {
			if (this._isSecretLikePath(path.path)) {
				return {
					denialReason: SessionActionDenialReason.SecretPath,
					message: `Access to secret-like path '${basename(path.path)}' is denied.`,
				};
			}

			if (roots.length > 0 && !roots.some(root => this._uriIdentityService.extUri.isEqualOrParent(path.path, root))) {
				return {
					denialReason: SessionActionDenialReason.RootEscape,
					message: `Path '${path.path.toString()}' is outside the active session roots.`,
				};
			}
		}

		if (action.kind === SessionActionKind.WritePatch && scope.files.length === 0) {
			return {
				denialReason: SessionActionDenialReason.InvalidPathScope,
				message: 'Write actions must declare at least one target file.',
			};
		}

		return { scope };
	}

	private _normalizePath(resource: URI | undefined, isDirectory: boolean): NormalizedPathScope | undefined {
		if (!resource) {
			return undefined;
		}

		const canonical = this._uriIdentityService.asCanonicalUri(resource);
		return {
			path: canonical,
			isDirectory,
			label: basename(canonical),
		};
	}

	private _distinctUris(resources: (URI | undefined)[]): URI[] {
		const result: URI[] = [];
		for (const resource of resources) {
			if (!resource) {
				continue;
			}
			const canonical = this._uriIdentityService.asCanonicalUri(resource);
			if (!result.some(entry => this._uriIdentityService.extUri.isEqual(entry, canonical))) {
				result.push(canonical);
			}
		}
		return result;
	}

	private _collectPaths(scope: NormalizedSessionActionScope): NormalizedPathScope[] {
		const result = [...scope.files];
		for (const candidate of [scope.cwd, scope.repositoryPath, scope.worktreeRoot]) {
			if (candidate) {
				result.push(candidate);
			}
		}
		return result;
	}

	private _getFiles(action: SessionAction): readonly URI[] {
		switch (action.kind) {
			case SessionActionKind.ReadFile:
				return [(action as ReadFileAction).resource];
			case SessionActionKind.WritePatch: {
				const writePatchAction = action as WritePatchAction;
				return this._distinctUris([
					...writePatchAction.files,
					...(writePatchAction.operations?.map(operation => operation.resource) ?? []),
				]);
			}
			default:
				return [];
		}
	}

	private _getRepositoryPath(action: SessionAction, scope: SessionActionScope, executionContext: SessionActionExecutionContext): URI | undefined {
		switch (action.kind) {
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
			case SessionActionKind.OpenWorktree:
				return action.repository;
			default:
				return scope.repositoryPath ?? executionContext.repositoryPath;
		}
	}

	private _getWorktreePath(action: SessionAction, scope: SessionActionScope, executionContext: SessionActionExecutionContext): URI | undefined {
		if (action.kind === SessionActionKind.OpenWorktree) {
			return action.worktreePath ?? scope.worktreeRoot ?? executionContext.worktreeRoot;
		}
		return scope.worktreeRoot ?? executionContext.worktreeRoot;
	}

	private _getCwd(action: SessionAction, scope: SessionActionScope, executionContext: SessionActionExecutionContext): URI | undefined {
		if (action.kind === SessionActionKind.RunCommand) {
			const commandAction = action as RunCommandAction;
			return commandAction.cwd ?? scope.cwd ?? executionContext.projectRoot ?? executionContext.workspaceRoot;
		}
		return scope.cwd ?? executionContext.projectRoot ?? executionContext.workspaceRoot;
	}

	private _isSecretLikePath(resource: URI): boolean {
		const pathSegments = resource.path.split('/').map(segment => segment.toLowerCase()).filter(segment => segment.length > 0);
		return pathSegments.some(segment => secretLikePathSegments.has(segment));
	}
}

registerSingleton(ISessionActionScopeService, SessionActionScopeService, InstantiationType.Delayed);
