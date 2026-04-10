/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionPolicyService } from '../../browser/sessionActionPolicyService.js';
import { getDefaultSessionPolicySnapshot, ISessionActionPolicyConfigService } from '../../browser/sessionActionPolicyConfigService.js';
import { NormalizedSessionActionScope } from '../../common/sessionActionScope.js';
import { CommandRiskClass, ProviderCapabilitySet } from '../../common/sessionActionPolicy.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionRequestSource, SessionCommandLaunchKind, SessionHostKind } from '../../common/sessionActionTypes.js';

suite('SessionActionPolicyService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/workspace');
	const repository = URI.file('/workspace/repo');

	function createProviderCapabilities(overrides?: Partial<ProviderCapabilitySet>): ProviderCapabilitySet {
		return {
			multipleChatsPerSession: false,
			hostKind: SessionHostKind.Local,
			canReadWorkspace: true,
			canWriteWorkspace: true,
			canRunCommands: true,
			canMutateGit: true,
			canOpenWorktrees: false,
			canUseExternalTools: true,
			requiresApprovalForWrites: true,
			requiresApprovalForCommands: true,
			requiresApprovalForGit: true,
			requiresApprovalForWorktreeActions: true,
			supportsStructuredApprovals: true,
			supportsReceiptMetadata: true,
			...overrides,
		};
	}

	function createScope(): NormalizedSessionActionScope {
		return {
			requestedScope: {
				workspaceRoot: root,
				repositoryPath: repository,
				cwd: repository,
				hostTarget: {
					kind: SessionHostKind.Local,
					providerId: 'provider',
				},
			},
			workspaceRoot: { path: root, isDirectory: true },
			projectRoot: { path: repository, isDirectory: true },
			repositoryPath: { path: repository, isDirectory: true },
			worktreeRoot: { path: repository, isDirectory: true },
			cwd: { path: repository, isDirectory: true },
			files: [],
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: 'provider',
			},
		};
	}

	function createExecutionContext() {
		return {
			sessionId: 'session',
			providerId: 'provider',
			sessionResource: URI.parse('session-action:/session'),
			workspaceRoot: root,
			projectRoot: repository,
			repositoryPath: repository,
			worktreeRoot: repository,
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: 'provider',
			},
			advisorySources: [],
			permissionMode: undefined,
			sessionType: 'test',
		};
	}

	function createService(policyOverrides?: Partial<ReturnType<typeof getDefaultSessionPolicySnapshot>>): SessionActionPolicyService {
		return new SessionActionPolicyService({
			onDidChangePolicy: Event.None,
			async getPolicySnapshot(_executionContext, allowedRoots) {
				return {
					...getDefaultSessionPolicySnapshot(allowedRoots),
					...policyOverrides,
					allowedRoots,
				};
			},
		} as ISessionActionPolicyConfigService);
	}

	test('denies git mutation commands when provider lacks git mutation capability', async () => {
		const service = createService({ allowGitMutation: true });
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.User,
				command: '_git.mergeBranch',
				args: ['/workspace/repo', 'feature'],
				launchKind: SessionCommandLaunchKind.Command,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities({ canMutateGit: false }),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'deny');
		assert.strictEqual(decision.denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.GitMutation);
	});

	test('denies external commands when provider cannot use external tools', async () => {
		const service = createService({ allowCommands: true });
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.Session,
				command: 'npm test',
				cwd: repository,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities({ canUseExternalTools: false }),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'deny');
		assert.strictEqual(decision.denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.ProcessExecution);
	});

	test('allows internal Sessions commands when provider cannot use external tools', async () => {
		const service = createService({ allowWorkspaceWrites: true });
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.User,
				command: '_sessions.archiveSession',
				args: [{ providerId: 'provider', sessionId: 'session' }],
				launchKind: SessionCommandLaunchKind.Command,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities({ canUseExternalTools: false }),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'allow');
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.WorkspaceWrite);
	});

	test('requires approval for user git mutation commands when provider requires git approvals', async () => {
		const service = createService({ allowGitMutation: true });
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.User,
				command: '_git.mergeBranch',
				args: ['/workspace/repo', 'feature'],
				launchKind: SessionCommandLaunchKind.Command,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities(),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'requireApproval');
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.GitMutation);
	});

	test('allows git inspection without git mutation capability', async () => {
		const service = createService();
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.GitStatus,
				requestedBy: SessionActionRequestSource.User,
				repository,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities({ canMutateGit: false }),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'allow');
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.ReadOnly);
	});

	test('denies internal Sessions commands when workspace writes are disabled by policy', async () => {
		const service = createService();
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.User,
				command: '_sessions.archiveSession',
				args: [{ providerId: 'provider', sessionId: 'session' }],
				launchKind: SessionCommandLaunchKind.Command,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities(),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'deny');
		assert.strictEqual(decision.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.WorkspaceWrite);
	});

	test('denies external commands when command execution is disabled by policy', async () => {
		const service = createService();
		const decision = service.evaluate({
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.User,
				command: 'npm',
				args: ['test'],
				cwd: repository,
				launchKind: SessionCommandLaunchKind.Command,
			},
			normalizedScope: createScope(),
			providerCapabilities: createProviderCapabilities(),
			executionContext: createExecutionContext(),
			policy: await service.getPolicySnapshot(createExecutionContext(), [root, repository]),
			requestedPermissionMode: undefined,
		});

		assert.strictEqual(decision.mode, 'deny');
		assert.strictEqual(decision.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(decision.commandRiskClass, CommandRiskClass.ProcessExecution);
	});
});
