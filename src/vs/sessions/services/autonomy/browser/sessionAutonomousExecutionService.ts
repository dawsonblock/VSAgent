/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISessionActionPolicyService } from '../../actions/browser/sessionActionPolicyService.js';
import { ProviderCapabilitySet } from '../../actions/common/sessionActionPolicy.js';
import { ISessionActionService } from '../../actions/common/sessionActionService.js';
import { SessionActionExecutionContext, SessionActionStatus } from '../../actions/common/sessionActionTypes.js';
import { ISessionCheckpointService } from '../../checkpoints/common/sessionCheckpointService.js';
import { SessionCheckpoint } from '../../checkpoints/common/sessionCheckpointTypes.js';
import { ISessionEvaluationService } from '../../evaluation/common/sessionEvaluationService.js';
import { AutonomyContinuationDecision, AutonomyStopReason } from '../common/sessionAutonomyTypes.js';
import { ISessionPlanValidatorService } from '../../planning/common/sessionPlanValidatorService.js';
import { isExecutableSessionPlanStepKind, SessionPlanCheckpointRequirement, SessionPlanStatus, SessionPlanStep } from '../../planning/common/sessionPlanTypes.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import { ISessionAutonomousExecutionService, SessionAutonomousExecutionIssue, SessionAutonomousExecutionRequest, SessionAutonomousExecutionResult, SessionAutonomousStepResult } from '../common/sessionAutonomousExecutionService.js';
import { ISessionBudgetService, SessionBudgetState } from '../common/sessionBudgetService.js';
import { ISessionAutonomyPolicyService } from '../common/sessionAutonomyPolicyService.js';

