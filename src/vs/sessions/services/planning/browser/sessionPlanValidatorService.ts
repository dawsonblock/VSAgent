/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ApprovalRequirement, SessionActionDenialReason, SessionActionKind, WritePatchAction } from '../../actions/common/sessionActionTypes.js';
import { ISessionActionPolicyService } from '../../actions/browser/sessionActionPolicyService.js';
import { ISessionActionScopeService } from '../../actions/common/sessionActionScope.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISessionPlanValidatorService, SessionPlanValidationContext, SessionPlanValidationIssue, SessionPlanValidationIssueCode, SessionPlanValidationResult } from '../common/sessionPlanValidatorService.js';
import { estimateSessionPlanWritePatchModifiedFiles, estimateSessionPlanWritePatchWriteCount, isExecutableSessionPlanStepKind, isSessionPlanMutationRiskClass, isSessionPlanStepKindSupportedByExecutor, sessionPlanStepKindToActionKind, SessionPlan, SessionPlanCheckpointRequirement, SessionPlanStep, SessionPlanStepKind } from '../common/sessionPlanTypes.js';

export class SessionPlanValidatorService extends Disposable implements ISessionPlanValidatorService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionActionScopeService private readonly _scopeService: ISessionActionScopeService,
		@ISessionActionPolicyService private readonly _policyService: ISessionActionPolicyService,
	) {
		super();
	}

	async validatePlan(plan: SessionPlan, context: SessionPlanValidationContext): Promise<SessionPlanValidationResult> {
		const issues: SessionPlanValidationIssue[] = [];
		const stepsById = new Map(plan.steps.map(step => [step.id, step]));

		this._validateDependencies(plan.steps, stepsById, issues);
		this._validateBudget(plan, issues);

		const policy = context.policy ?? await this._policyService.getPolicySnapshot(context.executionContext, this._collectPolicyRoots(context.executionContext));

		for (const step of plan.steps) {
			this._validateStepShape(step, issues);
			if (!isExecutableSessionPlanStepKind(step.kind) || !isSessionPlanStepKindSupportedByExecutor(step.kind)) {
				continue;
			}

			const expectedActionKind = sessionPlanStepKindToActionKind(step.kind);
			if (!step.action || !expectedActionKind || step.action.kind !== expectedActionKind) {
				continue;
			}

			const scopeResolution = this._scopeService.resolveScope(step.action, context.executionContext, context.providerCapabilities);
			if (!scopeResolution.scope || scopeResolution.denialReason) {
				issues.push({
					code: SessionPlanValidationIssueCode.ScopeDenied,
					stepId: step.id,
					message: scopeResolution.message ?? this._formatScopeDeniedMessage(step.kind, scopeResolution.denialReason),
				});
				continue;
			}

			const decision = this._policyService.evaluate({
				action: step.action,
				normalizedScope: scopeResolution.scope,
				providerCapabilities: context.providerCapabilities,
				executionContext: context.executionContext,
				policy,
				requestedPermissionMode: context.requestedPermissionMode,
			});

			if (decision.mode === 'deny') {
				issues.push({
					code: SessionPlanValidationIssueCode.PolicyDenied,
					stepId: step.id,
					message: decision.denialMetadata?.message ?? `Step '${step.kind}' is denied by the active Sessions policy.`,
				});
			}

			if (decision.approvalRequirement === ApprovalRequirement.Required && !step.estimatedApprovalRequired) {
				issues.push({
					code: SessionPlanValidationIssueCode.MissingApprovalEstimate,
					stepId: step.id,
					message: `Step '${step.kind}' requires approval but the plan does not mark it as an approval checkpoint.`,
				});
			}
		}

		return {
			valid: issues.length === 0,
			issues,
		};
	}

	private _validateStepShape(step: SessionPlanStep, issues: SessionPlanValidationIssue[]): void {
		if (!isExecutableSessionPlanStepKind(step.kind)) {
			if (step.action) {
				issues.push({
					code: SessionPlanValidationIssueCode.NonExecutableAction,
					stepId: step.id,
					message: `Planning-only step '${step.kind}' must not carry an executable SessionAction.`,
				});
			}
			return;
		}

		if (!isSessionPlanStepKindSupportedByExecutor(step.kind)) {
			issues.push({
				code: SessionPlanValidationIssueCode.UnsupportedAction,
				stepId: step.id,
				message: `Step '${step.kind}' is not yet supported because the Sessions executor bridge cannot create worktrees.`,
			});
		}

		if (!step.action) {
			issues.push({
				code: SessionPlanValidationIssueCode.MissingAction,
				stepId: step.id,
				message: `Executable step '${step.kind}' must carry a matching SessionAction.`,
			});
			return;
		}

		const expectedActionKind = sessionPlanStepKindToActionKind(step.kind);
		if (expectedActionKind !== step.action.kind) {
			issues.push({
				code: SessionPlanValidationIssueCode.MismatchedActionKind,
				stepId: step.id,
				message: `Plan step '${step.kind}' must carry action kind '${expectedActionKind}', but received '${step.action.kind}'.`,
			});
		}

		if (step.riskClasses.some(isSessionPlanMutationRiskClass) && step.checkpointRequirement !== SessionPlanCheckpointRequirement.Required) {
			issues.push({
				code: SessionPlanValidationIssueCode.MissingCheckpoint,
				stepId: step.id,
				message: `Mutating step '${step.kind}' must declare a required checkpoint.`,
			});
		}
	}

	private _validateDependencies(steps: readonly SessionPlanStep[], stepsById: ReadonlyMap<string, SessionPlanStep>, issues: SessionPlanValidationIssue[]): void {
		for (const step of steps) {
			for (const dependencyId of step.dependsOn) {
				if (dependencyId === step.id || !stepsById.has(dependencyId)) {
					issues.push({
						code: SessionPlanValidationIssueCode.InvalidDependency,
						stepId: step.id,
						message: `Step '${step.kind}' depends on unknown step '${dependencyId}'.`,
					});
				}
			}
		}

		const visiting = new Set<string>();
		const visited = new Set<string>();
		const cycleRoots = new Set<string>();

		const visit = (step: SessionPlanStep): void => {
			if (visited.has(step.id) || cycleRoots.has(step.id)) {
				return;
			}

			if (visiting.has(step.id)) {
				cycleRoots.add(step.id);
				issues.push({
					code: SessionPlanValidationIssueCode.DependencyCycle,
					stepId: step.id,
					message: `Step '${step.kind}' participates in a dependency cycle.`,
				});
				return;
			}

			visiting.add(step.id);
			for (const dependencyId of step.dependsOn) {
				const dependency = stepsById.get(dependencyId);
				if (dependency) {
					visit(dependency);
				}
			}
			visiting.delete(step.id);
			visited.add(step.id);
		};

		for (const step of steps) {
			visit(step);
		}
	}

	private _validateBudget(plan: SessionPlan, issues: SessionPlanValidationIssue[]): void {
		const commandCount = plan.steps.filter(step => step.kind === SessionPlanStepKind.RunCommand).length;
		const fileWriteCount = plan.steps.reduce((count, step) => count + this._estimateFileWrites(step), 0);
		const modifiedFiles = new Set<string>();

		for (const step of plan.steps) {
			for (const resource of this._estimateModifiedFiles(step)) {
				modifiedFiles.add(resource.toString());
			}
		}

		if (plan.steps.length > plan.budget.maxSteps) {
			issues.push({
				code: SessionPlanValidationIssueCode.BudgetExceeded,
				message: `Plan declares ${plan.steps.length} steps but budget allows only ${plan.budget.maxSteps}.`,
			});
		}

		if (commandCount > plan.budget.maxCommands) {
			issues.push({
				code: SessionPlanValidationIssueCode.BudgetExceeded,
				message: `Plan declares ${commandCount} commands but budget allows only ${plan.budget.maxCommands}.`,
			});
		}

		if (fileWriteCount > plan.budget.maxFileWrites) {
			issues.push({
				code: SessionPlanValidationIssueCode.BudgetExceeded,
				message: `Plan declares ${fileWriteCount} file writes but budget allows only ${plan.budget.maxFileWrites}.`,
			});
		}

		if (modifiedFiles.size > plan.budget.maxModifiedFiles) {
			issues.push({
				code: SessionPlanValidationIssueCode.BudgetExceeded,
				message: `Plan touches ${modifiedFiles.size} files but budget allows only ${plan.budget.maxModifiedFiles}.`,
			});
		}
	}

	private _estimateFileWrites(step: SessionPlanStep): number {
		const action = this._asWritePatchAction(step);
		return estimateSessionPlanWritePatchWriteCount(action);
	}

	private _estimateModifiedFiles(step: SessionPlanStep): readonly URI[] {
		const action = this._asWritePatchAction(step);
		return estimateSessionPlanWritePatchModifiedFiles(action);
	}

	private _asWritePatchAction(step: SessionPlanStep): WritePatchAction | undefined {
		if (step.kind !== SessionPlanStepKind.WritePatch || !step.action || step.action.kind !== SessionActionKind.WritePatch) {
			return undefined;
		}

		return step.action as WritePatchAction;
	}

	private _collectPolicyRoots(executionContext: SessionPlanValidationContext['executionContext']): URI[] {
		return [
			executionContext.workspaceRoot,
			executionContext.projectRoot,
			executionContext.repositoryPath,
			executionContext.worktreeRoot,
		].filter((resource): resource is URI => !!resource);
	}

	private _formatScopeDeniedMessage(kind: SessionPlanStepKind, denialReason: SessionActionDenialReason | undefined): string {
		return denialReason
			? `Step '${kind}' cannot be scoped safely because '${denialReason}' was raised during Sessions scope normalization.`
			: `Step '${kind}' cannot be scoped safely by the Sessions action scope service.`;
	}
}

registerSingleton(ISessionPlanValidatorService, SessionPlanValidatorService, InstantiationType.Delayed);
