/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionAction, SessionActionKind, SessionActionRequestSource, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind } from '../../../../services/actions/common/sessionActionTypes.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionsAICustomizationWorkspaceService } from '../../browser/aiCustomizationWorkspaceService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ICustomizationHarnessService } from '../../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

function makeActiveSession(repositoryUri: URI, worktreeUri?: URI): IActiveSession {
	const workspace = observableValue('workspace', {
		label: 'test',
		icon: undefined,
		repositories: [{
			uri: repositoryUri,
			workingDirectory: worktreeUri,
			detail: undefined,
			baseBranchName: undefined,
			baseBranchProtected: undefined,
		}],
		requiresWorkspaceTrust: false,
	});

	return {
		sessionId: 'test-session',
		providerId: 'test-provider',
		resource: URI.parse('file:///session'),
		workspace,
		activeChat: observableValue('activeChat', undefined),
	} as unknown as IActiveSession;
}

function createService(options: {
	repositoryUri: URI;
	worktreeUri?: URI;
	fileContents?: ReadonlyMap<string, string>;
	existingFiles?: ReadonlySet<string>;
	submittedActions: unknown[];
	directWriteCalls: { count: number };
	directDeleteCalls: { count: number };
}): SessionsAICustomizationWorkspaceService {
	const session = makeActiveSession(options.repositoryUri, options.worktreeUri);
	const activeSession = observableValue<IActiveSession | undefined>('activeSession', session);

	const sessionsService: ISessionsManagementService = {
		activeSession,
		async submitAction(_session: ISession, action: SessionAction): Promise<SessionActionResult> {
			options.submittedActions.push(action);
			if (action.kind === SessionActionKind.WritePatch) {
				return {
					actionId: 'write-action',
					kind: SessionActionKind.WritePatch,
					status: SessionActionStatus.Executed,
					advisorySources: [],
					filesTouched: action.files,
					applied: true,
				};
			}

			if (action.kind !== SessionActionKind.RunCommand) {
				throw new Error(`Unexpected test action kind '${action.kind}'.`);
			}

			return {
				actionId: 'command-action',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Executed,
				advisorySources: [],
				commandLine: action.command,
			};
		},
	} as unknown as ISessionsManagementService;

	const fileService: IFileService = {
		async readFile(resource: URI) {
			const content = options.fileContents?.get(resource.toString());
			if (content === undefined) {
				throw new Error(`Missing test file content for '${resource.toString()}'.`);
			}
			return { value: VSBuffer.fromString(content) };
		},
		async exists(resource: URI) {
			return options.existingFiles?.has(resource.toString()) ?? false;
		},
		async writeFile() {
			options.directWriteCalls.count += 1;
			throw new Error('Direct file writes should be mediated through Sessions actions.');
		},
		async del() {
			options.directDeleteCalls.count += 1;
			throw new Error('Direct file deletions should be mediated through Sessions actions.');
		},
	} as unknown as IFileService;

	return new SessionsAICustomizationWorkspaceService(
		sessionsService,
		{} as IInstantiationService,
		{} as IPromptsService,
		{} as ICustomizationHarnessService,
		{} as ILogService,
		fileService,
		{} as INotificationService,
	);
}

