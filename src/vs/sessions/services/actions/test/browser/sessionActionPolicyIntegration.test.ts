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
import { SessionActionPolicyService } from '../../browser/sessionActionPolicyService.js';
import { ProviderCapabilitySet, SessionActionPolicyMode } from '../../common/sessionActionPolicy.js';
import { NormalizedSessionActionScope } from '../../common/sessionActionScope.js';
import { SessionAction, SessionActionKind, SessionActionRequestSource, SessionCommandLaunchKind, SessionHostKind } from '../../common/sessionActionTypes.js';
import { createExecutionContext, createProviderCapabilities } from './sessionActionTestUtils.js';

suite('SessionActionPolicyIntegration', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;
	let fileService: FileService;
	let configService: SessionActionPolicyConfigService;
	let policyService: SessionActionPolicyService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		disposables.add(fileService.registerProvider('vscode-agent-host', disposables.add(new InMemoryFileSystemProvider())));
		configService = disposables.add(new SessionActionPolicyConfigService(fileService, new NullLogService()));
		policyService = new SessionActionPolicyService(configService);
	});

	function createScope(root: URI, hostKind: SessionHostKind): NormalizedSessionActionScope {
		const file = joinPath(root, 'file.ts');
		return {
			requestedScope: {
				workspaceRoot: root,
				projectRoot: root,
				repositoryPath: root,
				worktreeRoot: root,
				cwd: root,
				files: [file],
				hostTarget: {
					kind: hostKind,
					providerId: 'provider',
					authority: root.authority || undefined,
				},
			},
			workspaceRoot: { path: root, isDirectory: true },
			projectRoot: { path: root, isDirectory: true },
			repositoryPath: { path: root, isDirectory: true },
			worktreeRoot: { path: root, isDirectory: true },
			cwd: { path: root, isDirectory: true },
			files: [{ path: file, isDirectory: false }],
			hostTarget: {
				kind: hostKind,
				providerId: 'provider',
				authority: root.authority || undefined,
			},
		};
	}

	function createAction(kind: SessionActionKind, root: URI): SessionAction {
		const file = joinPath(root, 'file.ts');
		switch (kind) {
			case SessionActionKind.SearchWorkspace:
				return { kind, requestedBy: SessionActionRequestSource.User, query: 'needle' };
			case SessionActionKind.ReadFile:
				return { kind, requestedBy: SessionActionRequestSource.User, resource: file };
			case SessionActionKind.WritePatch:
				return { kind, requestedBy: SessionActionRequestSource.User, patch: 'patch', files: [file], operations: [{ resource: file, contents: 'updated' }] };
			case SessionActionKind.RunCommand:
				return { kind, requestedBy: SessionActionRequestSource.User, command: 'npm', args: ['test'], cwd: root, launchKind: SessionCommandLaunchKind.Command };
			case SessionActionKind.GitStatus:
				return { kind, requestedBy: SessionActionRequestSource.User, repository: root };
			case SessionActionKind.GitDiff:
				return { kind, requestedBy: SessionActionRequestSource.User, repository: root, ref: 'HEAD~1' };
			case SessionActionKind.OpenWorktree:
				return { kind, requestedBy: SessionActionRequestSource.User, repository: root, worktreePath: joinPath(root, '..', 'repo-worktree'), branch: 'feature' };
		}
	}

	async function evaluate(kind: SessionActionKind, root: URI, capabilities: ProviderCapabilitySet): Promise<ReturnType<SessionActionPolicyService['evaluate']>> {
		const executionContext = createExecutionContext(root, 'provider', 'session', root.scheme === 'file' ? SessionHostKind.Local : SessionHostKind.Remote);
		const snapshot = await policyService.getPolicySnapshot(executionContext, [root]);
		return policyService.evaluate({
			action: createAction(kind, root),
			normalizedScope: createScope(root, executionContext.hostTarget.kind),
			providerCapabilities: capabilities,
			executionContext,
			policy: snapshot,
			requestedPermissionMode: undefined,
		});
	}

	test('missing config stays fail-closed for mutating actions', async () => {
		const root = URI.file('/workspace/repo');
		const permissiveCapabilities = createProviderCapabilities({ canOpenWorktrees: true, requiresApprovalForCommands: false, requiresApprovalForWrites: false, requiresApprovalForGit: false, requiresApprovalForWorktreeActions: false });

		const snapshot = await configService.getPolicySnapshot(createExecutionContext(root), [root]);
		assert.deepStrictEqual(snapshot, getDefaultSessionPolicySnapshot([root]));

		assert.strictEqual((await evaluate(SessionActionKind.SearchWorkspace, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Allow);
		assert.strictEqual((await evaluate(SessionActionKind.ReadFile, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Allow);
		assert.strictEqual((await evaluate(SessionActionKind.WritePatch, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.RunCommand, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.GitStatus, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.GitDiff, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.OpenWorktree, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
	});

	test('repo policy overrides unlock all action classes when explicitly enabled', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		const permissiveCapabilities = createProviderCapabilities({ canOpenWorktrees: true, requiresApprovalForCommands: false, requiresApprovalForWrites: false, requiresApprovalForGit: false, requiresApprovalForWorktreeActions: false });

		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({
			allowWorkspaceWrites: true,
			allowCommands: true,
			allowGitMutation: true,
			allowWorktreeMutation: true,
		})), { overwrite: true });

		for (const kind of [
			SessionActionKind.SearchWorkspace,
			SessionActionKind.ReadFile,
			SessionActionKind.WritePatch,
			SessionActionKind.RunCommand,
			SessionActionKind.GitStatus,
			SessionActionKind.GitDiff,
			SessionActionKind.OpenWorktree,
		]) {
			assert.notStrictEqual((await evaluate(kind, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny, `Expected ${kind} to be allowed by the repo policy override.`);
		}
	});

	test('policy reload updates subsequent evaluations immediately', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		const permissiveCapabilities = createProviderCapabilities({ requiresApprovalForCommands: false });
		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowCommands: true })), { overwrite: true });

		assert.notStrictEqual((await evaluate(SessionActionKind.RunCommand, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);

		const changePromise = Event.toPromise(configService.onDidChangePolicy);
		await fileService.writeFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowCommands: false })));
		await changePromise;

		assert.strictEqual((await evaluate(SessionActionKind.RunCommand, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
	});

	test('remote policy roots are respected during evaluation', async () => {
		const root = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-host', path: '/workspace/repo' });
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowGitMutation: true })), { overwrite: true });

		const decision = await evaluate(SessionActionKind.GitStatus, root, createProviderCapabilities({ requiresApprovalForGit: false }));
		assert.notStrictEqual(decision.mode, SessionActionPolicyMode.Deny);
	});

	test('write and command permissions stay denied until each policy flag is explicitly enabled', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		const permissiveCapabilities = createProviderCapabilities({ requiresApprovalForWrites: false, requiresApprovalForCommands: false });

		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowWorkspaceWrites: true })), { overwrite: true });

		assert.notStrictEqual((await evaluate(SessionActionKind.WritePatch, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.RunCommand, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);

		const changePromise = Event.toPromise(configService.onDidChangePolicy);
		await fileService.writeFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowWorkspaceWrites: true, allowCommands: true })));
		await changePromise;

		assert.notStrictEqual((await evaluate(SessionActionKind.RunCommand, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
	});

	test('git policy enables read-only git actions while worktrees remain denied by default', async () => {
		const root = URI.file('/workspace/repo');
		const policyUri = joinPath(root, '.vscode', 'vsagent-policy.json');
		const permissiveCapabilities = createProviderCapabilities({ canOpenWorktrees: true, requiresApprovalForGit: false, requiresApprovalForWorktreeActions: false });

		await fileService.createFile(policyUri, VSBuffer.fromString(JSON.stringify({ allowGitMutation: true })), { overwrite: true });

		assert.notStrictEqual((await evaluate(SessionActionKind.GitStatus, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.notStrictEqual((await evaluate(SessionActionKind.GitDiff, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
		assert.strictEqual((await evaluate(SessionActionKind.OpenWorktree, root, permissiveCapabilities)).mode, SessionActionPolicyMode.Deny);
	});
});
