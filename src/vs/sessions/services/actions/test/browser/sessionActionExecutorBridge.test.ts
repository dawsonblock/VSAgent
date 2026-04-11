/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { GitRefType, type GitRepositoryState, type IGitRepository, type IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import type { IFileMatch, ISearchComplete, ISearchService } from '../../../../../workbench/services/search/common/search.js';
import { SessionActionExecutorBridge } from '../../browser/sessionActionExecutorBridge.js';
import { NormalizedSessionActionScope } from '../../common/sessionActionScope.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionRequestSource, SessionActionStatus, SessionCommandLaunchKind, SessionHostKind } from '../../common/sessionActionTypes.js';

suite('SessionActionExecutorBridge', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;
	const workspaceRoot = URI.file('/workspace');
	const repositoryRoot = URI.file('/workspace/repo');
	const fileResource = URI.file('/workspace/repo/file.txt');
	const deleteResource = URI.file('/workspace/repo/delete.txt');

	let fileService: FileService;
	let commandCalls: Array<{ readonly command: string; readonly args: readonly unknown[] }>;
	let commandResult: { ok: boolean; count?: number };
	let searchResults: IFileMatch[];
	let gitRepository: IGitRepository | undefined;
	let bridge: SessionActionExecutorBridge;

	function createSearchComplete(results: IFileMatch[]): ISearchComplete {
		return {
			limitHit: false,
			messages: [],
			results,
		};
	}

	function createScope(): NormalizedSessionActionScope {
		return {
			requestedScope: {
				workspaceRoot,
				projectRoot: repositoryRoot,
				repositoryPath: repositoryRoot,
				worktreeRoot: repositoryRoot,
				cwd: repositoryRoot,
				hostTarget: {
					kind: SessionHostKind.Local,
					providerId: 'provider',
				},
			},
			workspaceRoot: { path: workspaceRoot, isDirectory: true },
			projectRoot: { path: repositoryRoot, isDirectory: true },
			repositoryPath: { path: repositoryRoot, isDirectory: true },
			worktreeRoot: { path: repositoryRoot, isDirectory: true },
			cwd: { path: repositoryRoot, isDirectory: true },
			files: [],
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: 'provider',
			},
		};
	}

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		commandCalls = [];
		commandResult = { ok: true };
		searchResults = [];
		gitRepository = undefined;

		const commandService: ICommandService = {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async <R = unknown>(command: string, ...args: unknown[]): Promise<R | undefined> => {
				commandCalls.push({ command, args });
				return commandResult as R;
			},
		};

		const gitService: IGitService = {
			_serviceBrand: undefined,
			get repositories() {
				return gitRepository ? [gitRepository] : [];
			},
			setDelegate: () => toDisposable(() => { }),
			openRepository: async () => gitRepository,
		};

		const searchService: ISearchService = {
			_serviceBrand: undefined,
			textSearch: async () => createSearchComplete(searchResults),
			aiTextSearch: async () => createSearchComplete([]),
			getAIName: async () => undefined,
			textSearchSplitSyncAsync: () => ({
				syncResults: createSearchComplete(searchResults),
				asyncResults: Promise.resolve(createSearchComplete([])),
			}),
			fileSearch: async () => createSearchComplete([]),
			schemeHasFileSearchProvider: () => false,
			clearCache: async () => { },
			registerSearchResultProvider: () => toDisposable(() => { }),
		};

		bridge = new SessionActionExecutorBridge(
			commandService,
			fileService,
			gitService,
			searchService,
		);
	});

	test('searchWorkspace returns structured matches', async () => {
		searchResults = [{ resource: fileResource, results: [] }];

		const result = await bridge.execute({
			kind: SessionActionKind.SearchWorkspace,
			requestedBy: SessionActionRequestSource.User,
			query: 'needle',
			maxResults: 10,
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(result.kind, SessionActionKind.SearchWorkspace);
		assert.deepStrictEqual(result.matches, [{ resource: fileResource }]);
	});

	test('readFile returns file contents', async () => {
		await fileService.writeFile(fileResource, VSBuffer.fromString('hello world'));

		const result = await bridge.execute({
			kind: SessionActionKind.ReadFile,
			requestedBy: SessionActionRequestSource.User,
			resource: fileResource,
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(result.kind, SessionActionKind.ReadFile);
		assert.strictEqual(result.contents, 'hello world');
	});

	test('writePatch applies create and delete operations', async () => {
		await fileService.writeFile(deleteResource, VSBuffer.fromString('delete me'));

		const result = await bridge.execute({
			kind: SessionActionKind.WritePatch,
			requestedBy: SessionActionRequestSource.User,
			patch: 'patch',
			files: [fileResource, deleteResource],
			operations: [
				{ resource: fileResource, contents: 'updated' },
				{ resource: deleteResource, delete: true, useTrash: false },
			],
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(result.kind, SessionActionKind.WritePatch);
		assert.deepStrictEqual(result.filesTouched, [fileResource, deleteResource]);
		assert.strictEqual((await fileService.readFile(fileResource)).value.toString(), 'updated');
		await assert.rejects(() => fileService.readFile(deleteResource));
	});

	test('runCommand returns authoritative command metadata and output', async () => {
		commandResult = { ok: true, count: 2 };

		const result = await bridge.execute({
			kind: SessionActionKind.RunCommand,
			requestedBy: SessionActionRequestSource.User,
			command: 'workbench.action.test',
			args: ['alpha', 2],
			cwd: repositoryRoot,
			launchKind: SessionCommandLaunchKind.Command,
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(result.kind, SessionActionKind.RunCommand);
		assert.strictEqual(result.command, 'workbench.action.test');
		assert.deepStrictEqual(result.args, ['alpha', '2']);
		assert.strictEqual(result.cwd?.toString(), repositoryRoot.toString());
		assert.strictEqual(result.exitCode, 0);
		assert.ok(result.stdout?.includes('"ok": true'));
		assert.strictEqual(result.stderr, '');
		assert.deepStrictEqual(commandCalls, [{ command: 'workbench.action.test', args: ['alpha', 2] }]);
	});

	test('runCommand fails closed for task-backed execution', async () => {
		const result = await bridge.execute({
			kind: SessionActionKind.RunCommand,
			requestedBy: SessionActionRequestSource.User,
			command: 'build-task',
			launchKind: SessionCommandLaunchKind.Task,
			cwd: repositoryRoot,
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Failed);
		assert.strictEqual(result.kind, SessionActionKind.RunCommand);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.UnsupportedAction);
		assert.ok(result.stderr?.includes('authoritative stdout, stderr, and exit codes'));
	});

	test('gitStatus and gitDiff return structured repository output', async () => {
		const gitChange = {
			uri: fileResource,
			originalUri: undefined,
			modifiedUri: fileResource,
		};
		const repositoryState: GitRepositoryState = {
			HEAD: { type: GitRefType.Head, name: 'main', commit: 'head' },
			remotes: [],
			mergeChanges: [gitChange],
			indexChanges: [gitChange, gitChange],
			workingTreeChanges: [gitChange, gitChange, gitChange],
			untrackedChanges: [gitChange],
		};
		const state = observableValue('gitRepositoryState', repositoryState);

		gitRepository = {
			rootUri: repositoryRoot,
			state,
			updateState: nextState => state.set(nextState, undefined, undefined),
			getRefs: async () => [],
			diffBetweenWithStats: async () => [],
			diffBetweenWithStats2: async () => [{ uri: fileResource, originalUri: undefined, modifiedUri: fileResource, insertions: 4, deletions: 2 }],
		};

		const statusResult = await bridge.execute({
			kind: SessionActionKind.GitStatus,
			requestedBy: SessionActionRequestSource.User,
			repository: repositoryRoot,
		}, createScope());
		const diffResult = await bridge.execute({
			kind: SessionActionKind.GitDiff,
			requestedBy: SessionActionRequestSource.User,
			repository: repositoryRoot,
			ref: 'HEAD~1',
		}, createScope());

		assert.strictEqual(statusResult.status, SessionActionStatus.Executed);
		assert.strictEqual(statusResult.kind, SessionActionKind.GitStatus);
		assert.ok(statusResult.stdout?.includes('"head": "main"'));
		assert.strictEqual(statusResult.stderr, '');
		assert.strictEqual(diffResult.status, SessionActionStatus.Executed);
		assert.strictEqual(diffResult.kind, SessionActionKind.GitDiff);
		assert.ok(diffResult.stdout?.includes('(+4/-2)'));
		assert.strictEqual(diffResult.stderr, '');
	});

	test('openWorktree returns an explicit structured failure', async () => {
		const result = await bridge.execute({
			kind: SessionActionKind.OpenWorktree,
			requestedBy: SessionActionRequestSource.User,
			repository: repositoryRoot,
			worktreePath: URI.file('/workspace/repo-worktree'),
			branch: 'feature',
		}, createScope());

		assert.strictEqual(result.status, SessionActionStatus.Failed);
		assert.strictEqual(result.kind, SessionActionKind.OpenWorktree);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.UnsupportedAction);
		assert.strictEqual(result.branch, 'feature');
		assert.ok(result.stderr?.includes('not yet supported'));
	});
});
