/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../../../services/actions/common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionHostKind } from '../../../../services/actions/common/sessionActionTypes.js';
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
			resource: undefined,
			startLine: undefined,
			endLine: undefined,
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
			cwd: URI.file('/workspace/repo'),
			repositoryPath: URI.file('/workspace/repo'),
			worktreePath: URI.file('/workspace/repo-worktree'),
			command: 'npm',
			args: ['test'],
			branch: 'feature',
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
					executionSummary: 'Found 3 workspace search match(es).',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Query', 'Result Count'],
				expectedText: ['| Executed | searchWorkspace | provider-1 | remote', 'Found 3 workspace search match(es).', '- Query: needle'],
			},
			{
				kind: SessionActionKind.ReadFile,
				receipt: createReceipt(SessionActionKind.ReadFile, {
					resource: URI.file('/workspace/repo/notes.md'),
					executionSummary: 'Read file.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Resource'],
				expectedText: ['| Executed | readFile | provider-1 | remote', 'Read file.', '- Resource: file:///workspace/repo/notes.md'],
			},
			{
				kind: SessionActionKind.WritePatch,
				receipt: createReceipt(SessionActionKind.WritePatch, {
					executionSummary: 'Applied file updates.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Touched Files'],
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
					executionSummary: 'Inspected git status.',
					stdout: '{"head":"main"}',
					stderr: 'git warning',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Stdout', 'Stderr'],
				expectedText: ['| Executed | gitStatus | provider-1 | remote', 'Inspected git status.', '- Repository: file:///workspace/repo'],
			},
			{
				kind: SessionActionKind.GitDiff,
				receipt: createReceipt(SessionActionKind.GitDiff, {
					ref: 'HEAD~1',
					executionSummary: 'Inspected git diff.',
					stdout: 'file:///workspace/repo/file.ts (+1/-0)',
					stderr: 'git diff warning',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Ref', 'Stdout', 'Stderr'],
				expectedText: ['| Executed | gitDiff | provider-1 | remote', 'Inspected git diff.', '- Ref: HEAD~1'],
			},
			{
				kind: SessionActionKind.OpenWorktree,
				receipt: createReceipt(SessionActionKind.OpenWorktree, {
					status: SessionActionReceiptStatus.Failed,
					denialReason: SessionActionDenialReason.UnsupportedAction,
					executionSummary: 'Worktree creation is not yet supported by the Sessions executor bridge.',
					stderr: 'Worktree creation is not yet supported by the Sessions executor bridge.',
				}),
				expectedLabels: ['Status', 'Provider', 'Host', 'Repository', 'Worktree', 'Branch', 'Stdout', 'Stderr'],
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