export class SessionAutonomousExecutionService extends Disposable implements ISessionAutonomousExecutionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@ISessionActionPolicyService private readonly _policyService: ISessionActionPolicyService,
		@ISessionAutonomyPolicyService private readonly _autonomyPolicyService: ISessionAutonomyPolicyService,
		@ISessionPlanValidatorService private readonly _planValidatorService: ISessionPlanValidatorService,
		@ISessionBudgetService private readonly _budgetService: ISessionBudgetService,
		@ISessionCheckpointService private readonly _checkpointService: ISessionCheckpointService,
		@ISessionEvaluationService private readonly _evaluationService: ISessionEvaluationService,
		@ISessionActionService private readonly _sessionActionService: ISessionActionService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async executePlan(request: SessionAutonomousExecutionRequest): Promise<SessionAutonomousExecutionResult> {
		const providerCapabilities = this._sessionsProvidersService.getProviderCapabilities(request.session.providerId, request.session.sessionId);
		const reasons: string[] = [];
		const issues: SessionAutonomousExecutionIssue[] = [];

		if (!providerCapabilities) {
			return this._stop(request, SessionPlanStatus.Rejected, AutonomyStopReason.CapabilityDenied, this._budgetService.createBudgetState(request.plan.budget), [{ message: `Provider '${request.session.providerId}' does not expose a Sessions capability set.` }], reasons, []);
		}

		const executionContext = this._createExecutionContext(request.session, providerCapabilities);
		const policy = await this._policyService.getPolicySnapshot(executionContext, this._collectPolicyRoots(executionContext));
		const autonomyDecision = this._autonomyPolicyService.resolveProfile({
			mode: request.mode,
			providerCapabilities,
			policy,
			hostKind: executionContext.hostTarget.kind,
		});
		reasons.push(...autonomyDecision.reasons);

		for (const step of request.plan.steps) {
			if (isExecutableSessionPlanStepKind(step.kind) && !autonomyDecision.allowedProfile.stepKinds.includes(step.kind)) {
				issues.push({ stepId: step.id, message: `Step '${step.id}' is outside the '${request.mode}' autonomy envelope.` });
			}
			for (const riskClass of step.riskClasses) {
				if (!autonomyDecision.allowedProfile.riskClasses.includes(riskClass)) {
					issues.push({ stepId: step.id, message: `Step '${step.id}' carries blocked risk '${riskClass}'.` });
				}
			}
		}

		const validation = await this._planValidatorService.validatePlan(request.plan, {
			executionContext,
			providerCapabilities,
			requestedPermissionMode: request.requestedPermissionMode,
			policy,
		});

		issues.push(...validation.issues.map(issue => ({ stepId: issue.stepId, message: issue.message })));

		const budgetState = this._budgetService.createBudgetState(request.plan.budget, autonomyDecision.allowedProfile.budget);
		if (issues.length > 0) {
			return this._stop(request, SessionPlanStatus.Rejected, AutonomyStopReason.ValidationFailed, budgetState, issues, reasons, []);
		}

		const remaining = new Map(request.plan.steps.map(step => [step.id, step]));
		const completed = new Set<string>();
		const stepResults: SessionAutonomousStepResult[] = [];
		let state = budgetState;

		while (remaining.size > 0) {
			const nextStep = this._findNextReadyStep(remaining, completed);
			if (!nextStep) {
				issues.push({ message: 'The plan has no executable dependency order remaining.' });
				return this._stop(request, SessionPlanStatus.Rejected, AutonomyStopReason.ValidationFailed, state, issues, reasons, stepResults);
			}

			if (!isExecutableSessionPlanStepKind(nextStep.kind) || !nextStep.action) {
				completed.add(nextStep.id);
				remaining.delete(nextStep.id);
				continue;
			}

			let checkpoint: SessionCheckpoint | undefined;
			while (true) {
				const reservation = this._budgetService.reserveStep(state, nextStep);
				state = reservation.state;
				if (!reservation.allowed) {
					issues.push({ stepId: nextStep.id, message: reservation.exhaustion?.message ?? `Step '${nextStep.id}' exhausted the execution budget.` });
					return this._stop(request, SessionPlanStatus.Stopped, AutonomyStopReason.BudgetExceeded, state, issues, reasons, stepResults);
				}

				if (nextStep.checkpointRequirement === SessionPlanCheckpointRequirement.Required) {
					checkpoint = this._checkpointService.createCheckpoint({
						sessionId: request.session.sessionId,
						providerId: request.session.providerId,
						planId: request.plan.id,
						step: nextStep,
					});
				}

				const result = await this._sessionActionService.submitAction(request.session.sessionId, request.session.providerId, nextStep.action);
				state = this._budgetService.finalizeStep(state, nextStep, result);
				const evaluation = this._evaluationService.evaluateStep({
					plan: request.plan,
					step: nextStep,
					result,
					receipt: result.receiptId ? this._getReceipt(request.session.sessionId, result.receiptId) : undefined,
					checkpoint,
					budgetState: state,
				});

				const stepResult: SessionAutonomousStepResult = {
					stepId: nextStep.id,
					attempts: state.attemptsByStep[nextStep.id] ?? 0,
					checkpointId: checkpoint?.id,
					receiptId: result.receiptId,
					result,
					evaluation,
				};
				stepResults.push(stepResult);

				if (evaluation.decision === AutonomyContinuationDecision.Continue) {
					completed.add(nextStep.id);
					remaining.delete(nextStep.id);
					break;
				}

				if (evaluation.decision === AutonomyContinuationDecision.Replan && result.status === SessionActionStatus.Failed && this._budgetService.canRetryStep(state, nextStep.id)) {
					this._logService.debug(`[SessionAutonomousExecution] Retrying step ${nextStep.id} within bounded retry budget.`);
					continue;
				}

				issues.push(...evaluation.issues.map(issue => ({ stepId: nextStep.id, message: issue.message })));
				return this._stop(request, SessionPlanStatus.Stopped, evaluation.stopReason ?? (evaluation.decision === AutonomyContinuationDecision.Replan ? AutonomyStopReason.RepeatedFailure : AutonomyStopReason.Interrupted), state, issues, reasons, stepResults);
			}
		}

		return {
			planId: request.plan.id,
			sessionId: request.session.sessionId,
			providerId: request.session.providerId,
			status: SessionPlanStatus.Completed,
			decision: AutonomyContinuationDecision.Stop,
			stopReason: AutonomyStopReason.Completed,
			stepResults,
			budgetState: state,
			issues,
			reasons,
		};
	}

	private _createExecutionContext(session: SessionAutonomousExecutionRequest['session'], providerCapabilities: ProviderCapabilitySet): SessionActionExecutionContext {
		const repository = session.workspace.get()?.repositories[0];
		const repositoryPath = repository?.uri;
		const worktreeRoot = repository?.workingDirectory;
		const projectRoot = worktreeRoot ?? repositoryPath;
		return {
			sessionId: session.sessionId,
			providerId: session.providerId,
			sessionResource: session.resource,
			workspaceRoot: repositoryPath,
			projectRoot,
			repositoryPath,
			worktreeRoot,
			hostTarget: {
				kind: providerCapabilities.hostKind,
				providerId: session.providerId,
				authority: this._sessionsProvidersService.getProviderMetadata(session.providerId, session.sessionId)?.remoteAddress,
			},
			advisorySources: [],
			sessionType: session.sessionType,
		};
	}

	private _collectPolicyRoots(executionContext: SessionActionExecutionContext): URI[] {
		return [
			executionContext.workspaceRoot,
			executionContext.projectRoot,
			executionContext.repositoryPath,
			executionContext.worktreeRoot,
		].filter((resource): resource is URI => !!resource);
	}

	private _findNextReadyStep(remaining: ReadonlyMap<string, SessionPlanStep>, completed: ReadonlySet<string>): SessionPlanStep | undefined {
		for (const step of remaining.values()) {
			if (step.dependsOn.every(dependencyId => completed.has(dependencyId))) {
				return step;
			}
		}

		return undefined;
	}

	private _getReceipt(sessionId: string, receiptId: string) {
		return this._sessionActionService.getReceiptsForSession(sessionId).find(receipt => receipt.id === receiptId);
	}

	private _stop(request: SessionAutonomousExecutionRequest, status: SessionPlanStatus, stopReason: AutonomyStopReason, budgetState: SessionBudgetState, issues: readonly SessionAutonomousExecutionIssue[], reasons: readonly string[], stepResults: readonly SessionAutonomousStepResult[]): SessionAutonomousExecutionResult {
		return {
			planId: request.plan.id,
			sessionId: request.session.sessionId,
			providerId: request.session.providerId,
			status,
			decision: AutonomyContinuationDecision.Stop,
			stopReason,
			stepResults,
			budgetState,
			issues,
			reasons,
		};
	}
}

registerSingleton(ISessionAutonomousExecutionService, SessionAutonomousExecutionService, InstantiationType.Delayed);
