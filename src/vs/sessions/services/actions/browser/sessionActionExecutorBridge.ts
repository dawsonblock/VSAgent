/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IBulkEditService, ResourceFileEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { ISearchService, ITextQuery, QueryType, resultIsMatch } from '../../../../workbench/services/search/common/search.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../workbench/services/textfile/common/textfiles.js';
import { localize } from '../../../../nls.js';
import { NormalizedSessionActionScope } from '../common/sessionActionScope.js';
import { GitDiffAction, GitStatusAction, OpenWorktreeAction, ReadFileAction, RunCommandAction, SearchWorkspaceAction, SessionAction, SessionActionDenialReason, SessionActionKind, SessionActionResult, SessionActionSearchMatch, SessionActionStatus, SessionCommandLaunchKind, SessionGitChangeSummary, SessionWriteOperationResult, SessionWriteOperationStatus, WritePatchAction } from '../common/sessionActionTypes.js';

const MAX_SESSION_ACTION_READ_FILE_SIZE = 1024 * 1024;

interface PlannedWriteOperation {
	readonly operation: NonNullable<WritePatchAction['operations']>[number];
	readonly existed: boolean;
	readonly bytesWritten?: number;
	readonly expectedStatus: SessionWriteOperationStatus.Created | SessionWriteOperationStatus.Updated | SessionWriteOperationStatus.Deleted;
	readonly edit: ResourceFileEdit;
}

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
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
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
				resultCount: 0,
				matchCount: 0,
				limitHit: false,
				matches: [],
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
		const aggregatedMatches = new Map<string, SessionActionSearchMatch>();

		for (const fileMatch of complete.results) {
			if (!fileMatch.results || fileMatch.results.length === 0) {
				continue;
			}

			for (const result of fileMatch.results) {
				if (!resultIsMatch(result)) {
					continue;
				}

				const key = fileMatch.resource.toString();
				const existing = aggregatedMatches.get(key);
				const lineNumbers = [...new Set(result.rangeLocations.map(location => location.source.startLineNumber))];
				const matchCount = Math.max(lineNumbers.length, 1);

				if (!existing) {
					aggregatedMatches.set(key, {
						resource: fileMatch.resource,
						lineNumber: lineNumbers[0] ?? 1,
						lineNumbers,
						preview: result.previewText,
						matchCount,
					});
					continue;
				}

				aggregatedMatches.set(key, {
					...existing,
					lineNumbers: [...new Set([...existing.lineNumbers, ...lineNumbers])],
					matchCount: existing.matchCount + matchCount,
				});
			}
		}

		const matches = [...aggregatedMatches.values()];
		const limitedMatches = typeof action.maxResults === 'number' ? matches.slice(0, action.maxResults) : matches;
		const matchCount = limitedMatches.reduce((total, match) => total + match.matchCount, 0);

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.SearchWorkspace,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			resultCount: limitedMatches.length,
			matchCount,
			limitHit: complete.limitHit ?? false,
			matches: limitedMatches,
			summary: localize('sessionActionExecutorBridge.searchWorkspaceSummary', "Found {0} workspace search match(es).", matchCount),
		};
	}

	private async _readFile(action: ReadFileAction): Promise<SessionActionResult> {
		try {
			const content = await this._textFileService.read(action.resource, {
				acceptTextOnly: true,
				limits: { size: MAX_SESSION_ACTION_READ_FILE_SIZE },
			});
			const lines = this._splitLines(content.value);
			const lineCount = lines.length;
			const requestedStartLine = Math.max(action.startLine ?? 1, 1);
			const requestedEndLine = Math.max(action.endLine ?? lineCount, requestedStartLine);
const boundedStartLine = Math.min(requestedStartLine, lineCount + 1);
			const boundedEndLine = Math.min(requestedEndLine, Math.max(lineCount, 0));
			const rangeRequested = typeof action.startLine === 'number' || typeof action.endLine === 'number';
			const contents = rangeRequested
				? (lineCount === 0 ? '' : lines.slice(boundedStartLine - 1, boundedEndLine).join('\n'))
				: content.value;
			const isPartial = rangeRequested && (boundedStartLine > 1 || boundedEndLine < lineCount);

			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.ReadFile,
				status: SessionActionStatus.Executed,
				advisorySources: action.advisorySources ?? [],
				resource: action.resource,
				contents,
				encoding: content.encoding,
				byteSize: content.size,
				lineCount,
				isPartial,
				summary: localize('sessionActionExecutorBridge.readFileSummary', "Read file '{0}'.", action.resource.toString()),
			};
		} catch (error) {
			const { message, summary } = this._formatReadFileFailure(error, action.resource);
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.ReadFile,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: message,
				advisorySources: action.advisorySources ?? [],
				resource: action.resource,
				summary,
			};
		}
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
				operationCount: 0,
				operations: [],
				summary: localize('sessionActionExecutorBridge.writePatchUnsupported', "Could not apply the requested write because no file operations were provided."),
			};
		}

		const invalidOperation = action.operations.find(operation => !operation.delete && typeof operation.contents !== 'string');
		if (invalidOperation) {
			const operations = action.operations.map(operation => ({
				resource: operation.resource,
				status: operation.resource.toString() === invalidOperation.resource.toString()
					? SessionWriteOperationStatus.Failed
					: SessionWriteOperationStatus.Skipped,
				error: operation.resource.toString() === invalidOperation.resource.toString()
					? localize('sessionActionExecutorBridge.writePatchMissingContents', "Write operations must provide text contents unless they are deletes.")
					: undefined,
			}));

			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.WritePatch,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: localize('sessionActionExecutorBridge.writePatchMissingContents', "Write operations must provide text contents unless they are deletes."),
				advisorySources: action.advisorySources ?? [],
				filesTouched: [],
				applied: false,
				operationCount: operations.length,
				operations,
				summary: localize('sessionActionExecutorBridge.writePatchFailedSummary', "Could not apply file updates."),
			};
		}

		const plannedOperations: PlannedWriteOperation[] = [];
		for (const operation of action.operations) {
			const existed = await this._fileService.exists(operation.resource);
			if (operation.delete) {
				plannedOperations.push({
					operation,
					existed,
					expectedStatus: SessionWriteOperationStatus.Deleted,
					edit: new ResourceFileEdit(operation.resource, undefined, {
						recursive: true,
						skipTrashBin: !(operation.useTrash ?? true),
					}),
				});
				continue;
			}

			const bytesWritten = VSBuffer.fromString(operation.contents ?? '').byteLength;
			plannedOperations.push({
				operation,
				existed,
				bytesWritten,
				expectedStatus: existed ? SessionWriteOperationStatus.Updated : SessionWriteOperationStatus.Created,
				edit: new ResourceFileEdit(undefined, operation.resource, {
					overwrite: true,
					contents: Promise.resolve(VSBuffer.fromString(operation.contents ?? '')),
				}),
			});
		}

		let isApplied = false;
		let failureMessage: string | undefined;

		try {
			const result = await this._bulkEditService.apply(plannedOperations.map(operation => operation.edit), {
				label: localize('sessionActionExecutorBridge.writePatchLabel', "Sessions Apply Patch"),
			});
			isApplied = result.isApplied;
			if (!result.isApplied) {
				failureMessage = localize('sessionActionExecutorBridge.writePatchRejected', "The workspace edit was not applied.");
			}
		} catch (error) {
			failureMessage = error instanceof Error
				? error.message
				: localize('sessionActionExecutorBridge.writePatchUnknownError', "an unknown error occurred while applying file updates");
		}

		const operations = await Promise.all(plannedOperations.map(operation => this._resolveWriteOperation(operation, failureMessage)));
		const filesTouched = operations
			.filter(operation => operation.status === SessionWriteOperationStatus.Created || operation.status === SessionWriteOperationStatus.Updated || operation.status === SessionWriteOperationStatus.Deleted)
			.map(operation => operation.resource);
		const failedOperations = operations.filter(operation => operation.status === SessionWriteOperationStatus.Failed);

		if (!isApplied || failedOperations.length > 0) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.WritePatch,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: localize('sessionActionExecutorBridge.writePatchFailedError', "Could not apply file updates because {0}", failureMessage ?? localize('sessionActionExecutorBridge.writePatchFailedUnknown', "the requested edits did not complete successfully")),
				advisorySources: action.advisorySources ?? [],
				filesTouched,
				applied: false,
				operationCount: operations.length,
				operations,
				summary: localize('sessionActionExecutorBridge.writePatchFailedSummary', "Could not apply file updates."),
			};
		}

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.WritePatch,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			filesTouched,
			applied: true,
			operationCount: operations.length,
			operations,
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
			// ICommandService returns the command's value, not shell stdout or stderr, so
			// Sessions keeps task and terminal launch kinds fail-closed above.
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
		const operation = 'git status';
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
				operation,
				stderr: localize('sessionActionExecutorBridge.gitStatusRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				summary: localize('sessionActionExecutorBridge.gitStatusRepositoryMissing', "Could not inspect git status because no repository was found for the Sessions action."),
			};
		}

		const state = repository.state.get();
		const files = new Map<string, URI>();
		for (const change of [...state.mergeChanges, ...state.indexChanges, ...state.workingTreeChanges, ...state.untrackedChanges]) {
			files.set(change.uri.toString(), change.uri);
		}
		const filesChanged = files.size;
		const value = {
			branch: state.HEAD?.name,
			filesChanged,
			mergeChanges: state.mergeChanges.length,
			indexChanges: state.indexChanges.length,
			workingTreeChanges: state.workingTreeChanges.length,
			untrackedChanges: state.untrackedChanges.length,
			hasChanges: filesChanged > 0,
		};

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.GitStatus,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			repository: action.repository,
			operation,
			branch: value.branch,
			filesChanged,
			mergeChanges: value.mergeChanges,
			indexChanges: value.indexChanges,
			workingTreeChanges: value.workingTreeChanges,
			untrackedChanges: value.untrackedChanges,
			hasChanges: value.hasChanges,
			stdout: JSON.stringify(value, undefined, 2),
			stderr: '',
			value,
			summary: localize('sessionActionExecutorBridge.gitStatusSummary', "Inspected git status for '{0}'.", action.repository.toString()),
		};
	}

	private async _gitDiff(action: GitDiffAction): Promise<SessionActionResult> {
		const repository = await this._gitService.openRepository(action.repository);
		const ref = action.ref ?? repository?.state.get().HEAD?.name ?? 'HEAD';
		const operation = `git diff ${ref}`;
		if (!repository) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.GitDiff,
				status: SessionActionStatus.Failed,
				denialReason: SessionActionDenialReason.ExecutionFailed,
				denialMessage: localize('sessionActionExecutorBridge.gitDiffRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				advisorySources: action.advisorySources ?? [],
				repository: action.repository,
				operation,
				ref,
				stderr: localize('sessionActionExecutorBridge.gitDiffRepositoryMissingError', "No git repository was found at '{0}'.", action.repository.toString()),
				summary: localize('sessionActionExecutorBridge.gitDiffRepositoryMissing', "Could not inspect git diff because no repository was found for the Sessions action."),
			};
		}

		const changes = await repository.diffBetweenWithStats2(ref);
		const summaries: SessionGitChangeSummary[] = changes.map(change => ({
			resource: change.uri,
			insertions: change.insertions,
			deletions: change.deletions,
		}));
		const filesChanged = summaries.length;
		const insertions = summaries.reduce((total, change) => total + change.insertions, 0);
		const deletions = summaries.reduce((total, change) => total + change.deletions, 0);
		const value = summaries.map(change => ({
			resource: change.resource.toString(),
			insertions: change.insertions,
			deletions: change.deletions,
		}));

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.GitDiff,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			repository: action.repository,
			operation,
			ref,
			filesChanged,
			insertions,
			deletions,
			changes: summaries,
			stdout: summaries.map(change => `${change.resource.toString()} (+${change.insertions}/-${change.deletions})`).join('\n'),
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
			operation: 'git worktree add',
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

	private _splitLines(contents: string): string[] {
		if (contents.length === 0) {
			return [];
		}

		return contents.split(/\r\n|\r|\n/);
	}

	private _formatReadFileFailure(error: unknown, resource: URI): { message: string; summary: string } {
		if (error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
			return {
				message: localize('sessionActionExecutorBridge.readFileBinaryError', "Could not read '{0}' because the file appears to be binary.", resource.toString()),
				summary: localize('sessionActionExecutorBridge.readFileBinarySummary', "Could not read file because it appears to be binary."),
			};
		}

		if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
			return {
				message: localize('sessionActionExecutorBridge.readFileTooLargeError', "Could not read '{0}' because the file exceeds the Sessions read limit.", resource.toString()),
				summary: localize('sessionActionExecutorBridge.readFileTooLargeSummary', "Could not read file because it exceeds the Sessions read limit."),
			};
		}

		if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
			return {
				message: localize('sessionActionExecutorBridge.readFileMissingError', "Could not read '{0}' because the file does not exist.", resource.toString()),
				summary: localize('sessionActionExecutorBridge.readFileMissingSummary', "Could not read file because it does not exist."),
			};
		}

		const message = error instanceof Error
			? error.message
			: localize('sessionActionExecutorBridge.readFileUnknownError', "an unknown error occurred while reading the file");

		return {
			message,
			summary: localize('sessionActionExecutorBridge.readFileFailureSummary', "Could not read file."),
		};
	}

	private async _resolveWriteOperation(plannedOperation: PlannedWriteOperation, failureMessage: string | undefined): Promise<SessionWriteOperationResult> {
		if (plannedOperation.operation.delete) {
			const existsAfter = await this._fileService.exists(plannedOperation.operation.resource);
			if (plannedOperation.existed && !existsAfter) {
				return {
					resource: plannedOperation.operation.resource,
					status: SessionWriteOperationStatus.Deleted,
				};
			}

			return {
				resource: plannedOperation.operation.resource,
				status: SessionWriteOperationStatus.Failed,
				error: failureMessage ?? localize('sessionActionExecutorBridge.writePatchDeleteFailed', "The delete operation did not complete successfully."),
			};
		}

		const existsAfter = await this._fileService.exists(plannedOperation.operation.resource);
		if (!existsAfter) {
			return {
				resource: plannedOperation.operation.resource,
				status: SessionWriteOperationStatus.Failed,
				bytesWritten: plannedOperation.bytesWritten,
				error: failureMessage ?? localize('sessionActionExecutorBridge.writePatchWriteFailed', "The file update did not complete successfully."),
			};
		}

		try {
			const contents = await this._fileService.readFile(plannedOperation.operation.resource, { limits: { size: MAX_SESSION_ACTION_READ_FILE_SIZE } });
			if (contents.value.toString() === plannedOperation.operation.contents) {
				return {
					resource: plannedOperation.operation.resource,
					status: plannedOperation.expectedStatus,
					bytesWritten: plannedOperation.bytesWritten,
				};
			}
		} catch (error) {
			return {
				resource: plannedOperation.operation.resource,
				status: SessionWriteOperationStatus.Failed,
				bytesWritten: plannedOperation.bytesWritten,
				error: error instanceof Error ? error.message : failureMessage,
			};
		}

		return {
			resource: plannedOperation.operation.resource,
			status: SessionWriteOperationStatus.Failed,
			bytesWritten: plannedOperation.bytesWritten,
			error: failureMessage ?? localize('sessionActionExecutorBridge.writePatchWriteMismatch', "The file contents did not match the requested update after the workspace edit completed."),
		};
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
