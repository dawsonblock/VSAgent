/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { getDefaultSessionPolicySnapshot, ISessionActionPolicyConfigService } from '../../../actions/browser/sessionActionPolicyConfigService.js';
import { ISessionActionPolicyService, SessionActionPolicyService } from '../../../actions/browser/sessionActionPolicyService.js';
import { ISessionActionScopeService } from '../../../actions/common/sessionActionScope.js';
import { SessionActionKind, SessionActionRequestSource, SessionActionStatus, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { createScope, createSessionActionHarness, SessionActionHarnessOptions } from '../../../actions/test/browser/sessionActionTestUtils.js';
import { SessionCheckpointService } from '../../../checkpoints/browser/sessionCheckpointService.js';
import { SessionEvaluationService } from '../../../evaluation/browser/sessionEvaluationService.js';
import { SessionPlanningService } from '../../../planning/browser/sessionPlanningService.js';
import { SessionPlanValidatorService } from '../../../planning/browser/sessionPlanValidatorService.js';
import { SessionPlanRiskClass, SessionPlanStatus, SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';
import { SessionBudgetService } from '../../browser/sessionBudgetService.js';
import { SessionAutonomousExecutionService } from '../../browser/sessionAutonomousExecutionService.js';
import { SessionAutonomyPolicyService } from '../../browser/sessionAutonomyPolicyService.js';
import { AutonomyStopReason, SessionAutonomyMode } from '../../common/sessionAutonomyTypes.js';

suite('SessionAutonomousExecutionService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	function createRuntime(policyOverrides?: Partial<ReturnType<typeof getDefaultSessionPolicySnapshot>>, harnessOptions?: Pick<SessionActionHarnessOptions, 'executor' | 'providerCapabilityOverrides'>) {
		const harness = createSessionActionHarness(disposables, {
			policyOverrides,
			executor: harnessOptions?.executor,
			providerCapabilityOverrides: harnessOptions?.providerCapabilityOverrides,
		});
		const planningService = disposables.add(new SessionPlanningService());
		const scopeService: ISessionActionScopeService = {
			_serviceBrand: undefined,
			resolveScope: () => ({ scope: createScope(harness.session.providerId, harness.providerCapabilities.hostKind) }),
		};
		const policyService = new SessionActionPolicyService({
			_serviceBrand: undefined,
			onDidChangePolicy: Event.None,
			async getPolicySnapshot(_executionContext, allowedRoots) {
				return {
					...getDefaultSessionPolicySnapshot(allowedRoots),
					...policyOverrides,
					allowedRoots,
				};
			},
		} as ISessionActionPolicyConfigService) as ISessionActionPolicyService;
		const validator = disposables.add(new SessionPlanValidatorService(scopeService, policyService));
		const budgetService = disposables.add(new SessionBudgetService());
		const checkpointService = disposables.add(new SessionCheckpointService(harness.service));
		const evaluationService = disposables.add(new SessionEvaluationService());
		const autonomyPolicyService = disposables.add(new SessionAutonomyPolicyService());
		const executionService = disposables.add(new SessionAutonomousExecutionService(
			harness.providersService,
			policyService,
			autonomyPolicyService,
			validator,
			budgetService,
			checkpointService,
			evaluationService,
			harness.service,
			new NullLogService(),
		));

		return {
			harness,
			planningService,
			checkpointService,
			executionService,
		};
	}

	test('executePlan routes executable steps through SessionActionService and checkpoints mutating steps', async () => {
		const file = URI.file('/workspace/repo/src/app.ts');
		const { harness, planningService, checkpointService, executionService } = createRuntime({
			allowWorkspaceWrites: true,
			allowCommands: true,
			allowGitMutation: true,
		});

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

		const result = await executionService.executePlan({
			session: harness.session,
			plan,
			mode: SessionAutonomyMode.RepoRepair,
		});

		assert.strictEqual(result.status, SessionPlanStatus.Completed);
		assert.strictEqual(result.stopReason, AutonomyStopReason.Completed);
		assert.strictEqual(harness.getExecuteCalls(), 2);
		assert.strictEqual(harness.service.getReceiptsForSession(harness.session.sessionId).length, 2);
		assert.strictEqual(checkpointService.getCheckpointsForSession(harness.session.sessionId).length, 1);
		assert.strictEqual(result.stepResults.length, 2);
	});

	test('executePlan stops when the effective budget is exhausted', async () => {
		const file = URI.file('/workspace/repo/src/app.ts');
		const outsideFile = URI.file('/workspace/repo/src/other.ts');
		const { harness, planningService, executionService } = createRuntime({
			allowWorkspaceWrites: true,
		}, {
			executor: async action => {
				if (action.kind !== SessionActionKind.WritePatch) {
					throw new Error('Unexpected action kind in test');
				}

				return {
					actionId: action.id ?? 'patch-action',
					kind: action.kind,
					status: SessionActionStatus.Executed,
					advisorySources: action.advisorySources ?? [],
					filesTouched: [file, outsideFile],
					applied: true,
					operationCount: 2,
					operations: [],
					summary: 'Patched files.',
				};
			},
		});

		const plan = await planningService.createPlan({
			sessionId: harness.session.sessionId,
			providerId: harness.session.providerId,
			intent: 'Run bounded repair',
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: harness.session.providerId,
			},
			budget: {
				maxModifiedFiles: 1,
			},
			steps: [
				{
					id: 'patch',
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch the file',
					riskClasses: [SessionPlanRiskClass.RepoMutation],
					action: {
						kind: SessionActionKind.WritePatch,
						requestedBy: SessionActionRequestSource.Session,
						patch: 'patch',
						files: [file],
					},
				},
			],
		});

		const result = await executionService.executePlan({
			session: harness.session,
			plan,
			mode: SessionAutonomyMode.RepoRepair,
		});

		assert.strictEqual(result.status, SessionPlanStatus.Stopped);
		assert.strictEqual(result.stopReason, AutonomyStopReason.BudgetExceeded);
		assert.strictEqual(harness.getExecuteCalls(), 1);
		assert.strictEqual(result.stepResults.length, 1);
	});

	test('executePlan rejects openWorktree steps before execution because the executor bridge does not support them', async () => {
		const worktreeRoot = URI.file('/workspace/repo-worktree');
		const { harness, planningService, executionService } = createRuntime({
			allowWorktreeMutation: true,
		}, {
			providerCapabilityOverrides: { canOpenWorktrees: true },
		});

		const plan = await planningService.createPlan({
			sessionId: harness.session.sessionId,
			providerId: harness.session.providerId,
			intent: 'Create a repair worktree',
			hostTarget: {
				kind: SessionHostKind.Local,
				providerId: harness.session.providerId,
			},
			steps: [
				{
					id: 'worktree',
					kind: SessionPlanStepKind.OpenWorktree,
					title: 'Create the worktree',
					action: {
						kind: SessionActionKind.OpenWorktree,
						requestedBy: SessionActionRequestSource.Session,
						repository: URI.file('/workspace/repo'),
						worktreePath: worktreeRoot,
						branch: 'repair',
					},
				},
			],
		});

		const result = await executionService.executePlan({
			session: harness.session,
			plan,
			mode: SessionAutonomyMode.SupervisedExtended,
		});

		assert.strictEqual(result.status, SessionPlanStatus.Rejected);
		assert.strictEqual(result.stopReason, AutonomyStopReason.ValidationFailed);
		assert.strictEqual(harness.getExecuteCalls(), 0);
		assert.ok(result.issues.some(issue => issue.message.includes('not yet supported')));
	});
});
