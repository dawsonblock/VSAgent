/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../../../services/actions/common/sessionActionReceipts.js';
import { SessionHostKind, SessionActionKind, SessionActionDenialReason, SessionWriteOperationStatus } from '../../../../services/actions/common/sessionActionTypes.js';
import { buildTree, formatSessionActionLogText, getSessionActionLogDetailItems } from '../../browser/sessionActionLogView.js';

suite('SessionActionLogView', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createReceipt(id: string, status: SessionActionReceiptStatus, requestedAt: number, overrides: Partial<SessionActionReceipt> = {}) {
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
			query: undefined,
			includePattern: undefined,
			isRegexp: undefined,
			maxResults: undefined,
			resultCount: undefined,
			matchCount: undefined,
			searchMatches: undefined,
			resource: undefined,
			startLine: undefined,
			endLine: undefined,
			readContents: undefined,
			readEncoding: undefined,
			readByteSize: undefined,
			readLineCount: undefined,
			readIsPartial: undefined,
			ref: undefined,
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
			operation: 'workspace edit',
			operationCount: 1,
			writeOperations: [{ resource: URI.file('/workspace/repo/file.ts'), status: SessionWriteOperationStatus.Updated, bytesWritten: 12 }],
			cwd: URI.file('/workspace/repo'),
			repositoryPath: URI.file('/workspace/repo'),
			worktreePath: URI.file('/workspace/repo'),
			command: 'npm',
			args: ['test'],
			branch: 'feature',
			filesChanged: undefined,
			insertions: undefined,
			deletions: undefined,
			gitChanges: undefined,
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
			...overrides,
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
		assert.ok(details.some(detail => detail.label === 'Approval Summary'));
		assert.ok(details.some(detail => detail.label === 'Approval Fingerprint'));
		assert.ok(details.some(detail => detail.label === 'Provider'));
		assert.ok(details.some(detail => detail.label === 'Host'));
		assert.ok(details.some(detail => detail.label === 'Requested Scope'));
		assert.ok(details.some(detail => detail.label === 'Approved Scope'));
		assert.ok(details.some(detail => detail.label === 'Operation'));
		assert.ok(details.some(detail => detail.label === 'Operation Count'));
		assert.ok(details.some(detail => detail.label === 'Write Operations'));
		assert.ok(details.some(detail => detail.label === 'Touched Files'));
		assert.ok(details.some(detail => detail.label === 'Denial Reason'));
		assert.ok(details.some(detail => detail.label === 'Denial'));
		assert.ok(text.includes('Action log for Session One'));
		assert.ok(text.includes('| Denied | writePatch | provider-1 | remote'));
		assert.ok(text.includes('Denied'));
		assert.ok(text.includes('Denied by policy'));
		assert.ok(text.includes('- Requested Scope:'));
		assert.ok(text.includes('- Approved Scope:'));
		assert.ok(text.includes('- Host: remote | provider-1 | remote-host'));
		assert.ok(text.includes('- Touched Files: file:///workspace/repo/file.ts'));
	});

	test('renders action-specific detail rows for each action kind', () => {
		interface ActionDetailCase {
			readonly kind: SessionActionKind;
			readonly overrides: Partial<SessionActionReceipt>;
			readonly expectedLabels: readonly string[];
			readonly forbiddenLabels: readonly string[];
			readonly status?: SessionActionReceiptStatus;
		}

		const cases: readonly ActionDetailCase[] = [
			{
				kind: SessionActionKind.SearchWorkspace,
				overrides: { query: 'needle', includePattern: 'src/**', isRegexp: true, maxResults: 25, resultCount: 3, matchCount: 4, searchMatches: [{ resource: URI.file('/workspace/repo/file.ts'), lineNumber: 2, lineNumbers: [2], preview: 'needle', matchCount: 1 }] },
				expectedLabels: ['Query', 'Include Pattern', 'Regular Expression', 'Max Results', 'Result Count', 'Match Count', 'Matches'],
				forbiddenLabels: ['Resource', 'Command', 'Arguments', 'Repository', 'Ref', 'Branch', 'Touched Files'],
			},
			{
				kind: SessionActionKind.ReadFile,
				overrides: { resource: URI.file('/workspace/repo/notes.md'), startLine: 3, endLine: 9, readContents: 'content', readEncoding: 'utf8', readByteSize: 12, readLineCount: 1, readIsPartial: true },
				expectedLabels: ['Resource', 'Start Line', 'End Line', 'Encoding', 'Byte Size', 'Line Count', 'Partial Read', 'Contents'],
				forbiddenLabels: ['Query', 'Command', 'Arguments', 'Repository', 'Ref', 'Branch', 'Touched Files'],
			},
			{
				kind: SessionActionKind.WritePatch,
				overrides: {},
				expectedLabels: ['Operation', 'Operation Count', 'Touched Files', 'Write Operations'],
				forbiddenLabels: ['Query', 'Resource', 'Command', 'Arguments', 'Repository', 'Ref', 'Branch'],
			},
			{
				kind: SessionActionKind.RunCommand,
				overrides: { stderr: 'warning output' },
				expectedLabels: ['Cwd', 'Command', 'Arguments', 'Stdout', 'Stderr'],
				forbiddenLabels: ['Query', 'Resource', 'Repository', 'Ref', 'Branch', 'Touched Files'],
			},
			{
				kind: SessionActionKind.GitStatus,
				overrides: { operation: 'git status', branch: 'main', filesChanged: 2, stderr: 'git warning' },
				expectedLabels: ['Repository', 'Operation', 'Branch', 'Files Changed', 'Stdout', 'Stderr'],
				forbiddenLabels: ['Query', 'Resource', 'Command', 'Arguments', 'Ref', 'Touched Files'],
			},
			{
				kind: SessionActionKind.GitDiff,
				overrides: { operation: 'git diff HEAD~1', ref: 'HEAD~1', filesChanged: 1, insertions: 1, deletions: 0, gitChanges: [{ resource: URI.file('/workspace/repo/file.ts'), insertions: 1, deletions: 0 }], stderr: 'git diff warning' },
				expectedLabels: ['Repository', 'Operation', 'Ref', 'Files Changed', 'Insertions', 'Deletions', 'Changes', 'Stdout', 'Stderr'],
				forbiddenLabels: ['Query', 'Resource', 'Command', 'Arguments', 'Branch', 'Touched Files'],
			},
			{
				kind: SessionActionKind.OpenWorktree,
				status: SessionActionReceiptStatus.Failed,
				overrides: { operation: 'git worktree add', stderr: 'not supported' },
				expectedLabels: ['Repository', 'Operation', 'Worktree', 'Branch', 'Stdout', 'Stderr'],
				forbiddenLabels: ['Query', 'Resource', 'Command', 'Arguments', 'Ref', 'Touched Files'],
			},
		];

		for (const [index, testCase] of cases.entries()) {
			const details = getSessionActionLogDetailItems(createReceipt(`case-${index}`, testCase.status ?? SessionActionReceiptStatus.Executed, index + 1, {
				actionKind: testCase.kind,
				...testCase.overrides,
			}));
			const labels = details.map(detail => detail.label);

			for (const label of testCase.expectedLabels) {
				assert.ok(labels.includes(label), `Expected ${testCase.kind} to include '${label}'.`);
			}

			for (const label of testCase.forbiddenLabels) {
				assert.ok(!labels.includes(label), `Expected ${testCase.kind} to omit '${label}'.`);
			}
		}
	});
});
