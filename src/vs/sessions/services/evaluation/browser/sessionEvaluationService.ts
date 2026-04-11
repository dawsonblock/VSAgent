/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionStatus, WritePatchActionResult } from '../../actions/common/sessionActionTypes.js';
import { AutonomyContinuationDecision, AutonomyStopReason } from '../../autonomy/common/sessionAutonomyTypes.js';
import { ISessionEvaluationService } from '../common/sessionEvaluationService.js';
import { SessionEvaluationIssue, SessionEvaluationRequest, SessionEvaluationResult } from '../common/sessionEvaluationTypes.js';

export class SessionEvaluationService extends Disposable implements ISessionEvaluationService {
	declare readonly _serviceBrand: undefined;

	evaluateStep(request: SessionEvaluationRequest): SessionEvaluationResult {
		const issues: SessionEvaluationIssue[] = [];
		const scopeDrift = this._detectScopeDrift(request);
		const madeProgress = this._madeProgress(request);

		if (request.budgetState.exhaustion) {
			issues.push({ kind: 'budget', message: request.budgetState.exhaustion.message });
			return {
				decision: AutonomyContinuationDecision.Stop,
				stopReason: AutonomyStopReason.BudgetExceeded,
				issues,
				scopeDrift,
				madeProgress,
				summary: request.budgetState.exhaustion.message,
			};
		}

		if (scopeDrift) {
			issues.push({ kind: 'scopeDrift', message: `Step '${request.step.id}' drifted outside its estimated scope.` });
			return {
				decision: AutonomyContinuationDecision.Stop,
				stopReason: AutonomyStopReason.ScopeDrift,
				issues,
				scopeDrift,
				madeProgress,
				summary: `Step '${request.step.id}' drifted outside its estimated scope.`,
			};
		}

		switch (request.result.status) {
			case SessionActionStatus.Denied: {
				const denialReason = this._mapDenialReason(request.result.denialReason);
				issues.push({ kind: denialReason === AutonomyStopReason.PolicyDenied ? 'policy' : 'capability', message: request.result.summary ?? request.result.denialMessage ?? `Step '${request.step.id}' was denied.` });
				return {
					decision: AutonomyContinuationDecision.Stop,
					stopReason: denialReason,
					issues,
					scopeDrift,
					madeProgress,
					summary: request.result.summary ?? request.result.denialMessage ?? `Step '${request.step.id}' was denied.`,
				};
			}
			case SessionActionStatus.Failed:
				issues.push({ kind: 'failure', message: request.result.summary ?? `Step '${request.step.id}' failed.` });
				return {
					decision: request.budgetState.failures > request.budgetState.budget.maxFailures
						? AutonomyContinuationDecision.Stop
						: AutonomyContinuationDecision.Replan,
					stopReason: request.budgetState.failures > request.budgetState.budget.maxFailures
						? AutonomyStopReason.RepeatedFailure
						: undefined,
					issues,
					scopeDrift,
					madeProgress,
					summary: request.result.summary ?? `Step '${request.step.id}' failed.`,
				};
			case SessionActionStatus.Executed:
				if (!madeProgress) {
					issues.push({ kind: 'noProgress', message: `Step '${request.step.id}' executed but did not produce progress toward the plan.` });
					return {
						decision: AutonomyContinuationDecision.Replan,
						issues,
						scopeDrift,
						madeProgress,
						summary: `Step '${request.step.id}' executed but did not produce progress toward the plan.`,
					};
				}
				return {
					decision: AutonomyContinuationDecision.Continue,
					issues,
					scopeDrift,
					madeProgress,
					summary: request.result.summary ?? `Step '${request.step.id}' completed successfully.`,
				};
			default:
				issues.push({ kind: 'failure', message: `Step '${request.step.id}' reached unexpected status '${request.result.status}'.` });
				return {
					decision: AutonomyContinuationDecision.Stop,
					stopReason: AutonomyStopReason.Interrupted,
					issues,
					scopeDrift,
					madeProgress,
					summary: `Step '${request.step.id}' reached unexpected status '${request.result.status}'.`,
				};
		}
	}

	private _detectScopeDrift(request: SessionEvaluationRequest): boolean {
		const expectedFiles = new Set(request.step.estimatedScope.files.map(resource => resource.toString()));
		if (expectedFiles.size === 0) {
			return false;
		}

		switch (request.result.kind) {
			case SessionActionKind.ReadFile:
				return !expectedFiles.has(request.result.resource.toString());
			case SessionActionKind.WritePatch:
				return (request.result as WritePatchActionResult).filesTouched.some(resource => !expectedFiles.has(resource.toString()));
			default:
				return false;
		}
	}

	private _madeProgress(request: SessionEvaluationRequest): boolean {
		if (request.result.status !== SessionActionStatus.Executed) {
			return false;
		}

		switch (request.result.kind) {
			case SessionActionKind.SearchWorkspace:
				return (request.result.resultCount ?? 0) > 0;
			case SessionActionKind.ReadFile:
				return typeof request.result.contents === 'string' && request.result.contents.length > 0;
			case SessionActionKind.WritePatch:
				return request.result.applied === true;
			case SessionActionKind.RunCommand:
				return request.result.exitCode === undefined || request.result.exitCode === 0;
			case SessionActionKind.OpenWorktree:
				return request.result.opened === true;
			default:
				return true;
		}
	}

	private _mapDenialReason(reason: SessionActionDenialReason | undefined): AutonomyStopReason {
		switch (reason) {
			case SessionActionDenialReason.PolicyDenied:
				return AutonomyStopReason.PolicyDenied;
			case SessionActionDenialReason.ProviderCapabilityMissing:
			case SessionActionDenialReason.UnsupportedAction:
				return AutonomyStopReason.CapabilityDenied;
			case SessionActionDenialReason.InvalidPathScope:
			case SessionActionDenialReason.RootEscape:
			case SessionActionDenialReason.SecretPath:
			case SessionActionDenialReason.WorktreeMismatch:
			case SessionActionDenialReason.HostTargetMismatch:
				return AutonomyStopReason.ScopeDrift;
			case SessionActionDenialReason.ApprovalDenied:
				return AutonomyStopReason.ApprovalRequired;
			default:
				return AutonomyStopReason.Interrupted;
		}
	}
}

registerSingleton(ISessionEvaluationService, SessionEvaluationService, InstantiationType.Delayed);
