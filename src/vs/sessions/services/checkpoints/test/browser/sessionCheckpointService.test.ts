/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionReceipt, SessionActionReceiptStatus } from '../../../actions/common/sessionActionReceipts.js';
import { ISessionActionService } from '../../../actions/common/sessionActionService.js';
import { SessionActionKind, SessionActionRequestSource, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { SessionCheckpointService } from '../../browser/sessionCheckpointService.js';
import { SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';

suite('SessionCheckpointService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('createCheckpoint captures receipt position and target metadata before a mutating step', () => {
		const workspaceRoot = URI.file('/workspace/repo');
		const file = URI.file('/workspace/repo/src/app.ts');
		const receipts: SessionActionReceipt[] = [
			createReceipt('receipt-1', workspaceRoot),
			createReceipt('receipt-2', workspaceRoot),
		];
		const actionService: ISessionActionService = {
			_serviceBrand: undefined,
			onDidAppendReceipt: Event.None,
			onDidChangeActiveAction: Event.None,
			onDidDenyAction: Event.None,
			submitAction: async () => { throw new Error('Not implemented in test'); },
			approveAction: async () => { throw new Error('Not implemented in test'); },
			getReceiptsForSession: () => receipts,
		};
		const service = disposables.add(new SessionCheckpointService(actionService));

		const checkpoint = service.createCheckpoint({
			sessionId: 'session-1',
			providerId: 'provider-1',
			planId: 'plan-1',
			step: {
				id: 'patch',
				kind: SessionPlanStepKind.WritePatch,
				title: 'Patch the file',
				description: 'Prepare to patch the file',
				dependsOn: [],
				action: {
					kind: SessionActionKind.WritePatch,
					requestedBy: SessionActionRequestSource.Session,
					patch: 'patch',
					files: [file],
				},
				estimatedScope: {
					files: [file],
					repositoryPath: workspaceRoot,
					worktreeRoot: workspaceRoot,
				},
				riskClasses: [SessionPlanRiskClass.RepoMutation],
				estimatedApprovalRequired: true,
				checkpointRequirement: SessionPlanCheckpointRequirement.Required,
			},
		});

		assert.strictEqual(checkpoint.preActionReceiptCount, 2);
		assert.strictEqual(checkpoint.previousReceiptId, 'receipt-2');
		assert.deepStrictEqual(checkpoint.targetFiles.map(resource => resource.toString()), [file.toString()]);
		assert.strictEqual(checkpoint.repositoryPath?.toString(), workspaceRoot.toString());
		assert.strictEqual(checkpoint.worktreeRoot?.toString(), workspaceRoot.toString());
		assert.strictEqual(service.getCheckpoint(checkpoint.id), checkpoint);
		assert.deepStrictEqual(service.getCheckpointsForSession('session-1'), [checkpoint]);
	});
});

function createReceipt(id: string, workspaceRoot: URI): SessionActionReceipt {
	return {
		id,
		sessionId: 'session-1',
		providerId: 'provider-1',
		hostKind: SessionHostKind.Local,
		hostTarget: {
			kind: SessionHostKind.Local,
			providerId: 'provider-1',
		},
		actionId: `${id}-action`,
		actionKind: SessionActionKind.ReadFile,
		requestedScope: {
			workspaceRoot,
			projectRoot: workspaceRoot,
			repositoryPath: workspaceRoot,
			worktreeRoot: workspaceRoot,
			files: [],
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: 'provider-1',
			},
		},
		approvedScope: {
			workspaceRoot,
			projectRoot: workspaceRoot,
			repositoryPath: workspaceRoot,
			worktreeRoot: workspaceRoot,
			files: [],
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: 'provider-1',
			},
		},
		requestedAt: 1,
		decidedAt: 2,
		completedAt: 3,
		status: SessionActionReceiptStatus.Executed,
		filesTouched: [],
		advisorySources: [],
	};
}
