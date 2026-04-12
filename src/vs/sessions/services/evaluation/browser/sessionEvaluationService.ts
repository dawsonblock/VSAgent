/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionActionDenialReason, SessionActionKind, SessionActionStatus, SessionWriteOperationStatus, WritePatchActionResult } from '../../actions/common/sessionActionTypes.js';
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
			case SessionActionStatus.Failed: {
				const failureStopReason = this._mapFailureStopReason(request.result.denialReason);
				const exceededFailureBudget = request.budgetState.failures > request.budgetState.budget.maxFailures;
				const failureDecision = failureStopReason || exceededFailureBudget
					? AutonomyContinuationDecision.Stop
					: AutonomyContinuationDecision.Replan;
				const stopReason = failureStopReason ?? (exceededFailureBudget ? AutonomyStopReason.RepeatedFailure : undefined);
				issues.push({ kind: this._mapIssueKind(failureStopReason), message: request.result.summary ?? request.result.denialMessage ?? `Step '${request.step.id}' failed.` });
				return {
					decision: failureDecision,
					stopReason,
					issues,
					scopeDrift,
					madeProgress,
					summary: request.result.summary ?? request.result.denialMessage ?? `Step '${request.step.id}' failed.`,
				};
			}
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
				return request.receipt.resource ? !expectedFiles.has(request.receipt.resource.toString()) : false;
			case SessionActionKind.WritePatch: {
const filesTouched = request.receipt.filesTouched;
				return filesTouched.some(resource => !expectedFiles.has(resource.toString()));
			}
			default:
				return false;
		}
	}

	private _madeProgress(request: SessionEvaluationRequest): boolean {
		if (request.result.status !== SessionActionStatus.Executed) {
			return false;
		}

		const receipt = request.receipt;

		switch (request.result.kind) {
			case SessionActionKind.SearchWorkspace:
				return (receipt.matchCount ?? receipt.resultCount ?? 0) > 0;
			case SessionActionKind.ReadFile: {
				const contents = receipt.readContents;
				const lineCount = receipt.readLineCount;
				return (typeof contents === 'string' && contents.length > 0) || (typeof lineCount === 'number' && lineCount > 0);
			}
			case SessionActionKind.WritePatch:
				return this._getSuccessfulWriteCount(request) > 0;
			case SessionActionKind.RunCommand:
				return receipt.exitCode === undefined || receipt.exitCode === 0;
			case SessionActionKind.GitStatus:
				return typeof receipt.filesChanged === 'number' || Boolean(receipt.operation);
			case SessionActionKind.GitDiff: {
				const filesChanged = receipt.filesChanged ?? 0;
				const insertions = receipt.insertions ?? 0;
				const deletions = receipt.deletions ?? 0;
				return filesChanged > 0 || insertions > 0 || deletions > 0 || Boolean(receipt.stdout);
			}
			case SessionActionKind.OpenWorktree:
				return request.result.opened === true;
			default:
				return true;
		}
	}

	private _getSuccessfulWriteCount(request: SessionEvaluationRequest): number {
		if (request.result.kind !== SessionActionKind.WritePatch) {
			return 0;
		}

		const writeOperations = request.receipt.writeOperations ?? request.result.operations;
		if (writeOperations && writeOperations.length > 0) {
			return writeOperations.filter(operation => operation.status === SessionWriteOperationStatus.Created || operation.status === SessionWriteOperationStatus.Updated || operation.status === SessionWriteOperationStatus.Deleted).length;
		}

		return request.result.applied ? request.result.filesTouched.length : 0;
	}

	private _mapFailureStopReason(reason: SessionActionDenialReason | undefined): AutonomyStopReason | undefined {
		if (!reason || reason === SessionActionDenialReason.ExecutionFailed) {
			return undefined;
		}

		return this._mapDenialReason(reason);
	}

	private _mapIssueKind(stopReason: AutonomyStopReason | undefined): SessionEvaluationIssue['kind'] {
		switch (stopReason) {
			case AutonomyStopReason.PolicyDenied:
				return 'policy';
			case AutonomyStopReason.CapabilityDenied:
				return 'capability';
			case AutonomyStopReason.ScopeDrift:
				return 'scopeDrift';
			case AutonomyStopReason.ApprovalRequired:
				return 'approval';
			default:
				return 'failure';
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
