/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionHostKind } from '../../actions/common/sessionActionTypes.js';
import { ISessionPlanningService } from '../common/sessionPlanningService.js';
import { createSessionPlanScopeEstimate, deriveSessionPlanScopeEstimateFromAction, getDefaultSessionPlanBudget, isSessionPlanMutationRiskClass, mergeSessionPlanBudget, SessionPlan, SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanScopeEstimate, SessionPlanStatus, SessionPlanStep, SessionPlanStepDraft, SessionPlanStepKind, SessionPlanningRequest } from '../common/sessionPlanTypes.js';

export class SessionPlanningService extends Disposable implements ISessionPlanningService {
	declare readonly _serviceBrand: undefined;

	async createPlan(request: SessionPlanningRequest): Promise<SessionPlan> {
		const createdAt = Date.now();
		const stepIds = request.steps.map((step, index) => step.id ?? `step-${index + 1}`);
		const steps = request.steps.map((step, index) => this._createStep(step, stepIds[index], request.hostTarget));

		return {
			id: request.id ?? generateUuid(),
			sessionId: request.sessionId,
			providerId: request.providerId,
			intent: request.intent,
			summary: request.summary,
			hostTarget: request.hostTarget,
			steps,
			status: SessionPlanStatus.Draft,
			budget: request.budget ? mergeSessionPlanBudget(request.budget) : getDefaultSessionPlanBudget(),
			createdAt,
			updatedAt: createdAt,
		};
	}

	private _createStep(step: SessionPlanStepDraft, stepId: string, hostTarget: SessionPlanningRequest['hostTarget']): SessionPlanStep {
		const riskClasses = this._deriveRiskClasses(step, hostTarget);
		return {
			id: stepId,
			kind: step.kind,
			title: step.title,
			description: step.description,
			dependsOn: step.dependsOn ?? [],
			action: step.action,
			estimatedScope: this._deriveEstimatedScope(step, hostTarget),
			riskClasses,
			estimatedApprovalRequired: this._deriveApprovalEstimate(step, riskClasses),
			checkpointRequirement: step.checkpointRequirement ?? (riskClasses.some(isSessionPlanMutationRiskClass)
				? SessionPlanCheckpointRequirement.Required
				: SessionPlanCheckpointRequirement.None),
		};
	}

	private _deriveEstimatedScope(step: SessionPlanStepDraft, hostTarget: SessionPlanningRequest['hostTarget']): SessionPlanScopeEstimate {
		const derivedScope = deriveSessionPlanScopeEstimateFromAction(step.action, hostTarget);
		const explicitScope = step.estimatedScope;
		if (!explicitScope) {
			return derivedScope;
		}

		const explicitWithHost = createSessionPlanScopeEstimate(explicitScope, explicitScope.hostTarget ?? hostTarget);
		const files = new Map<string, SessionPlanScopeEstimate['files'][number]>();
		for (const resource of [...derivedScope.files, ...explicitWithHost.files]) {
			files.set(resource.toString(), resource);
		}

		return {
			workspaceRoot: explicitWithHost.workspaceRoot ?? derivedScope.workspaceRoot,
			projectRoot: explicitWithHost.projectRoot ?? derivedScope.projectRoot,
			repositoryPath: explicitWithHost.repositoryPath ?? derivedScope.repositoryPath,
			worktreeRoot: explicitWithHost.worktreeRoot ?? derivedScope.worktreeRoot,
			cwd: explicitWithHost.cwd ?? derivedScope.cwd,
			files: [...files.values()],
			hostTarget: explicitWithHost.hostTarget ?? derivedScope.hostTarget,
		};
	}

	private _deriveRiskClasses(step: SessionPlanStepDraft, hostTarget: SessionPlanningRequest['hostTarget']): readonly SessionPlanRiskClass[] {
		const classes = new Set<SessionPlanRiskClass>(step.riskClasses ?? this._defaultRiskClasses(step.kind));
		if (hostTarget.kind !== SessionHostKind.Local) {
			classes.add(SessionPlanRiskClass.RemoteHostSensitive);
		}

		return [...classes.values()];
	}

	private _defaultRiskClasses(kind: SessionPlanStepKind): readonly SessionPlanRiskClass[] {
		switch (kind) {
			case SessionPlanStepKind.WritePatch:
			case SessionPlanStepKind.OpenWorktree:
				return [SessionPlanRiskClass.RepoMutation];
			case SessionPlanStepKind.RunCommand:
				return [SessionPlanRiskClass.EnvironmentMutation];
			case SessionPlanStepKind.SearchWorkspace:
			case SessionPlanStepKind.ReadFile:
			case SessionPlanStepKind.GitStatus:
			case SessionPlanStepKind.GitDiff:
			case SessionPlanStepKind.Summarize:
			case SessionPlanStepKind.Compare:
			case SessionPlanStepKind.Review:
				return [SessionPlanRiskClass.ReadOnly];
		}
	}

	private _deriveApprovalEstimate(step: SessionPlanStepDraft, riskClasses: readonly SessionPlanRiskClass[]): boolean {
		if (typeof step.estimatedApprovalRequired === 'boolean') {
			return step.estimatedApprovalRequired;
		}

		if (riskClasses.some(isSessionPlanMutationRiskClass)) {
			return true;
		}

		switch (step.kind) {
			case SessionPlanStepKind.RunCommand:
			case SessionPlanStepKind.WritePatch:
			case SessionPlanStepKind.OpenWorktree:
				return true;
			default:
				return false;
		}
	}
}

registerSingleton(ISessionPlanningService, SessionPlanningService, InstantiationType.Delayed);
