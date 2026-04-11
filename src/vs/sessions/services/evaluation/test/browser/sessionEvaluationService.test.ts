/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionRequestSource, SessionActionStatus, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { SessionBudgetService } from '../../../autonomy/browser/sessionBudgetService.js';
import { AutonomyContinuationDecision, AutonomyStopReason } from '../../../autonomy/common/sessionAutonomyTypes.js';
import { SessionEvaluationService } from '../../browser/sessionEvaluationService.js';
import { getDefaultSessionPlanBudget, SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanStatus, SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';

suite('SessionEvaluationService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	test('evaluateStep continues for successful bounded reads', () => {
		const service = disposables.add(new SessionEvaluationService());
		const budgetService = disposables.add(new SessionBudgetService());
		const file = URI.file('/workspace/repo/src/app.ts');

		const result = service.evaluateStep({
			plan: createPlan(),
			step: {
				id: 'read',
				kind: SessionPlanStepKind.ReadFile,
				title: 'Read the file',
				dependsOn: [],
				action: {
					kind: SessionActionKind.ReadFile,
					requestedBy: SessionActionRequestSource.Session,
					resource: file,
				},
				estimatedScope: { files: [file] },
				riskClasses: [SessionPlanRiskClass.ReadOnly],
				estimatedApprovalRequired: false,
				checkpointRequirement: SessionPlanCheckpointRequirement.None,
			},
			result: {
				actionId: 'read-action',
				kind: SessionActionKind.ReadFile,
				status: SessionActionStatus.Executed,
				advisorySources: [],
				resource: file,
				contents: 'contents',
				summary: 'Read file.',
			},
			budgetState: budgetService.createBudgetState(getDefaultSessionPlanBudget()),
		});

		assert.strictEqual(result.decision, AutonomyContinuationDecision.Continue);
		assert.strictEqual(result.scopeDrift, false);
		assert.strictEqual(result.madeProgress, true);
	});

	test('evaluateStep maps policy denials to a hard stop', () => {
		const service = disposables.add(new SessionEvaluationService());
		const budgetService = disposables.add(new SessionBudgetService());

		const result = service.evaluateStep({
			plan: createPlan(),
			step: {
				id: 'command',
				kind: SessionPlanStepKind.RunCommand,
				title: 'Run validation',
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
			},
			result: {
				actionId: 'command-action',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Denied,
				advisorySources: [],
				command: 'npm test',
				args: [],
				commandLine: 'npm test',
				denialReason: SessionActionDenialReason.PolicyDenied,
				denialMessage: 'Blocked by policy.',
				summary: 'Blocked by policy.',
			},
			budgetState: budgetService.createBudgetState(getDefaultSessionPlanBudget()),
		});

		assert.strictEqual(result.decision, AutonomyContinuationDecision.Stop);
		assert.strictEqual(result.stopReason, AutonomyStopReason.PolicyDenied);
	});

	test('evaluateStep stops on write scope drift', () => {
		const service = disposables.add(new SessionEvaluationService());
		const budgetService = disposables.add(new SessionBudgetService());
		const file = URI.file('/workspace/repo/src/app.ts');
		const outsideFile = URI.file('/workspace/repo/src/other.ts');

		const result = service.evaluateStep({
			plan: createPlan(),
			step: {
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
			},
			result: {
				actionId: 'patch-action',
				kind: SessionActionKind.WritePatch,
				status: SessionActionStatus.Executed,
				advisorySources: [],
				filesTouched: [outsideFile],
				applied: true,
				summary: 'Patched file.',
			},
			budgetState: budgetService.createBudgetState(getDefaultSessionPlanBudget()),
		});

		assert.strictEqual(result.decision, AutonomyContinuationDecision.Stop);
		assert.strictEqual(result.stopReason, AutonomyStopReason.ScopeDrift);
		assert.strictEqual(result.scopeDrift, true);
	});
});

function createPlan() {
	return {
		id: 'plan-1',
		sessionId: 'session-1',
		providerId: 'provider-1',
		intent: 'Test plan',
		hostTarget: {
			kind: SessionHostKind.Local,
			providerId: 'provider-1',
		},
		steps: [],
		status: SessionPlanStatus.Draft,
		budget: getDefaultSessionPlanBudget(),
		createdAt: 1,
		updatedAt: 1,
	};
}
