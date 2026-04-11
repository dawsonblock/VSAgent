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
import { createActiveSession, createSessionActionHarness, createSessionsManagementServiceStub, testRepositoryRoot } from './sessionActionTestUtils.js';

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
		const resolver = new SessionsAgentHostToolConfirmationResolverService(createSessionsManagementServiceStub(activeSession), harness.providersService, harness.service);

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
		const resolver = new SessionsAgentHostToolConfirmationResolverService(createSessionsManagementServiceStub(activeSession), harness.providersService, harness.service);

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

	test('remote command confirmations create approved command receipts when approval is granted', async () => {
		const providerId = 'remote-agent-host-2';
		const sessionId = 'sess-confirm-remote-approved';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
			providerCapabilityOverrides: { hostKind: SessionHostKind.Remote },
			policyOverrides: { allowCommands: true },
			approval: {
				required: true,
				granted: true,
				source: 'dialog',
				summary: 'Approved remote command approval.',
				fingerprint: 'fp-remote-approved',
			},
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'remote-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const resolver = new SessionsAgentHostToolConfirmationResolverService(createSessionsManagementServiceStub(activeSession), harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Remote,
			connectionAuthority: 'remote-host',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-2',
			toolCallId: 'tc-bash-approved',
			invocation: createInvocation('bash', { command: 'npm test' }, 'npm test'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});
		const receipt = harness.service.getReceiptsForSession(sessionId)[0];

		assert.deepStrictEqual(result, { confirmedReason: { type: ToolConfirmKind.UserAction } });
		assert.strictEqual(receipt.status, SessionActionReceiptStatus.Approved);
		assert.strictEqual(receipt.actionKind, SessionActionKind.RunCommand);
		assert.strictEqual(receipt.command, 'npm test');
		assert.strictEqual(receipt.approvalSummary, 'Approved remote command approval.');
		assert.strictEqual(receipt.approvalFingerprint, 'fp-remote-approved');
	});

	test('read-only confirmations stay outside the typed action spine when workspace reads are allowed', async () => {
		const providerId = 'local-agent-host-read';
		const sessionId = 'sess-confirm-read';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'agent-host-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const resolver = new SessionsAgentHostToolConfirmationResolverService(createSessionsManagementServiceStub(activeSession), harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Local,
			connectionAuthority: 'local',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-3',
			toolCallId: 'tc-read-file',
			invocation: createInvocation('read_file', { filePath: '/workspace/repo/file.txt' }, '{"filePath":"/workspace/repo/file.txt"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(harness.service.getReceiptsForSession(sessionId), []);
	});

	test('read-only confirmations are denied when the provider cannot read the workspace', async () => {
		const providerId = 'local-agent-host-read-denied';
		const sessionId = 'sess-confirm-read-denied';
		const harness = createSessionActionHarness(disposables, {
			providerId,
			sessionId,
			providerCapabilityOverrides: { canReadWorkspace: false },
		});
		const activeSession = createActiveSession(providerId, URI.from({ scheme: 'agent-host-copilot', path: `/${sessionId}` }), testRepositoryRoot, sessionId);
		const resolver = new SessionsAgentHostToolConfirmationResolverService(createSessionsManagementServiceStub(activeSession), harness.providersService, harness.service);

		const result = await resolver.resolveToolConfirmation({
			source: AgentHostToolConfirmationSource.Local,
			connectionAuthority: 'local',
			session: AgentSession.uri('copilot', sessionId),
			turnId: 'turn-4',
			toolCallId: 'tc-read-file-denied',
			invocation: createInvocation('read_file', { filePath: '/workspace/repo/file.txt' }, '{"filePath":"/workspace/repo/file.txt"}'),
			confirmedReason: { type: ToolConfirmKind.UserAction },
		});

		assert.deepStrictEqual(result, {
			confirmedReason: { type: ToolConfirmKind.Denied },
			reasonMessage: 'The active Sessions provider can\'t approve workspace-read tool \'read_file\'.',
		});
		assert.deepStrictEqual(harness.service.getReceiptsForSession(sessionId), []);
	});
});
