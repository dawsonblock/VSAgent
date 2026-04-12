/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionHostKind, SessionActionStatus } from '../../common/sessionActionTypes.js';
import { SessionActionHarnessOptions, createActionForKind, createSessionActionHarness, testFileResource, testProviderId, testRepositoryRoot, testSessionId, testWorktreeRoot } from './sessionActionTestUtils.js';

suite('ReceiptCompleteness', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('executed command receipts are self-contained with identity, scope, output, and timestamps', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowCommands: true },
			approval: {
				required: true,
				granted: true,
				source: 'dialog',
				summary: 'Approved command receipt.',
				fingerprint: 'fp-executed',
			},
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.ok(receipt.id.length > 0);
		assert.strictEqual(receipt.sessionId, testSessionId);
		assert.strictEqual(receipt.providerId, testProviderId);
		assert.strictEqual(receipt.hostKind, SessionHostKind.Local);
		assert.strictEqual(receipt.hostTarget.providerId, testProviderId);
		assert.ok(receipt.requestedScope.workspaceRoot);
		assert.ok(receipt.approvedScope.repositoryPath);
		assert.ok(receipt.requestedScope.files.length > 0);
		assert.strictEqual(receipt.approvalSummary, 'Approved command receipt.');
		assert.strictEqual(receipt.approvalFingerprint, 'fp-executed');
		assert.strictEqual(receipt.cwd?.toString(), testRepositoryRoot.toString());
		assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
		assert.strictEqual(receipt.worktreePath?.toString(), testRepositoryRoot.toString());
		assert.strictEqual(receipt.stdout, 'command output');
		assert.strictEqual(receipt.stderr, '');
		assert.ok(receipt.requestedAt <= receipt.decidedAt);
		assert.ok((receipt.completedAt ?? receipt.decidedAt) >= receipt.decidedAt);
	});

	test('write receipts carry touched files without depending on external context', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowWorkspaceWrites: true },
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.WritePatch));
		const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Executed);
		assert.deepStrictEqual(receipt.filesTouched.map(file => file.toString()), [testFileResource.toString()]);
		assert.strictEqual(receipt.operation, 'workspace edit');
		assert.strictEqual(receipt.operationCount, 1);
		assert.strictEqual(receipt.executionSummary, 'Applied file updates.');
	});

	test('non-command receipts preserve action-specific request facts and authoritative execution context', async () => {
		interface NonCommandCase {
			readonly kind: SessionActionKind;
			readonly options?: Pick<SessionActionHarnessOptions, 'policyOverrides' | 'providerCapabilityOverrides'>;
			readonly expectedStatus: SessionActionStatus;
			readonly expectedReceiptStatus: SessionActionReceiptStatus;
			readonly assertReceipt: (receipt: SessionActionReceipt) => void;
		}

		const cases: readonly NonCommandCase[] = [
			{
				kind: SessionActionKind.SearchWorkspace,
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.query, 'needle');
					assert.strictEqual(receipt.maxResults, 5);
					assert.strictEqual(receipt.resultCount, 1);
					assert.strictEqual(receipt.matchCount, 1);
					assert.strictEqual(receipt.executionSummary, 'Found 1 workspace search match.');
				},
			},
			{
				kind: SessionActionKind.ReadFile,
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.resource?.toString(), testFileResource.toString());
					assert.strictEqual(receipt.startLine, undefined);
					assert.strictEqual(receipt.endLine, undefined);
					assert.strictEqual(receipt.readEncoding, 'utf8');
					assert.strictEqual(receipt.readContents, 'file contents');
				},
			},
			{
				kind: SessionActionKind.WritePatch,
				options: { policyOverrides: { allowWorkspaceWrites: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.deepStrictEqual(receipt.filesTouched.map(file => file.toString()), [testFileResource.toString()]);
					assert.strictEqual(receipt.writeOperations?.[0].status, 'updated');
				},
			},
			{
				kind: SessionActionKind.GitStatus,
				options: { policyOverrides: { allowGitMutation: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
					assert.strictEqual(receipt.operation, 'git status');
					assert.strictEqual(receipt.branch, 'main');
					assert.ok(receipt.stdout?.includes('"branch": "main"'));
				},
			},
			{
				kind: SessionActionKind.GitDiff,
				options: { policyOverrides: { allowGitMutation: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
					assert.strictEqual(receipt.ref, 'HEAD~1');
					assert.strictEqual(receipt.operation, 'git diff HEAD~1');
				},
			},
			{
				kind: SessionActionKind.OpenWorktree,
				options: {
					policyOverrides: { allowWorktreeMutation: true },
					providerCapabilityOverrides: { canOpenWorktrees: true, requiresApprovalForWorktreeActions: false },
				},
				expectedStatus: SessionActionStatus.Failed,
				expectedReceiptStatus: SessionActionReceiptStatus.Failed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.denialReason, SessionActionDenialReason.UnsupportedAction);
					assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
					assert.strictEqual(receipt.worktreePath?.toString(), testWorktreeRoot.toString());
					assert.strictEqual(receipt.branch, 'feature');
					assert.strictEqual(receipt.operation, 'git worktree add');
				},
			},
		];

		for (const testCase of cases) {
			const harness = createSessionActionHarness(disposables, testCase.options);
			const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(testCase.kind));
			const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

			assert.strictEqual(result.status, testCase.expectedStatus, `Unexpected action result for ${testCase.kind}.`);
			assert.strictEqual(receipt.status, testCase.expectedReceiptStatus, `Unexpected receipt status for ${testCase.kind}.`);
			assert.strictEqual(receipt.sessionId, testSessionId);
			assert.strictEqual(receipt.providerId, testProviderId);
			assert.strictEqual(receipt.hostKind, SessionHostKind.Local);
			assert.strictEqual(receipt.hostTarget.providerId, testProviderId);
			assert.ok(receipt.requestedScope.workspaceRoot);
			assert.ok(receipt.approvedScope.projectRoot);
			assert.strictEqual(receipt.approvalSummary, 'Approved.');
			assert.ok(receipt.requestedAt <= receipt.decidedAt);
			assert.ok((receipt.completedAt ?? receipt.decidedAt) >= receipt.decidedAt);
			testCase.assertReceipt(receipt);
		}
	});

	test('denied receipts capture denial reasons, errors, and completion timestamps', async () => {
		const harness = createSessionActionHarness(disposables);

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Denied);
		assert.strictEqual(receipt.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.ok(receipt.error?.message.includes('not permitted by the active Sessions policy'));
		assert.ok(receipt.completedAt !== undefined);
	});
});
