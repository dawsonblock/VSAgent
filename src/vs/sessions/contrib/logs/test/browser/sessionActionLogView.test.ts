/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceiptStatus } from '../../../../services/actions/common/sessionActionReceipts.js';
import { SessionHostKind, SessionActionKind, SessionActionDenialReason } from '../../../../services/actions/common/sessionActionTypes.js';
import { buildTree, formatSessionActionLogText, getSessionActionLogDetailItems } from '../../browser/sessionActionLogView.js';

suite('SessionActionLogView', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createReceipt(id: string, status: SessionActionReceiptStatus, requestedAt: number) {
		return {
			id,
			sessionId: 'session-1',
			providerId: 'provider-1',
			hostKind: SessionHostKind.Remote,
			hostTarget: {
				kind: SessionHostKind.Remote,
				providerId: 'provider-1',
				authority: 'remote-host',
			},
			actionId: `action-${id}`,
			actionKind: SessionActionKind.WritePatch,
			requestedScope: {
				workspaceRoot: URI.file('/workspace'),
				projectRoot: URI.file('/workspace/repo'),
				repositoryPath: URI.file('/workspace/repo'),
				worktreeRoot: URI.file('/workspace/repo'),
				cwd: URI.file('/workspace/repo'),
				files: [URI.file('/workspace/repo/file.ts')],
				hostTarget: {
					kind: SessionHostKind.Remote,
					providerId: 'provider-1',
					authority: 'remote-host',
				},
			},
			approvedScope: {
				workspaceRoot: URI.file('/workspace'),
				projectRoot: URI.file('/workspace/repo'),
				repositoryPath: URI.file('/workspace/repo'),
				worktreeRoot: URI.file('/workspace/repo'),
				cwd: URI.file('/workspace/repo'),
				files: [URI.file('/workspace/repo/file.ts')],
				hostTarget: {
					kind: SessionHostKind.Remote,
					providerId: 'provider-1',
					authority: 'remote-host',
				},
			},
			requestedAt,
			decidedAt: requestedAt,
			completedAt: requestedAt,
			status,
			filesTouched: [URI.file('/workspace/repo/file.ts')],
			cwd: URI.file('/workspace/repo'),
			repositoryPath: URI.file('/workspace/repo'),
			worktreePath: URI.file('/workspace/repo'),
			command: 'npm',
			args: ['test'],
			branch: 'feature',
			stdout: 'ok',
			stderr: undefined,
			approvalSummary: 'Approved write',
			approvalFingerprint: 'fp-1',
			denialReason: status === SessionActionReceiptStatus.Denied ? SessionActionDenialReason.PolicyDenied : undefined,
			approval: {
				required: true,
				granted: true,
				source: 'dialog' as const,
				summary: 'Approved write',
				fingerprint: 'fp-1',
			},
			denial: status === SessionActionReceiptStatus.Denied ? {
				reason: SessionActionDenialReason.PolicyDenied,
				message: 'Denied by policy',
			} : undefined,
			advisorySources: ['agentHostToolConfirmation'],
			executionSummary: 'Applied file updates for 1 target.',
			error: status === SessionActionReceiptStatus.Failed ? {
				name: 'failed',
				message: 'Something failed',
			} : undefined,
		};
	}

	test('buildTree sorts receipts newest first', () => {
		const older = createReceipt('older', SessionActionReceiptStatus.Executed, 10);
		const newer = createReceipt('newer', SessionActionReceiptStatus.Failed, 20);
		const tree = buildTree([older, newer]);

		assert.strictEqual(tree.length, 2);
		assert.strictEqual(tree[0].element.type, 'receipt');
		assert.strictEqual(tree[0].element.type === 'receipt' ? tree[0].element.receipt.id : undefined, 'newer');
		assert.strictEqual(tree[1].element.type === 'receipt' ? tree[1].element.receipt.id : undefined, 'older');
		assert.ok(Array.from(tree[0].children ?? []).length > 0);
	});

	test('formats detail items and accessible text from receipts', () => {
		const receipt = createReceipt('receipt', SessionActionReceiptStatus.Denied, 10);
		const details = getSessionActionLogDetailItems(receipt);
		const text = formatSessionActionLogText('Session One', [receipt]);

		assert.ok(details.some(detail => detail.label === 'Approval'));
		assert.ok(details.some(detail => detail.label === 'Provider'));
		assert.ok(details.some(detail => detail.label === 'Host'));
		assert.ok(details.some(detail => detail.label === 'Command'));
		assert.ok(details.some(detail => detail.label === 'Requested Scope'));
		assert.ok(details.some(detail => detail.label === 'Approved Scope'));
		assert.ok(details.some(detail => detail.label === 'Repository'));
		assert.ok(details.some(detail => detail.label === 'Worktree'));
		assert.ok(details.some(detail => detail.label === 'Denial Reason'));
		assert.ok(details.some(detail => detail.label === 'Denial'));
		assert.ok(details.some(detail => detail.label === 'Stdout'));
		assert.ok(text.includes('Action log for Session One'));
		assert.ok(text.includes('| Denied | writePatch | provider-1 | remote'));
		assert.ok(text.includes('Denied'));
		assert.ok(text.includes('Denied by policy'));
		assert.ok(text.includes('- Requested Scope:'));
		assert.ok(text.includes('- Approved Scope:'));
		assert.ok(text.includes('- Host: remote | provider-1 | remote-host'));
		assert.ok(text.includes('- Repository: file:///workspace/repo'));
	});
});
