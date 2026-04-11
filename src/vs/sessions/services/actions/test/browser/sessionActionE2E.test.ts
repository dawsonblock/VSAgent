/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostToolConfirmationSource } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostToolConfirmationResolverService.js';
import { IChatToolInvocation, ToolConfirmKind } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { SessionsAgentHostToolConfirmationResolverService } from '../../browser/agentHostToolConfirmationResolverService.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionStatus } from '../../common/sessionActionTypes.js';
import { SessionActionHarnessOptions, createActionForKind, createActiveSession, createSessionActionHarness, createSessionsManagementServiceStub, testFileResource, testProviderId, testRepositoryRoot, testSessionId, testWorktreeRoot } from './sessionActionTestUtils.js';

function createInvocation(toolId: string, parameters: unknown, rawInput?: string): IChatToolInvocation {
	return {
		kind: 'toolInvocation',
		toolId,
		toolCallId: `tc-${toolId}`,
		invocationMessage: rawInput ?? toolId,
		state: observableValue('state', {
			type: IChatToolInvocation.StateKind.WaitingForConfirmation,
			parameters,
			confirm: () => { },
		}),
		toolSpecificData: rawInput ? { kind: 'input', rawInput: { input: rawInput } } : undefined,
	} as unknown as IChatToolInvocation;
}

suite('SessionActionE2E', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('successful execution flows through approval, executor, receipt, and log output', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowCommands: true },
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipts = harness.service.getReceiptsForSession(testSessionId);

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(receipts.length, 1);
		assert.strictEqual(receipts[0].status, SessionActionReceiptStatus.Executed);
		assert.strictEqual(receipts[0].command, 'npm');
		assert.strictEqual(receipts[0].approvalSummary, 'Approved.');
		assert.strictEqual(receipts[0].approvalFingerprint, 'approval-fingerprint');
		assert.strictEqual(receipts[0].executionSummary, 'Command completed successfully.');
	});

	test('policy denial creates a denied receipt with the policy reason', async () => {
		const harness = createSessionActionHarness(disposables);

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipts = harness.service.getReceiptsForSession(testSessionId);

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.PolicyDenied);
		assert.strictEqual(receipts.length, 1);
		assert.strictEqual(receipts[0].status, SessionActionReceiptStatus.Denied);
		assert.strictEqual(receipts[0].denialReason, SessionActionDenialReason.PolicyDenied);
	});

	test('capability denial blocks execution before approval or executor work', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowCommands: true },
			providerCapabilityOverrides: { canRunCommands: false },
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
		assert.strictEqual(harness.getApprovalCalls(), 0);
		assert.strictEqual(harness.getExecuteCalls(), 0);
		assert.strictEqual(harness.service.getReceiptsForSession(testSessionId)[0].denialReason, SessionActionDenialReason.ProviderCapabilityMissing);
	});

	test('approval denial preserves approval metadata in the final receipt', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowCommands: true },
			approval: {
				required: true,
				granted: false,
				source: 'dialog',
				summary: 'Approval blocked.',
				fingerprint: 'fp-blocked',
			},
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

		assert.strictEqual(result.status, SessionActionStatus.Denied);
		assert.strictEqual(result.denialReason, SessionActionDenialReason.ApprovalDenied);
		assert.strictEqual(receipt.approvalSummary, 'Approval blocked.');
		assert.strictEqual(receipt.approvalFingerprint, 'fp-blocked');
		assert.strictEqual(receipt.denialReason, SessionActionDenialReason.ApprovalDenied);
	});

	test('explicit approval grant executes and preserves approval metadata', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: { allowCommands: true },
			approval: {
				required: true,
				granted: true,
				source: 'dialog',
				summary: 'Approved by dialog.',
				fingerprint: 'fp-approved',
			},
		});

		const result = await harness.service.submitAction(testSessionId, testProviderId, createActionForKind(SessionActionKind.RunCommand));
		const receipt = harness.service.getReceiptsForSession(testSessionId)[0];

		assert.strictEqual(result.status, SessionActionStatus.Executed);
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Executed);
		assert.strictEqual(receipt.approvalSummary, 'Approved by dialog.');
		assert.strictEqual(receipt.approvalFingerprint, 'fp-approved');
	});

	test('non-command action kinds produce auditable receipts through the full Sessions action spine', async () => {
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
					assert.strictEqual(receipt.executionSummary, 'Found 1 workspace search match.');
				},
			},
			{
				kind: SessionActionKind.ReadFile,
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.resource?.toString(), testFileResource.toString());
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
					assert.strictEqual(receipt.executionSummary, 'Applied file updates.');
				},
			},
			{
				kind: SessionActionKind.GitStatus,
				options: { policyOverrides: { allowGitMutation: true } },
				expectedStatus: SessionActionStatus.Executed,
				expectedReceiptStatus: SessionActionReceiptStatus.Executed,
				assertReceipt: receipt => {
					assert.strictEqual(receipt.repositoryPath?.toString(), testRepositoryRoot.toString());
					assert.ok(receipt.stdout?.includes('"head": "main"'));
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
					assert.strictEqual(receipt.denialReason, SessionActionDenialReason.UnsupportedAction);
					assert.strictEqual(receipt.worktreePath?.toString(), testWorktreeRoot.toString());
					assert.strictEqual(receipt.branch, 'feature');
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
			assert.strictEqual(receipt.actionKind, testCase.kind);
			assert.strictEqual(receipt.approvalSummary, 'Approved.');
			testCase.assertReceipt(receipt);
		}
	});

	test('agent-host confirmation resolves through the Sessions action spine and yields an auditable receipt', async () => {
		const providerId = 'local-agent-host';
		const sessionId = 'sess-e2e';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
			policyOverrides: { allowWorkspaceWrites: true },
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'agent-host-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const managementService = createSessionsManagementServiceStub(activeSession);
		const resolver = new SessionsAgentHostToolConfirmationResolverService(managementService, harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Local,
			connectionAuthority: 'local',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-1',
			toolCallId: 'tc-write',
			invocation: createInvocation('write_file', { filePath: '/workspace/repo/file.txt' }, '{"filePath":"/workspace/repo/file.txt"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});
		const receipts = harness.service.getReceiptsForSession(sessionId);

		assert.deepStrictEqual(result, { confirmedReason: { type: ToolConfirmKind.UserAction } });
		assert.strictEqual(receipts.length, 1);
		assert.strictEqual(receipts[0].status, SessionActionReceiptStatus.Approved);
		assert.strictEqual(receipts[0].actionKind, SessionActionKind.WritePatch);
		assert.strictEqual(receipts[0].approvalSummary, 'Approved.');
	});
});
