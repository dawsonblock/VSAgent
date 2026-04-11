/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionHostKind, SessionActionStatus } from '../../common/sessionActionTypes.js';
import { createActionForKind, createSessionActionHarness, testFileResource, testProviderId, testRepositoryRoot, testSessionId } from './sessionActionTestUtils.js';

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
		assert.strictEqual(receipt.executionSummary, 'Applied file updates.');
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