suite('SessionsAICustomizationWorkspaceService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the active session root authoritative for customizations', () => {
		const repositoryUri = URI.parse('file:///repo');
		const worktreeUri = URI.parse('file:///worktree');
		const submittedActions: unknown[] = [];
		const directWriteCalls = { count: 0 };
		const directDeleteCalls = { count: 0 };

		const service = createService({
			repositoryUri,
			worktreeUri,
			submittedActions,
			directWriteCalls,
			directDeleteCalls,
		});

		assert.strictEqual(service.supportsProjectRootOverride, false);
		assert.strictEqual(service.hasOverrideProjectRoot.get(), false);
		assert.strictEqual(service.getActiveProjectRoot()?.toString(), worktreeUri.toString());

		service.setOverrideProjectRoot(URI.parse('file:///elsewhere'));

		assert.strictEqual(service.hasOverrideProjectRoot.get(), false);
		assert.strictEqual(service.getActiveProjectRoot()?.toString(), worktreeUri.toString());
	});

	test('commitFiles routes repository replication and commit commands through Sessions actions', async () => {
		const repositoryUri = URI.parse('file:///repo');
		const worktreeUri = URI.parse('file:///worktree');
		const fileUri = URI.joinPath(worktreeUri, '.github', 'copilot-instructions.md');
		const repoFileUri = URI.joinPath(repositoryUri, '.github', 'copilot-instructions.md');
		const submittedActions: unknown[] = [];
		const directWriteCalls = { count: 0 };
		const directDeleteCalls = { count: 0 };

		const service = createService({
			repositoryUri,
			worktreeUri,
			fileContents: new Map([[fileUri.toString(), 'customization contents']]),
			submittedActions,
			directWriteCalls,
			directDeleteCalls,
		});

		await service.commitFiles(repositoryUri, [fileUri]);

		assert.strictEqual(directWriteCalls.count, 0);
		assert.strictEqual(directDeleteCalls.count, 0);
		assert.deepStrictEqual(submittedActions.map(action => (action as { kind: SessionActionKind }).kind), [
			SessionActionKind.WritePatch,
			SessionActionKind.RunCommand,
			SessionActionKind.RunCommand,
		]);

		const writeAction = submittedActions[0] as {
			readonly kind: SessionActionKind.WritePatch;
			readonly requestedBy: SessionActionRequestSource;
			readonly files: readonly URI[];
			readonly operations: readonly { readonly resource: URI; readonly contents?: string }[];
		};
		assert.strictEqual(writeAction.requestedBy, SessionActionRequestSource.User);
		assert.deepStrictEqual(writeAction.files.map(resource => resource.toString()), [repoFileUri.toString()]);
		assert.deepStrictEqual(writeAction.operations.map(operation => ({ resource: operation.resource.toString(), contents: operation.contents })), [{ resource: repoFileUri.toString(), contents: 'customization contents' }]);

		const commitToRepository = submittedActions[1] as {
			readonly command: string;
			readonly args: readonly unknown[];
			readonly launchKind: SessionCommandLaunchKind;
		};
		assert.strictEqual(commitToRepository.command, 'github.copilot.cli.sessions.commitToRepository');
		assert.strictEqual(commitToRepository.launchKind, SessionCommandLaunchKind.Command);
		assert.deepStrictEqual((commitToRepository.args as readonly { repositoryUri: URI; fileUri: URI }[]).map(arg => ({ repositoryUri: arg.repositoryUri.toString(), fileUri: arg.fileUri.toString() })), [{ repositoryUri: repositoryUri.toString(), fileUri: repoFileUri.toString() }]);

		const commitToWorktree = submittedActions[2] as {
			readonly command: string;
			readonly args: readonly unknown[];
			readonly launchKind: SessionCommandLaunchKind;
		};
		assert.strictEqual(commitToWorktree.command, 'github.copilot.cli.sessions.commitToWorktree');
		assert.strictEqual(commitToWorktree.launchKind, SessionCommandLaunchKind.Command);
		assert.deepStrictEqual((commitToWorktree.args as readonly { worktreeUri: URI; fileUri: URI }[]).map(arg => ({ worktreeUri: arg.worktreeUri.toString(), fileUri: arg.fileUri.toString() })), [{ worktreeUri: worktreeUri.toString(), fileUri: fileUri.toString() }]);
	});

	test('deleteFiles routes repository deletion and commit commands through Sessions actions', async () => {
		const repositoryUri = URI.parse('file:///repo');
		const worktreeUri = URI.parse('file:///worktree');
		const fileUri = URI.joinPath(worktreeUri, '.github', 'copilot-instructions.md');
		const repoFileUri = URI.joinPath(repositoryUri, '.github', 'copilot-instructions.md');
		const submittedActions: unknown[] = [];
		const directWriteCalls = { count: 0 };
		const directDeleteCalls = { count: 0 };

		const service = createService({
			repositoryUri,
			worktreeUri,
			existingFiles: new Set([repoFileUri.toString()]),
			submittedActions,
			directWriteCalls,
			directDeleteCalls,
		});

		await service.deleteFiles(repositoryUri, [fileUri]);

		assert.strictEqual(directWriteCalls.count, 0);
		assert.strictEqual(directDeleteCalls.count, 0);
		assert.deepStrictEqual(submittedActions.map(action => (action as { kind: SessionActionKind }).kind), [
			SessionActionKind.WritePatch,
			SessionActionKind.RunCommand,
			SessionActionKind.RunCommand,
		]);

		const deleteAction = submittedActions[0] as {
			readonly kind: SessionActionKind.WritePatch;
			readonly requestedBy: SessionActionRequestSource;
			readonly files: readonly URI[];
			readonly operations: readonly { readonly resource: URI; readonly delete?: boolean; readonly useTrash?: boolean }[];
		};
		assert.strictEqual(deleteAction.requestedBy, SessionActionRequestSource.User);
		assert.deepStrictEqual(deleteAction.files.map(resource => resource.toString()), [repoFileUri.toString()]);
		assert.deepStrictEqual(deleteAction.operations.map(operation => ({ resource: operation.resource.toString(), delete: operation.delete, useTrash: operation.useTrash })), [{ resource: repoFileUri.toString(), delete: true, useTrash: true }]);

		const commitToRepository = submittedActions[1] as { readonly command: string; readonly args: readonly unknown[] };
		assert.strictEqual(commitToRepository.command, 'github.copilot.cli.sessions.commitToRepository');
		assert.deepStrictEqual((commitToRepository.args as readonly { repositoryUri: URI; fileUri: URI }[]).map(arg => ({ repositoryUri: arg.repositoryUri.toString(), fileUri: arg.fileUri.toString() })), [{ repositoryUri: repositoryUri.toString(), fileUri: repoFileUri.toString() }]);

		const commitToWorktree = submittedActions[2] as { readonly command: string; readonly args: readonly unknown[] };
		assert.strictEqual(commitToWorktree.command, 'github.copilot.cli.sessions.commitToWorktree');
		assert.deepStrictEqual((commitToWorktree.args as readonly { worktreeUri: URI; fileUri: URI }[]).map(arg => ({ worktreeUri: arg.worktreeUri.toString(), fileUri: arg.fileUri.toString() })), [{ worktreeUri: worktreeUri.toString(), fileUri: fileUri.toString() }]);
	});
});
