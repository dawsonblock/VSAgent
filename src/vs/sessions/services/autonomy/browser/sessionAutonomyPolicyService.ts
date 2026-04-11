/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionHostKind } from '../../actions/common/sessionActionTypes.js';
import { getDefaultSessionPlanBudget, SessionPlanRiskClass, SessionPlanStepKind } from '../../planning/common/sessionPlanTypes.js';
import { ISessionAutonomyPolicyService, SessionAutonomyPolicyDecision, SessionAutonomyPolicyRequest } from '../common/sessionAutonomyPolicyService.js';
import { AllowedRiskProfile, SessionAutonomyMode } from '../common/sessionAutonomyTypes.js';

const planningOnlyStepKinds = [
	SessionPlanStepKind.Summarize,
	SessionPlanStepKind.Compare,
	SessionPlanStepKind.Review,
];

const reviewOnlyStepKinds = [
	...planningOnlyStepKinds,
	SessionPlanStepKind.SearchWorkspace,
	SessionPlanStepKind.ReadFile,
	SessionPlanStepKind.GitStatus,
	SessionPlanStepKind.GitDiff,
];

const safeAutopilotStepKinds = [
	...reviewOnlyStepKinds,
	SessionPlanStepKind.RunCommand,
];

const repoRepairStepKinds = [
	...safeAutopilotStepKinds,
	SessionPlanStepKind.WritePatch,
];

const supervisedExtendedStepKinds = [
	...repoRepairStepKinds,
	SessionPlanStepKind.OpenWorktree,
];

const allStepKinds = [
	SessionPlanStepKind.SearchWorkspace,
	SessionPlanStepKind.ReadFile,
	SessionPlanStepKind.WritePatch,
	SessionPlanStepKind.RunCommand,
	SessionPlanStepKind.GitStatus,
	SessionPlanStepKind.GitDiff,
	SessionPlanStepKind.OpenWorktree,
	...planningOnlyStepKinds,
];

const allRiskClasses = [
	SessionPlanRiskClass.ReadOnly,
	SessionPlanRiskClass.LocalSafe,
	SessionPlanRiskClass.RepoMutation,
	SessionPlanRiskClass.EnvironmentMutation,
	SessionPlanRiskClass.Networked,
	SessionPlanRiskClass.CredentialSensitive,
	SessionPlanRiskClass.RemoteHostSensitive,
];

export class SessionAutonomyPolicyService extends Disposable implements ISessionAutonomyPolicyService {
	declare readonly _serviceBrand: undefined;

	resolveProfile(request: SessionAutonomyPolicyRequest): SessionAutonomyPolicyDecision {
		const allowedProfile = this._cloneProfile(this._getBaseProfile(request.mode));
		const allowedStepKinds = new Set(allowedProfile.stepKinds);
		const allowedRiskClasses = new Set(allowedProfile.riskClasses);
		const blockedStepKinds = new Set(allStepKinds.filter(kind => !allowedStepKinds.has(kind)));
		const blockedRiskClasses = new Set(allRiskClasses.filter(riskClass => !allowedRiskClasses.has(riskClass)));
		const reasons: string[] = [];

		const blockStepKind = (kind: SessionPlanStepKind, reason: string) => {
			if (allowedStepKinds.delete(kind)) {
				blockedStepKinds.add(kind);
				reasons.push(reason);
			}
		};

		if (!request.providerCapabilities.canReadWorkspace || !request.policy.allowWorkspaceReads) {
			blockStepKind(SessionPlanStepKind.SearchWorkspace, 'Workspace reads are not available for the selected autonomy envelope.');
			blockStepKind(SessionPlanStepKind.ReadFile, 'Workspace reads are not available for the selected autonomy envelope.');
		}

		if (!request.providerCapabilities.canRunCommands || !request.policy.allowCommands) {
			blockStepKind(SessionPlanStepKind.RunCommand, 'Command execution is not available for the selected autonomy envelope.');
			allowedRiskClasses.delete(SessionPlanRiskClass.LocalSafe);
			allowedRiskClasses.delete(SessionPlanRiskClass.EnvironmentMutation);
			blockedRiskClasses.add(SessionPlanRiskClass.LocalSafe);
			blockedRiskClasses.add(SessionPlanRiskClass.EnvironmentMutation);
		}

		if (!request.providerCapabilities.canWriteWorkspace || !request.policy.allowWorkspaceWrites) {
			blockStepKind(SessionPlanStepKind.WritePatch, 'Workspace mutation is not available for the selected autonomy envelope.');
		}

		if (!request.providerCapabilities.canMutateGit || !request.policy.allowGitMutation) {
			blockStepKind(SessionPlanStepKind.GitStatus, 'Git inspection is not available for the selected autonomy envelope.');
			blockStepKind(SessionPlanStepKind.GitDiff, 'Git inspection is not available for the selected autonomy envelope.');
		}

		if (!request.providerCapabilities.canOpenWorktrees || !request.policy.allowWorktreeMutation) {
			blockStepKind(SessionPlanStepKind.OpenWorktree, 'Worktree mutation is not available for the selected autonomy envelope.');
		}

		blockStepKind(SessionPlanStepKind.OpenWorktree, 'Worktree mutation is not yet supported by the Sessions executor bridge.');

		if (!allowedStepKinds.has(SessionPlanStepKind.WritePatch) && !allowedStepKinds.has(SessionPlanStepKind.OpenWorktree)) {
			allowedRiskClasses.delete(SessionPlanRiskClass.RepoMutation);
			blockedRiskClasses.add(SessionPlanRiskClass.RepoMutation);
		}

		if (request.hostKind !== SessionHostKind.Local && request.mode !== SessionAutonomyMode.SupervisedExtended) {
			allowedRiskClasses.delete(SessionPlanRiskClass.RemoteHostSensitive);
			blockedRiskClasses.add(SessionPlanRiskClass.RemoteHostSensitive);
			reasons.push('Remote host execution requires supervised_extended autonomy.');
		}

		return {
			mode: request.mode,
			allowedProfile: {
				stepKinds: [...allowedStepKinds.values()],
				riskClasses: [...allowedRiskClasses.values()],
				budget: allowedProfile.budget,
			},
			blockedStepKinds: [...blockedStepKinds.values()],
			blockedRiskClasses: [...blockedRiskClasses.values()],
			reasons,
		};
	}

