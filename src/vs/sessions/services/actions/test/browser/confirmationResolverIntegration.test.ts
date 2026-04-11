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
import { SessionActionReceiptStatus } from '../../common/sessionActionReceipts.js';
import { SessionActionDenialReason, SessionActionKind, SessionHostKind } from '../../common/sessionActionTypes.js';
import { ISessionsManagementService } from '../../../sessions/common/sessionsManagement.js';
import { createActiveSession, createSessionActionHarness, testRepositoryRoot } from './sessionActionTestUtils.js';

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

suite('ConfirmationResolverIntegration', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('local write confirmations create approved write receipts through SessionActionService', async () => {
		const providerId = 'local-agent-host';
		const sessionId = 'sess-confirm-local';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
			policyOverrides: { allowWorkspaceWrites: true },
			approval: {
				required: true,
				granted: true,
				source: 'dialog',
				summary: 'Approved local write.',
				fingerprint: 'fp-local-write',
			},
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'agent-host-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const resolver = new SessionsAgentHostToolConfirmationResolverService({ activeSession: observableValue('activeSession', activeSession) } as ISessionsManagementService, harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Local,
			connectionAuthority: 'local',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-1',
			toolCallId: 'tc-write',
			invocation: createInvocation('write_file', { filePath: '/workspace/repo/file.txt' }, '{"filePath":"/workspace/repo/file.txt"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});
		const receipt = harness.service.getReceiptsForSession(sessionId)[0];

		assert.deepStrictEqual(result, { confirmedReason: { type: ToolConfirmKind.UserAction } });
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Approved);
		assert.strictEqual(receipt.actionKind, SessionActionKind.WritePatch);
		assert.strictEqual(receipt.approvalSummary, 'Approved local write.');
	});

	test('remote command confirmations create denied receipts when approval is rejected', async () => {
		const providerId = 'remote-agent-host-1';
		const sessionId = 'sess-confirm-remote';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
			providerCapabilityOverrides: { hostKind: SessionHostKind.Remote },
			policyOverrides: { allowCommands: true },
			approval: {
				required: true,
				granted: false,
				source: 'dialog',
				summary: 'Denied remote command approval.',
				fingerprint: 'fp-remote-denied',
			},
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'remote-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const resolver = new SessionsAgentHostToolConfirmationResolverService({ activeSession: observableValue('activeSession', activeSession) } as ISessionsManagementService, harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Remote,
			connectionAuthority: 'remote-host',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-1',
			toolCallId: 'tc-bash',
			invocation: createInvocation('bash', { command: 'npm test' }, 'npm test'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});
		const receipt = harness.service.getReceiptsForSession(sessionId)[0];

		assert.deepStrictEqual(result, {
			confirmedReason: { type: ToolConfirmKind.Denied },
			reasonMessage: 'Denied remote command approval.',
		});
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Denied);
		assert.strictEqual(receipt.actionKind, SessionActionKind.RunCommand);
		assert.strictEqual(receipt.denialReason, SessionActionDenialReason.ApprovalDenied);
		assert.strictEqual(receipt.approvalSummary, 'Denied remote command approval.');
		assert.strictEqual(receipt.approvalFingerprint, 'fp-remote-denied');
	});
});
