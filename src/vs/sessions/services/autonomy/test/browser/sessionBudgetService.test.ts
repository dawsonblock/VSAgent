/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionKind, SessionActionRequestSource, SessionActionStatus } from '../../../actions/common/sessionActionTypes.js';
import { SessionBudgetService } from '../../browser/sessionBudgetService.js';
import { SessionBudgetExhaustionReason } from '../../common/sessionBudgetService.js';
import { getDefaultSessionPlanBudget, SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanStep, SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';

suite('SessionBudgetService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('createBudgetState intersects requested and allowed budgets', () => {
		const service = disposables.add(new SessionBudgetService());
		const requested = {
			...getDefaultSessionPlanBudget(),
			maxSteps: 12,
			maxCommands: 6,
			maxFileWrites: 10,
			maxModifiedFiles: 10,
			maxFailures: 3,
			maxRetriesPerStep: 2,
		};
		const allowed = {
			...getDefaultSessionPlanBudget(),
			maxSteps: 4,
			maxCommands: 2,
			maxFileWrites: 5,
			maxModifiedFiles: 6,
			maxFailures: 1,
			maxRetriesPerStep: 1,
		};

		const state = service.createBudgetState(requested, allowed);

		assert.strictEqual(state.budget.maxSteps, 4);
		assert.strictEqual(state.budget.maxCommands, 2);
		assert.strictEqual(state.budget.maxFileWrites, 5);
		assert.strictEqual(state.budget.maxModifiedFiles, 6);
		assert.strictEqual(state.budget.maxFailures, 1);
		assert.strictEqual(state.budget.maxRetriesPerStep, 1);
	});

	test('reserveStep enforces command and retry budgets', () => {
		const service = disposables.add(new SessionBudgetService());
		const budget = {
			...getDefaultSessionPlanBudget(),
			maxSteps: 3,
			maxCommands: 1,
			maxRetriesPerStep: 0,
		};
		const step: SessionPlanStep = {
			id: 'command',
			kind: SessionPlanStepKind.RunCommand,
			title: 'Run validation command',
			dependsOn: [],
			action: {
				kind: SessionActionKind.RunCommand,
				requestedBy: SessionActionRequestSource.Session,
				command: 'npm test',
			},
			estimatedScope: { files: [] },
			riskClasses: [SessionPlanRiskClass.LocalSafe],
			estimatedApprovalRequired: true,
			checkpointRequirement: SessionPlanCheckpointRequirement.None,
		};

		const reserved = service.reserveStep(service.createBudgetState(budget), step);
		assert.strictEqual(reserved.allowed, true);
		assert.strictEqual(reserved.state.executedCommands, 1);

		const retryAttempt = service.reserveStep(reserved.state, step);
		assert.strictEqual(retryAttempt.allowed, false);
		assert.strictEqual(retryAttempt.exhaustion?.reason, SessionBudgetExhaustionReason.MaxRetriesPerStep);
	});

	test('finalizeStep tracks touched files and failure exhaustion', () => {
		const service = disposables.add(new SessionBudgetService());
		const file = URI.file('/workspace/repo/src/app.ts');
		const outsideFile = URI.file('/workspace/repo/src/other.ts');
		const step: SessionPlanStep = {
			id: 'patch',
			kind: SessionPlanStepKind.WritePatch,
			title: 'Patch the file',
			dependsOn: [],
			action: {
				kind: SessionActionKind.WritePatch,
				requestedBy: SessionActionRequestSource.Session,
				patch: 'patch',
				files: [file],
			},
			estimatedScope: { files: [file] },
			riskClasses: [SessionPlanRiskClass.RepoMutation],
			estimatedApprovalRequired: true,
			checkpointRequirement: SessionPlanCheckpointRequirement.Required,
		};
		const budget = {
			...getDefaultSessionPlanBudget(),
			maxFailures: 0,
			maxModifiedFiles: 2,
		};

		const reserved = service.reserveStep(service.createBudgetState(budget), step);
		const finalized = service.finalizeStep(reserved.state, step, {
			actionId: 'patch-action',
			kind: SessionActionKind.WritePatch,
			status: SessionActionStatus.Failed,
			advisorySources: [],
			filesTouched: [file, outsideFile],
			applied: false,
			summary: 'Patch failed.',
		});

		assert.strictEqual(finalized.failures, 1);
		assert.deepStrictEqual(finalized.modifiedFiles.map(resource => resource.toString()).sort(), [file.toString(), outsideFile.toString()].sort());
		assert.strictEqual(finalized.exhaustion?.reason, SessionBudgetExhaustionReason.MaxFailures);
	});
});