	private _getBaseProfile(mode: SessionAutonomyMode): AllowedRiskProfile {
		switch (mode) {
			case SessionAutonomyMode.ReviewOnly:
				return {
					stepKinds: reviewOnlyStepKinds,
					riskClasses: [SessionPlanRiskClass.ReadOnly],
					budget: {
						...getDefaultSessionPlanBudget(),
						maxCommands: 0,
						maxFileWrites: 0,
						maxModifiedFiles: 0,
						maxWallClockMs: 5 * 60 * 1000,
						maxRetriesPerStep: 0,
					},
				};
			case SessionAutonomyMode.SafeAutopilot:
				return {
					stepKinds: safeAutopilotStepKinds,
					riskClasses: [SessionPlanRiskClass.ReadOnly, SessionPlanRiskClass.LocalSafe],
					budget: {
						...getDefaultSessionPlanBudget(),
						maxFileWrites: 0,
						maxModifiedFiles: 0,
					},
				};
			case SessionAutonomyMode.RepoRepair:
				return {
					stepKinds: repoRepairStepKinds,
					riskClasses: [SessionPlanRiskClass.ReadOnly, SessionPlanRiskClass.LocalSafe, SessionPlanRiskClass.RepoMutation],
					budget: {
						...getDefaultSessionPlanBudget(),
						maxSteps: 20,
						maxCommands: 6,
						maxFileWrites: 30,
						maxModifiedFiles: 30,
						maxWallClockMs: 20 * 60 * 1000,
						maxFailures: 4,
						maxRetriesPerStep: 2,
					},
				};
			case SessionAutonomyMode.SupervisedExtended:
				return {
					stepKinds: supervisedExtendedStepKinds,
					riskClasses: [
						SessionPlanRiskClass.ReadOnly,
						SessionPlanRiskClass.LocalSafe,
						SessionPlanRiskClass.RepoMutation,
						SessionPlanRiskClass.EnvironmentMutation,
						SessionPlanRiskClass.Networked,
						SessionPlanRiskClass.CredentialSensitive,
						SessionPlanRiskClass.RemoteHostSensitive,
					],
					budget: {
						...getDefaultSessionPlanBudget(),
						maxSteps: 30,
						maxCommands: 10,
						maxFileWrites: 50,
						maxModifiedFiles: 50,
						maxWallClockMs: 30 * 60 * 1000,
						maxFailures: 6,
						maxRetriesPerStep: 2,
					},
				};
		}
	}

	private _cloneProfile(profile: AllowedRiskProfile): AllowedRiskProfile {
		return {
			stepKinds: [...profile.stepKinds],
			riskClasses: [...profile.riskClasses],
			budget: { ...profile.budget },
		};
	}
}

registerSingleton(ISessionAutonomyPolicyService, SessionAutonomyPolicyService, InstantiationType.Delayed);
