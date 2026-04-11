/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionKind, SessionActionRequestSource, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { SessionPlanningService } from '../../browser/sessionPlanningService.js';
import { SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanStatus, SessionPlanStepKind } from '../../common/sessionPlanTypes.js';

suite('SessionPlanningService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	const hostTarget = {
		kind: SessionHostKind.Local,
		providerId: 'provider-1',
	};

	test('createPlan derives typed plan metadata for executable and planning-only steps', async () => {
		const service = disposables.add(new SessionPlanningService());
		const file = URI.file('/workspace/repo/src/app.ts');

		const plan = await service.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Repair the failing repo-local test flow.',
			hostTarget,
			steps: [
				{
					id: 'search',
					kind: SessionPlanStepKind.SearchWorkspace,
					title: 'Locate the failing symbol',
					action: {
						kind: SessionActionKind.SearchWorkspace,
						requestedBy: SessionActionRequestSource.Session,
						query: 'needle',
					},
				},
				{
					id: 'patch',
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch the broken file',
					dependsOn: ['search'],
					action: {
						kind: SessionActionKind.WritePatch,
						requestedBy: SessionActionRequestSource.Session,
						patch: 'patch',
						files: [file],
					},
				},
				{
					kind: SessionPlanStepKind.Review,
					title: 'Review the resulting diff',
					dependsOn: ['patch'],
				},
			],
		});

		assert.strictEqual(plan.status, SessionPlanStatus.Draft);
		assert.deepStrictEqual(plan.steps.map(step => step.id), ['search', 'patch', 'step-3']);
		assert.deepStrictEqual(plan.steps[0].riskClasses, [SessionPlanRiskClass.ReadOnly]);
		assert.deepStrictEqual(plan.steps[1].riskClasses, [SessionPlanRiskClass.RepoMutation]);
		assert.strictEqual(plan.steps[1].checkpointRequirement, SessionPlanCheckpointRequirement.Required);
		assert.deepStrictEqual(plan.steps[1].estimatedScope.files.map(resource => resource.toString()), [file.toString()]);
		assert.strictEqual(plan.steps[1].estimatedApprovalRequired, true);
		assert.strictEqual(plan.steps[2].checkpointRequirement, SessionPlanCheckpointRequirement.None);
		assert.strictEqual(plan.steps[2].estimatedApprovalRequired, false);
		assert.strictEqual(plan.budget.maxSteps, 12);
	});

	test('createPlan preserves explicit local-safe risk overrides for low-risk command steps', async () => {
		const service = disposables.add(new SessionPlanningService());

		const plan = await service.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Run a bounded validation command.',
			hostTarget,
			steps: [
				{
					kind: SessionPlanStepKind.RunCommand,
					title: 'Run the local validation command',
					riskClasses: [SessionPlanRiskClass.LocalSafe],
					estimatedApprovalRequired: false,
					action: {
						kind: SessionActionKind.RunCommand,
						requestedBy: SessionActionRequestSource.Session,
						command: 'npm run lint',
					},
				},
			],
		});

		assert.deepStrictEqual(plan.steps[0].riskClasses, [SessionPlanRiskClass.LocalSafe]);
		assert.strictEqual(plan.steps[0].estimatedApprovalRequired, false);
		assert.strictEqual(plan.steps[0].checkpointRequirement, SessionPlanCheckpointRequirement.None);
	});
});
