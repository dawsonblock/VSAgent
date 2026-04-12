/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../../../services/actions/common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionHostKind, SessionWriteOperationStatus } from '../../../../services/actions/common/sessionActionTypes.js';
import { formatSessionActionLogText, getSessionActionLogDetailItems } from '../../browser/sessionActionLogView.js';

suite('SessionActionLogParity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createReceipt(actionKind: SessionActionKind, overrides: Partial<SessionActionReceipt> = {}): SessionActionReceipt {
		return {
			id: `receipt-${actionKind}`,
			sessionId: 'session-1',
			providerId: 'provider-1',
			hostKind: SessionHostKind.Remote,
			hostTarget: {
				kind: SessionHostKind.Remote,
				providerId: 'provider-1',
				authority: 'remote-host',
			},
			actionId: `action-${actionKind}`,
			actionKind,
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
			requestedAt: 10,
			decidedAt: 10,
			completedAt: 10,
			status: SessionActionReceiptStatus.Executed,
			filesTouched: [URI.file('/workspace/repo/file.ts')],
			operation: undefined,
			operationCount: undefined,
			writeOperations: undefined,
			cwd: URI.file('/workspace/repo'),
			repositoryPath: URI.file('/workspace/repo'),
			worktreePath: URI.file('/workspace/repo-worktree'),
			command: 'npm',
			args: ['test'],
			branch: 'feature',
			filesChanged: undefined,
			insertions: undefined,
			deletions: undefined,
			gitChanges: undefined,
			stdout: 'ok',
			stderr: '',
			approvalSummary: 'Approved.',
			approvalFingerprint: 'fp-1',
			denialReason: undefined,
			approval: {
				required: false,
				granted: true,
				source: 'implicit',
				summary: 'Approved.',
				fingerprint: 'fp-1',
			},
			denial: undefined,
			advisorySources: ['agentHostToolConfirmation'],
			executionSummary: 'Summary text.',
			error: undefined,
			...overrides,
		};
	}

	test('every action kind is visible in the log core and shows the expected action-specific detail rows', () => {
		interface LogCase {
			readonly kind: SessionActionKind;
			readonly receipt: SessionActionReceipt;
			readonly expectedLabels: readonly string[];
			readonly expectedText: readonly string[];
		}

		const cases: readonly LogCase[] = [
			{
				kind: SessionActionKind.SearchWorkspace,
				receipt: createReceipt(SessionActionKind.SearchWorkspace, {
					query: 'needle',
					resultCount: 3,
					matchCount: 4,
					searchMatches: [{ resource: URI.file('/workspace/repo/file.ts'), lineNumber: 2, lineNumbers: [2, 5], preview: 'needle', matchCount: 2 }],
					executionSummary: 'Found 3 workspace search match(es).',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Query', 'Result Count', 'Match Count', 'Matches'],
				expectedText: ['| Executed | searchWorkspace | provider-1 | remote', 'Found 3 workspace search match(es).', '- Query: needle', '- Match Count: 4'],
			},
			{
				kind: SessionActionKind.ReadFile,
				receipt: createReceipt(SessionActionKind.ReadFile, {
					resource: URI.file('/workspace/repo/notes.md'),
					readContents: 'line one',
					readEncoding: 'utf8',
					readByteSize: 8,
					readLineCount: 1,
					executionSummary: 'Read file.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Resource', 'Encoding', 'Byte Size', 'Line Count', 'Contents'],
				expectedText: ['| Executed | readFile | provider-1 | remote', 'Read file.', '- Resource: file:///workspace/repo/notes.md', '- Encoding: utf8'],
			},
			{
				kind: SessionActionKind.WritePatch,
				receipt: createReceipt(SessionActionKind.WritePatch, {
					operation: 'workspace edit',
					operationCount: 1,
					writeOperations: [{ resource: URI.file('/workspace/repo/file.ts'), status: SessionWriteOperationStatus.Updated, bytesWritten: 12 }],
					executionSummary: 'Applied file updates.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Operation', 'Operation Count', 'Touched Files', 'Write Operations'],
				expectedText: ['| Executed | writePatch | provider-1 | remote', 'Applied file updates.', '- Touched Files: file:///workspace/repo/file.ts'],
			},
			{
				kind: SessionActionKind.RunCommand,
				receipt: createReceipt(SessionActionKind.RunCommand, {
					executionSummary: 'Command completed successfully.',
					stdout: 'command output',
					stderr: 'warning output',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Stdout', 'Stderr'],
				expectedText: ['| Executed | runCommand | provider-1 | remote', 'Command completed successfully.', '- Stdout: command output', '- Stderr: warning output'],
			},
			{
				kind: SessionActionKind.GitStatus,
				receipt: createReceipt(SessionActionKind.GitStatus, {
					operation: 'git status',
					branch: 'main',
					filesChanged: 2,
					executionSummary: 'Inspected git status.',
					stdout: '{"branch":"main"}',
					stderr: 'git warning',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Operation', 'Branch', 'Files Changed', 'Stdout', 'Stderr'],
				expectedText: ['| Executed | gitStatus | provider-1 | remote', 'Inspected git status.', '- Repository: file:///workspace/repo'],
			},
			{
				kind: SessionActionKind.GitDiff,
				receipt: createReceipt(SessionActionKind.GitDiff, {
					operation: 'git diff HEAD~1',
					ref: 'HEAD~1',
					filesChanged: 1,
					insertions: 1,
					deletions: 0,
					gitChanges: [{ resource: URI.file('/workspace/repo/file.ts'), insertions: 1, deletions: 0 }],
					executionSummary: 'Inspected git diff.',
					stdout: 'file:///workspace/repo/file.ts (+1/-0)',
					stderr: 'git diff warning',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Operation', 'Ref', 'Files Changed', 'Insertions', 'Deletions', 'Changes', 'Stdout', 'Stderr'],
				expectedText: ['| Executed | gitDiff | provider-1 | remote', 'Inspected git diff.', '- Ref: HEAD~1'],
			},
			{
				kind: SessionActionKind.OpenWorktree,
				receipt: createReceipt(SessionActionKind.OpenWorktree, {
					status: SessionActionReceiptStatus.Failed,
					denialReason: SessionActionDenialReason.UnsupportedAction,
					operation: 'git worktree add',
					executionSummary: 'Worktree creation is not yet supported by the Sessions executor bridge.',
					stderr: 'Worktree creation is not yet supported by the Sessions executor bridge.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Operation', 'Worktree', 'Branch', 'Stdout', 'Stderr'],
				expectedText: ['| Failed | openWorktree | provider-1 | remote', 'Worktree creation is not yet supported by the Sessions executor bridge.', '- Worktree: file:///workspace/repo-worktree'],
			},
		];

		for (const testCase of cases) {
			const details = getSessionActionLogDetailItems(testCase.receipt);
			const labels = details.map(detail => detail.label);
			const text = formatSessionActionLogText('Session One', [testCase.receipt]);

			assert.match(text, /\d{2}:\d{2}:\d{2}/);

			for (const label of testCase.expectedLabels) {
				assert.ok(labels.includes(label), `Expected ${testCase.kind} to include '${label}'.`);
			}

			for (const line of testCase.expectedText) {
				assert.ok(text.includes(line), `Expected ${testCase.kind} log text to include '${line}'.`);
			}
		}
	});
});
