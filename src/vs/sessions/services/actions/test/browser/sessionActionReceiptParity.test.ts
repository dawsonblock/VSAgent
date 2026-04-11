/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { SessionActionKind, SessionActionStatus, SessionHostKind } from '../../common/sessionActionTypes.js';
import { SessionActionHarnessOptions, createActionForKind, createSessionActionHarness, testFileResource, testProviderId, testRepositoryRoot, testSessionId, testWorktreeRoot } from './sessionActionTestUtils.js';

suite('SessionActionReceiptParity', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('every action kind produces a receipt with consistent core audit data and action-specific richness', async () => {
		interface ReceiptParityCase {
			readonly kind: SessionActionKind;
			readonly options?: Pick<SessionActionHarnessOptions, 'policyOverrides' | 'providerCapabilityOverrides'>;
			readonly expectedStatus: SessionActionStatus;
			readonly expectedReceiptStatus: SessionActionReceiptStatus;
			readonly assertReceipt: (receipt: SessionActionReceipt) => void;
		}

		const cases: readonly ReceiptParityCase[] = [
			{
				kind: SessionActionKind.SearchWorkspace,
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.query, 'needle');
					assert.strictEqual(receipt.resultCount, 1);
					assert.strictEqual(receipt.matchCount, 1);
					assert.deepStrictEqual(receipt.searchMatches?.map(match => match.lineNumbers), [[1]]);
					assert.strictEqual(receipt.executionSummary, 'Found 1 workspace search match.');
				},
			},
			{
				kind: SessionActionKind.ReadFile,
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.resource?.toString(), testFileResource.toString());
					assert.strictEqual(receipt.readContents, 'file contents');
					assert.strictEqual(receipt.readEncoding, 'utf8');
					assert.strictEqual(receipt.readByteSize, 13);
					assert.strictEqual(receipt.readLineCount, 1);
					assert.strictEqual(receipt.executionSummary, 'Read file.');
				},
			},
			{
				kind: SessionActionKind.WritePatch,
				options: { policyOverrides: { allowWorkspaceWrites: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.deepStrictEqual(receipt.filesTouched.map(file => file.toString()), [testFileResource.toString()]);
					assert.strictEqual(receipt.operation, 'workspace edit');
					assert.strictEqual(receipt.operationCount, 1);
					assert.strictEqual(receipt.writeOperations?.[0].status, 'updated');
					assert.strictEqual(receipt.executionSummary, 'Applied file updates.');
				},
			},
			{
				kind: SessionActionKind.RunCommand,
				options: { policyOverrides: { allowCommands: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.cwd?.toString(), testRepositoryRoot.toString());
					assert.strictEqual(receipt.stdout, 'command output');
					assert.strictEqual(receipt.stderr, '');
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
					assert.strictEqual(receipt.filesChanged, 1);
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
					assert.strictEqual(receipt.filesChanged, 1);
					assert.strictEqual(receipt.insertions, 1);
					assert.strictEqual(receipt.deletions, 0);
					assert.ok(receipt.stdout?.includes(testFileResource.toString()));
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
					assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
					assert.strictEqual(receipt.worktreePath?.toString(), testWorktreeRoot.toString());
					assert.strictEqual(receipt.branch, 'feature');
					assert.strictEqual(receipt.operation, 'git worktree add');
					assert.ok(receipt.stderr?.includes('not yet supported'));
				},
			},
		];

		for (const testCase of cases) {
			const harness = createSessionActionHarness(disposables, testCase.options);
			const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(testCase.kind));
			const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

			assert.strictEqual(result.status, testCase.expectedStatus, `Unexpected action result for ${testCase.kind}.`);
			assert.strictEqual(receipt.status, testCase.expectedReceiptStatus, `Unexpected receipt status for ${testCase.kind}.`);
			assert.ok(receipt.actionId.length > 0);
			assert.strictEqual(receipt.sessionId, testSessionId);
			assert.strictEqual(receipt.providerId, testProviderId);
			assert.strictEqual(receipt.hostKind, SessionHostKind.Local);
			assert.ok(receipt.requestedScope.workspaceRoot);
			assert.ok(receipt.approvedScope.projectRoot);
			assert.ok(receipt.requestedAt <= receipt.decidedAt);
			assert.ok((receipt.completedAt ?? receipt.decidedAt) >= receipt.decidedAt);
			assert.ok((receipt.executionSummary ?? receipt.error?.message)?.length);
			testCase.assertReceipt(receipt);
		}
	});
});
