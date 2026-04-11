/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionKind, SessionActionStatus } from '../../common/sessionActionTypes.js';
import { createActionForKind, createSessionActionHarness, testProviderId, testSessionId } from './sessionActionTestUtils.js';

suite('ProviderCapabilityEnforcement', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('denies typed actions when the required provider capability is missing', async () => {
		const cases = [
			{ kind: SessionActionKind.SearchWorkspace, capability: { canReadWorkspace: false }, policy: {} },
			{ kind: SessionActionKind.ReadFile, capability: { canReadWorkspace: false }, policy: {} },
			{ kind: SessionActionKind.WritePatch, capability: { canWriteWorkspace: false }, policy: { allowWorkspaceWrites: true } },
			{ kind: SessionActionKind.RunCommand, capability: { canRunCommands: false }, policy: { allowCommands: true } },
			{ kind: SessionActionKind.GitStatus, capability: { canMutateGit: false }, policy: { allowGitMutation: true } },
			{ kind: SessionActionKind.GitDiff, capability: { canMutateGit: false }, policy: { allowGitMutation: true } },
			{ kind: SessionActionKind.OpenWorktree, capability: { canOpenWorktrees: false }, policy: { allowWorktreeMutation: true } },
		] as const;

		for (const testCase of cases) {
			const harness = createSessionActionHarness(disposables, {
				providerCapabilityOverrides: testCase.capability,
				policyOverrides: testCase.policy,
			});

			const result = await harness.service.approveAction(testSessionId, testProviderId, createActionForKind(testCase.kind));

			assert.strictEqual(result.status, SessionActionStatus.Denied, `Expected ${testCase.kind} to be denied when its capability is missing.`);
			assert.strictEqual(result.denialReason, 'providerCapabilityMissing', `Expected ${testCase.kind} to fail with the provider capability denial reason.`);
		}
	});

	test('allows typed actions when the provider capability and policy both permit them', async () => {
		const cases = [
			{ kind: SessionActionKind.SearchWorkspace, capability: {}, policy: {} },
			{ kind: SessionActionKind.ReadFile, capability: {}, policy: {} },
			{ kind: SessionActionKind.WritePatch, capability: {}, policy: { allowWorkspaceWrites: true } },
			{ kind: SessionActionKind.RunCommand, capability: {}, policy: { allowCommands: true } },
			{ kind: SessionActionKind.GitStatus, capability: {}, policy: { allowGitMutation: true } },
			{ kind: SessionActionKind.GitDiff, capability: {}, policy: { allowGitMutation: true } },
			{ kind: SessionActionKind.OpenWorktree, capability: { canOpenWorktrees: true }, policy: { allowWorktreeMutation: true } },
		] as const;

		for (const testCase of cases) {
			const harness = createSessionActionHarness(disposables, {
				providerCapabilityOverrides: testCase.capability,
				policyOverrides: testCase.policy,
			});

			const result = await harness.service.approveAction(testSessionId, testProviderId, createActionForKind(testCase.kind));

			assert.strictEqual(result.status, SessionActionStatus.Approved, `Expected ${testCase.kind} to be approved when capability and policy allow it.`);
			assert.strictEqual(result.kind, testCase.kind);
		}
	});
});
