/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { getDefaultSessionPolicySnapshot, SessionActionPolicyConfigService } from '../../browser/sessionActionPolicyConfigService.js';
import { SessionHostKind } from '../../common/sessionActionTypes.js';

suite('SessionActionPolicyConfigService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;
	let fileService: FileService;
	let service: SessionActionPolicyConfigService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		disposables.add(fileService.registerProvider('vscode-agent-host', disposables.add(new InMemoryFileSystemProvider())));
		service = disposables.add(new SessionActionPolicyConfigService(fileService, new NullLogService()));
	});

	function createExecutionContext(root: URI) {
		return {
			sessionId: 'session',
			providerId: 'provider',
			sessionResource: URI.parse('session-action:/session'),
			workspaceRoot: root,
			projectRoot: root,
			repositoryPath: root,
			worktreeRoot: root,
			hostTarget: {
				kind: root.scheme === 'file' ? SessionHostKind.Local : SessionHostKind.Remote,
				providerId: 'provider',
				authority: root.authority || undefined,
			},
			advisorySources: [],
		};
	}

	test('returns fail-closed defaults when no policy file exists', async () => {
		const root = URI.file('/workspace/repo');
		const snapshot = await service.getPolicySnapshot(createExecutionContext(root), [root]);

		assert.deepStrictEqual(snapshot, getDefaultSessionPolicySnapshot([root]));
	});

	test('loads policy overrides from a local policy file', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({
			allowWorkspaceWrites: true,
			allowCommands: true,
			commandAllowPatterns: ['^npm$'],
			deniedRoots: ['secrets'],
		})), { overwrite: true });

		const snapshot = await service.getPolicySnapshot(createExecutionContext(root), [root]);

		assert.strictEqual(snapshot.allowWorkspaceWrites, true);
		assert.strictEqual(snapshot.allowCommands, true);
		assert.strictEqual(snapshot.commandAllowPatterns[0]?.source, '^npm$');
		assert.deepStrictEqual(snapshot.deniedRoots.map(uri => uri.toString()), [joinPath(root, 'secrets').toString()]);
	});

	test('reloads a cached policy after the file changes', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowWorkspaceWrites: true })), { overwrite: true });

		assert.strictEqual((await service.getPolicySnapshot(createExecutionContext(root), [root])).allowWorkspaceWrites, true);

		const changePromise = Event.toPromise(service.onDidChangePolicy);
		await fileService.writeFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowWorkspaceWrites: false, allowGitMutation: true })));
		await changePromise;

		const snapshot = await service.getPolicySnapshot(createExecutionContext(root), [root]);
		assert.strictEqual(snapshot.allowWorkspaceWrites, false);
		assert.strictEqual(snapshot.allowGitMutation, true);
	});

	test('supports remote policy roots when the file service can read them', async () => {
		const root = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-host', path: '/workspace/repo' });
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowGitMutation: true })), { overwrite: true });

		const snapshot = await service.getPolicySnapshot(createExecutionContext(root), [root]);
		assert.strictEqual(snapshot.allowGitMutation, true);
	});
});
