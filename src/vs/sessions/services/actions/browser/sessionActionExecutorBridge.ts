/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { ISearchService, ITextQuery, QueryType, resultIsMatch } from '../../../../workbench/services/search/common/search.js';
import { localize } from '../../../../nls.js';
import { NormalizedSessionActionScope } from '../common/sessionActionScope.js';
import { GitDiffAction, GitStatusAction, OpenWorktreeAction, ReadFileAction, RunCommandAction, SearchWorkspaceAction, SessionAction, SessionActionDenialReason, SessionActionKind, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind, WritePatchAction } from '../common/sessionActionTypes.js';

export interface ISessionActionExecutorBridge {
	readonly _serviceBrand: undefined;

	supports(kind: SessionActionKind): boolean;
	execute(action: SessionAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult>;
}

export const ISessionActionExecutorBridge = createDecorator<ISessionActionExecutorBridge>('sessionActionExecutorBridge');

export class SessionActionExecutorBridge implements ISessionActionExecutorBridge {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IFileService private readonly _fileService: IFileService,
		@IGitService private readonly _gitService: IGitService,
		@ISearchService private readonly _searchService: ISearchService,
	) { }

	supports(kind: SessionActionKind): boolean {
		switch (kind) {
			case SessionActionKind.SearchWorkspace:
			case SessionActionKind.ReadFile:
			case SessionActionKind.WritePatch:
			case SessionActionKind.RunCommand:
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
			case SessionActionKind.OpenWorktree:
				return true;
			default:
				return false;
		}
	}

