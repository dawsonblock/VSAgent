/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getDefaultSessionPolicySnapshot } from '../../../actions/browser/sessionActionPolicyConfigService.js';
import { ProviderCapabilitySet } from '../../../actions/common/sessionActionPolicy.js';
import { SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { SessionAutonomyPolicyService } from '../../browser/sessionAutonomyPolicyService.js';
import { SessionAutonomyMode } from '../../common/sessionAutonomyTypes.js';
import { SessionPlanRiskClass, SessionPlanStepKind } from '../../../planning/common/sessionPlanTypes.js';

suite('SessionAutonomyPolicyService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	function createProviderCapabilities(overrides?: Partial<ProviderCapabilitySet>): ProviderCapabilitySet {
		return {
			multipleChatsPerSession: false,
			hostKind: SessionHostKind.Local,
			canReadWorkspace: true,
			canWriteWorkspace: true,
			canRunCommands: true,
			canMutateGit: true,
			canOpenWorktrees: true,
			canUseExternalTools: true,
			requiresApprovalForWrites: true,
			requiresApprovalForCommands: true,
			requiresApprovalForGit: true,
			requiresApprovalForWorktreeActions: true,
			supportsStructuredApprovals: true,
			supportsReceiptMetadata: true,
			...overrides,
		};
	}

	test('review_only keeps the autonomy envelope read-only', () => {
		const service = disposables.add(new SessionAutonomyPolicyService());
		const decision = service.resolveProfile({
			mode: SessionAutonomyMode.ReviewOnly,
			providerCapabilities: createProviderCapabilities(),
			policy: getDefaultSessionPolicySnapshot([]),
			hostKind: SessionHostKind.Local,
		});

		assert.ok(decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.SearchWorkspace));
		assert.ok(decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.Review));
		assert.ok(!decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.RunCommand));
		assert.ok(!decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.WritePatch));
		assert.deepStrictEqual(decision.allowedProfile.riskClasses, [SessionPlanRiskClass.ReadOnly]);
		assert.strictEqual(decision.allowedProfile.budget.maxFileWrites, 0);
	});

	test('repo_repair allows repo-local writes but still blocks worktree mutation when policy denies it', () => {
		const service = disposables.add(new SessionAutonomyPolicyService());
		const decision = service.resolveProfile({
			mode: SessionAutonomyMode.RepoRepair,
			providerCapabilities: createProviderCapabilities(),
			policy: {
				...getDefaultSessionPolicySnapshot([]),
				allowWorkspaceWrites: true,
				allowCommands: true,
				allowGitMutation: true,
				allowWorktreeMutation: false,
			},
			hostKind: SessionHostKind.Local,
		});

		assert.ok(decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.WritePatch));
		assert.ok(!decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.OpenWorktree));
		assert.ok(decision.blockedStepKinds.includes(SessionPlanStepKind.OpenWorktree));
		assert.ok(decision.allowedProfile.riskClasses.includes(SessionPlanRiskClass.RepoMutation));
	});

	test('safe_autopilot blocks remote-host-sensitive risk without supervised mode', () => {
		const service = disposables.add(new SessionAutonomyPolicyService());
		const decision = service.resolveProfile({
			mode: SessionAutonomyMode.SafeAutopilot,
			providerCapabilities: createProviderCapabilities({ hostKind: SessionHostKind.Remote }),
			policy: {
				...getDefaultSessionPolicySnapshot([]),
				allowWorkspaceReads: true,
				allowCommands: true,
			},
			hostKind: SessionHostKind.Remote,
		});

		assert.ok(decision.allowedProfile.stepKinds.includes(SessionPlanStepKind.RunCommand));
		assert.ok(!decision.allowedProfile.riskClasses.includes(SessionPlanRiskClass.RemoteHostSensitive));
		assert.ok(decision.blockedRiskClasses.includes(SessionPlanRiskClass.RemoteHostSensitive));
		assert.ok(decision.reasons.some(reason => reason.includes('supervised_extended')));
	});
});
