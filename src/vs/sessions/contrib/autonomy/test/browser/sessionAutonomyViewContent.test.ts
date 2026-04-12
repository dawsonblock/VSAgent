/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getDefaultSessionPlanBudget, SessionPlanCheckpointRequirement, SessionPlanStatus, SessionPlanStepKind } from '../../../../services/planning/common/sessionPlanTypes.js';
import { SessionActionKind, SessionHostKind } from '../../../../services/actions/common/sessionActionTypes.js';
import { AutonomyContinuationDecision, AutonomyStopReason, SessionAutonomyMode } from '../../../../services/autonomy/common/sessionAutonomyTypes.js';
import { SessionActionReceiptStatus } from '../../../../services/actions/common/sessionActionReceipts.js';
import { SessionExecutionPhase } from '../../../../services/memory/common/sessionExecutionMemoryService.js';
import { formatSessionAutonomyStatusText, formatSessionExecutionSummaryText, formatSessionPlanText } from '../../browser/sessionAutonomyViewContent.js';

suite('SessionAutonomyViewContent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const plan = {
		id: 'plan-1',
		sessionId: 'session-1',
		providerId: 'provider-1',
		intent: 'Repair the repo',
		summary: 'Inspect, patch, and verify the project.',
		hostTarget: {
			kind: SessionHostKind.Local,
			providerId: 'provider-1',
		},
		steps: [{
			id: 'search',
			kind: SessionPlanStepKind.SearchWorkspace,
			title: 'Find the broken import',
			description: 'Look for the failing symbol.',
			dependsOn: [],
			estimatedScope: { files: [] },
			riskClasses: [],
			estimatedApprovalRequired: false,
			checkpointRequirement: SessionPlanCheckpointRequirement.None,
		}],
		status: SessionPlanStatus.Validated,
		budget: getDefaultSessionPlanBudget(),
		createdAt: 1,
		updatedAt: 2,
	};

	test('formats plan text with steps and budget', () => {
		const text = formatSessionPlanText('Fix login flow', plan);

		assert.ok(text.includes('Advisory plan for Fix login flow'));
		assert.ok(text.includes('Intent: Repair the repo'));
		assert.ok(text.includes('Find the broken import'));
		assert.ok(text.includes('Budget:'));
	});

	test('formats execution summary text with progress and issues', () => {
		const text = formatSessionExecutionSummaryText('Fix login flow', {
			headline: 'Executing Advisory Steps',
			detail: 'Updated the failing import and re-ran the verification step.',
			progressLabel: '1/2 steps',
			issueCount: 2,
			updatedAt: 3,
		});

		assert.ok(text.includes('Advisory summary for Fix login flow'));
		assert.ok(text.includes('Executing Advisory Steps'));
		assert.ok(text.includes('Progress: 1/2 steps'));
		assert.ok(text.includes('Issues: 2'));
	});

	test('formats autonomy status text with phase and stop reason', () => {
		const text = formatSessionAutonomyStatusText('Fix login flow', {
			sessionId: 'session-1',
			providerId: 'provider-1',
			mode: SessionAutonomyMode.RepoRepair,
			phase: SessionExecutionPhase.Stopped,
			plan,
			result: {
				planId: 'plan-1',
				sessionId: 'session-1',
				providerId: 'provider-1',
				status: SessionPlanStatus.Stopped,
				decision: AutonomyContinuationDecision.Stop,
				stopReason: AutonomyStopReason.BudgetExceeded,
				stepResults: [],
				budgetState: {
					budget: getDefaultSessionPlanBudget(),
					startedAt: 1,
					executedSteps: 1,
					executedCommands: 0,
					fileWrites: 0,
					modifiedFiles: [],
					failures: 0,
					attemptsByStep: {},
					elapsedMs: 10,
				},
				issues: [{ stepId: 'search', message: 'The advisory run exceeded the file budget.' }],
				reasons: [],
			},
			budgetState: {
				budget: getDefaultSessionPlanBudget(),
				startedAt: 1,
				executedSteps: 1,
				executedCommands: 0,
				fileWrites: 0,
				modifiedFiles: [],
				failures: 0,
				attemptsByStep: {},
				elapsedMs: 10,
			},
			progress: {
				totalSteps: 2,
				completedSteps: 1,
				completedStepIds: ['search'],
				lastStepId: 'search',
			},
			lastReceipt: {
				id: 'receipt-1',
				sessionId: 'session-1',
				providerId: 'provider-1',
				hostKind: SessionHostKind.Local,
				hostTarget: {
					kind: SessionHostKind.Local,
					providerId: 'provider-1',
				},
				actionId: 'action-1',
				actionKind: SessionActionKind.SearchWorkspace,
				planId: 'plan-1',
				planStepId: 'search',
				requestedScope: {
					files: [],
					hostTarget: {
						kind: SessionHostKind.Local,
						providerId: 'provider-1',
					},
				},
				approvedScope: {
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
				executionSummary: 'Read file.',
			},
			errorMessage: undefined,
			startedAt: 1,
			updatedAt: 2,
		}, {
			headline: 'Advisory Run Stopped',
			detail: 'The advisory run exceeded the file budget.',
			progressLabel: '1/2 steps',
			issueCount: 1,
			updatedAt: 2,
		});

		assert.ok(text.includes('Advisory status for Fix login flow'));
		assert.ok(text.includes('Phase: Stopped'));
		assert.ok(text.includes('Mode: repo_repair'));
		assert.ok(text.includes('Progress: 1/2 steps'));
		assert.ok(text.includes('Remaining budget: 11 steps, 4 commands, 20 file writes, 20 modified files, 3 failures'));
		assert.ok(text.includes('Last action: Read file.'));
		assert.ok(text.includes('Stop reason: budgetExceeded'));
		assert.ok(text.includes('First issue: The advisory run exceeded the file budget.'));
	});
});
