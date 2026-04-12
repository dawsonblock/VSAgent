/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionKind, SessionActionRequestSource, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { createSessionActionHarness } from '../../../actions/test/browser/sessionActionTestUtils.js';
import { SessionAutonomyMode } from '../../../autonomy/common/sessionAutonomyTypes.js';
import { SessionExecutionMemoryService } from '../../browser/sessionExecutionMemoryService.js';
import { SessionPlanningService } from '../../../planning/browser/sessionPlanningService.js';
import { SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';

suite('SessionExecutionMemoryService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('derives advisory progress from traced action receipts', async () => {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides: {
				allowWorkspaceWrites: true,
			},
		});
		const planningService = disposables.add(new SessionPlanningService());
		const memoryService = disposables.add(new SessionExecutionMemoryService(harness.receiptService));
		const file = URI.file('/workspace/repo/src/app.ts');

		const plan = await planningService.createPlan({
			sessionId: harness.session.sessionId,
			providerId: harness.session.providerId,
			intent: 'Repair the repo',
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: harness.session.providerId,
			},
			steps: [
				{
					id: 'search',
					kind: SessionPlanStepKind.SearchWorkspace,
					title: 'Find the symbol',
					action: {
						kind: SessionActionKind.SearchWorkspace,
						requestedBy: SessionActionRequestSource.Session,
						query: 'needle',
					},
				},
				{
					id: 'patch',
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch the file',
					dependsOn: ['search'],
					action: {
						kind: SessionActionKind.WritePatch,
						requestedBy: SessionActionRequestSource.Session,
						patch: 'patch',
						files: [file],
					},
				},
			],
		});

		memoryService.beginPlanning({
			sessionId: plan.sessionId,
			providerId: plan.providerId,
			mode: SessionAutonomyMode.RepoRepair,
			intent: plan.intent,
			summary: plan.summary,
		});
		memoryService.setPlan(plan);
		memoryService.beginExecution(plan);

		await harness.service.submitAction(harness.session.sessionId, harness.session.providerId, {
			...plan.steps[0].action!,
			trace: {
				planId: plan.id,
				planStepId: plan.steps[0].id,
			},
		});

		assert.deepStrictEqual(memoryService.getSessionEntryValue(plan.sessionId)?.progress?.completedStepIds, ['search']);
		assert.strictEqual(memoryService.getSessionEntryValue(plan.sessionId)?.lastReceipt?.planStepId, 'search');

		await harness.service.submitAction(harness.session.sessionId, harness.session.providerId, {
			...plan.steps[1].action!,
			trace: {
				planId: plan.id,
				planStepId: plan.steps[1].id,
				checkpointId: 'checkpoint-1',
			},
		});

		assert.deepStrictEqual(memoryService.getSessionEntryValue(plan.sessionId)?.progress?.completedStepIds, ['search', 'patch']);
		assert.strictEqual(memoryService.getSessionEntryValue(plan.sessionId)?.lastReceipt?.planStepId, 'patch');
		assert.strictEqual(memoryService.getSessionEntryValue(plan.sessionId)?.lastReceipt?.checkpointId, 'checkpoint-1');
	});
});