	async execute(action: SessionAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult> {
		switch (action.kind) {
			case SessionActionKind.SearchWorkspace:
				return this._searchWorkspace(action as SearchWorkspaceAction, scope);
			case SessionActionKind.ReadFile:
				return this._readFile(action as ReadFileAction);
			case SessionActionKind.WritePatch:
				return this._writePatch(action as WritePatchAction);
			case SessionActionKind.RunCommand:
				return this._runCommand(action as RunCommandAction, scope);
			case SessionActionKind.GitStatus:
				return this._gitStatus(action as GitStatusAction);
			case SessionActionKind.GitDiff:
				return this._gitDiff(action as GitDiffAction);
			case SessionActionKind.OpenWorktree:
				return this._openWorktree(action as OpenWorktreeAction);
			default:
				throw new Error('Unsupported Sessions action kind.');
		}
	}

	private async _searchWorkspace(action: SearchWorkspaceAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult> {
		const roots = this._getSearchRoots(scope);
		if (roots.length === 0) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.SearchWorkspace,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.InvalidPathScope,
				denialMessage: 'Could not search because no workspace root was resolved for the Sessions action.',
				advisorySources: action.advisorySources ?? [],
				summary: localize('sessionActionExecutorBridge.searchWorkspaceMissingRoot', "Could not search because no workspace root was resolved for the Sessions action."),
			};
		}

		const query: ITextQuery = {
			type: QueryType.Text,
			folderQueries: roots.map(folder => ({ folder })),
			contentPattern: {
				pattern: action.query,
				isRegExp: action.isRegexp,
			},
			includePattern: action.includePattern ? { [action.includePattern]: true } : undefined,
			maxResults: action.maxResults,
			previewOptions: {
				matchLines: 1,
				charsPerLine: 160,
			},
		};

		const complete = await this._searchService.textSearch(query, CancellationToken.None);
		const matches: Array<{ resource: URI; lineNumber?: number; preview?: string }> = [];

		for (const fileMatch of complete.results) {
			if (!fileMatch.results || fileMatch.results.length === 0) {
				matches.push({ resource: fileMatch.resource });
			} else {
				for (const result of fileMatch.results) {
					if (!resultIsMatch(result)) {
						continue;
					}

					matches.push({
						resource: fileMatch.resource,
						lineNumber: result.rangeLocations[0]?.source.startLineNumber,
						preview: result.previewText,
					});
				}
			}

			if (typeof action.maxResults === 'number' && matches.length >= action.maxResults) {
				break;
			}
		}

		const limitedMatches = typeof action.maxResults === 'number' ? matches.slice(0, action.maxResults) : matches;

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.SearchWorkspace,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			matches: limitedMatches,
			summary: localize('sessionActionExecutorBridge.searchWorkspaceSummary', "Found {0} workspace search match(es).", limitedMatches.length),
		};
	}

	private async _readFile(action: ReadFileAction): Promise<SessionActionResult> {
		const contents = await this._fileService.readFile(action.resource);
		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.ReadFile,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			resource: action.resource,
			contents: contents.value.toString(),
			summary: localize('sessionActionExecutorBridge.readFileSummary', "Read file '{0}'.", action.resource.toString()),
		};
	}

	private async _writePatch(action: WritePatchAction): Promise<SessionActionResult> {
		if (!action.operations || action.operations.length === 0) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.WritePatch,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.UnsupportedAction,
				denialMessage: 'Could not apply the requested write because no file operations were provided.',
				advisorySources: action.advisorySources ?? [],
				filesTouched: action.files,
				applied: false,
				summary: localize('sessionActionExecutorBridge.writePatchUnsupported', "Could not apply the requested write because no file operations were provided."),
			};
		}

		for (const operation of action.operations) {
			if (operation.delete) {
				await this._fileService.del(operation.resource, {
					recursive: true,
					useTrash: operation.useTrash ?? true,
				});
				continue;
			}

			if (typeof operation.contents === 'string') {
				await this._fileService.writeFile(operation.resource, VSBuffer.fromString(operation.contents));
			}
		}

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.WritePatch,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			filesTouched: action.operations.map(operation => operation.resource),
			applied: true,
			summary: localize('sessionActionExecutorBridge.writePatchSummary', "Applied file updates for {0} target(s).", action.operations.length),
		};
	}

	private async _runCommand(action: RunCommandAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult> {
		const args = this._toCommandArgs(action.args);
		const cwd = action.cwd ?? scope.cwd?.path ?? scope.worktreeRoot?.path ?? scope.repositoryPath?.path ?? scope.workspaceRoot?.path;
		const commandLine = this._toCommandLine(action.command, action.args);

		if (action.launchKind === SessionCommandLaunchKind.Task) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.UnsupportedAction,
				denialMessage: 'Task-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes.',
				advisorySources: action.advisorySources ?? [],
				command: action.command,
				args,
				cwd,
				commandLine,
				stderr: 'Task-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes.',
				summary: localize('sessionActionExecutorBridge.taskUnsupported', "Task-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes."),
			};
		}

		if (action.launchKind === SessionCommandLaunchKind.Terminal) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.UnsupportedAction,
				denialMessage: 'Terminal-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes.',
				advisorySources: action.advisorySources ?? [],
				command: action.command,
				args,
				cwd,
				commandLine,
				stderr: 'Terminal-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes.',
				summary: localize('sessionActionExecutorBridge.terminalUnsupported', "Terminal-backed command execution is not yet supported because Sessions cannot capture authoritative stdout, stderr, and exit codes."),
			};
		}

		try {
			const value = await this._commandService.executeCommand(action.command, ...(action.args ?? []));
			const stdout = this._serializeValue(value) ?? '';
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Executed,
				advisorySources: action.advisorySources ?? [],
				command: action.command,
				args,
				cwd,
				commandLine,
				exitCode: 0,
				stdout,
				stderr: '',
				value: value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'object' ? value : undefined,
				summary: localize('sessionActionExecutorBridge.commandSummary', "Executed command '{0}'.", action.command),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'An unknown error occurred while executing the command.';
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: message,
				advisorySources: action.advisorySources ?? [],
				command: action.command,
				args,
				cwd,
				commandLine,
				exitCode: 1,
				stdout: '',
				stderr: message,
				summary: localize('sessionActionExecutorBridge.commandFailed', "Command '{0}' failed.", action.command),
			};
		}
	}

	private async _gitStatus(action: GitStatusAction): Promise<SessionActionResult> {
		const repository = await this._gitService.openRepository(action.repository);
		if (!repository) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.GitStatus,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: localize('sessionActionExecutorBridge.gitStatusRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				advisorySources: action.advisorySources ?? [],
				repository: action.repository,
				stderr: localize('sessionActionExecutorBridge.gitStatusRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				summary: localize('sessionActionExecutorBridge.gitStatusRepositoryMissing', "Could not inspect git status because no repository was found for the Sessions action."),
			};
		}

		const state = repository.state.get();
		const value = {
			head: state.HEAD?.name,
			mergeChanges: state.mergeChanges.length,
			indexChanges: state.indexChanges.length,
			workingTreeChanges: state.workingTreeChanges.length,
			untrackedChanges: state.untrackedChanges.length,
		};

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.GitStatus,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			repository: action.repository,
			stdout: JSON.stringify(value, undefined, 2),
			stderr: '',
			value,
			summary: localize('sessionActionExecutorBridge.gitStatusSummary', "Inspected git status for '{0}'.", action.repository.toString()),
		};
	}

	private async _gitDiff(action: GitDiffAction): Promise<SessionActionResult> {
		const repository = await this._gitService.openRepository(action.repository);
		if (!repository) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.GitDiff,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: localize('sessionActionExecutorBridge.gitDiffRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				advisorySources: action.advisorySources ?? [],
				repository: action.repository,
				stderr: localize('sessionActionExecutorBridge.gitDiffRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				summary: localize('sessionActionExecutorBridge.gitDiffRepositoryMissing', "Could not inspect git diff because no repository was found for the Sessions action."),
			};
		}

		const ref = action.ref ?? repository.state.get().HEAD?.name ?? 'HEAD';
		const changes = await repository.diffBetweenWithStats2(ref);
		const value = changes.map(change => ({
			uri: change.uri.toString(),
			insertions: change.insertions,
			deletions: change.deletions,
		}));

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.GitDiff,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			repository: action.repository,
			stdout: value.map(change => `${change.uri} (+${change.insertions}/-${change.deletions})`).join('\n'),
			stderr: '',
			value,
			summary: localize('sessionActionExecutorBridge.gitDiffSummary', "Inspected git diff for '{0}' against '{1}'.", action.repository.toString(), ref),
		};
	}

	private async _openWorktree(action: OpenWorktreeAction): Promise<SessionActionResult> {
		const stderr = 'Worktree creation is not yet supported by the Sessions executor bridge.';
		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.OpenWorktree,
			status: SessionActionStatus.Failed,
			denialReason: SessionActionDenialReason.UnsupportedAction,
			denialMessage: stderr,
			advisorySources: action.advisorySources ?? [],
			repository: action.repository,
			worktreePath: action.worktreePath,
			branch: action.branch,
			opened: false,
			stdout: '',
			stderr,
			summary: localize('sessionActionExecutorBridge.openWorktreeUnsupported', "Worktree creation is not yet supported by the Sessions executor bridge."),
		};
	}

	private _getSearchRoots(scope: NormalizedSessionActionScope): URI[] {
		const roots = [
			scope.cwd?.path,
			scope.worktreeRoot?.path,
			scope.repositoryPath?.path,
			scope.workspaceRoot?.path,
		].filter((value): value is URI => !!value);

		const seen = new Set<string>();
		return roots.filter(root => {
			const key = root.toString();
			if (seen.has(key)) {
				return false;
			}

			seen.add(key);
			return true;
		});
	}

	private _toCommandLine(command: string, args: readonly unknown[] | undefined): string {
		const parts = [command, ...this._toCommandArgs(args)];
		return parts.join(' ').trim();
	}

	private _toCommandArgs(args: readonly unknown[] | undefined): readonly string[] {
		return (args ?? []).map(arg => this._formatCommandArg(arg));
	}

	private _serializeValue(value: unknown): string | undefined {
		if (value === undefined) {
			return undefined;
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
			return String(value);
		}

		try {
			return JSON.stringify(value, undefined, 2);
		} catch {
			return String(value);
		}
	}

	private _formatCommandArg(arg: unknown): string {
		if (typeof arg === 'string') {
			return arg;
		}

		if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null || arg === undefined) {
			return String(arg);
		}

		if (URI.isUri(arg)) {
			return arg.toString();
		}

		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}
}

registerSingleton(ISessionActionExecutorBridge, SessionActionExecutorBridge, InstantiationType.Delayed);
