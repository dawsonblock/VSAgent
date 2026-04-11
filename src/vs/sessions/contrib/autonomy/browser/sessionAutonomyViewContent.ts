/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SessionExecutionMemoryEntry, SessionExecutionPhase } from '../../../services/memory/common/sessionExecutionMemoryService.js';
import { SessionExecutionSummary } from '../../../services/memory/common/sessionExecutionSummaryService.js';
import { SessionPlan } from '../../../services/planning/common/sessionPlanTypes.js';

export function formatSessionPlanText(sessionLabel: string | undefined, plan: SessionPlan | undefined): string {
	const lines: string[] = [];
	lines.push(sessionLabel
		? localize('sessionAutonomyPlanHeader', "Advisory plan for {0}", sessionLabel)
		: localize('sessionAutonomyPlanHeaderNoSession', "Advisory plan"));
	lines.push('');

	if (!plan) {
		lines.push(localize('sessionAutonomyPlanEmpty', "No advisory plan has been recorded for the active session yet."));
		return lines.join('\n');
	}

	lines.push(localize('sessionAutonomyPlanIntent', "Intent: {0}", plan.intent));
	if (plan.summary) {
		lines.push(localize('sessionAutonomyPlanSummary', "Summary: {0}", plan.summary));
	}
	lines.push(localize('sessionAutonomyPlanHost', "Host: {0}", plan.hostTarget.kind));
	lines.push(localize('sessionAutonomyPlanBudget', "Budget: {0} steps, {1} commands, {2} file writes, {3} modified files", plan.budget.maxSteps, plan.budget.maxCommands, plan.budget.maxFileWrites, plan.budget.maxModifiedFiles));
	lines.push('');
	lines.push(localize('sessionAutonomyPlanStepsHeader', "Steps"));

	for (let index = 0; index < plan.steps.length; index++) {
		const step = plan.steps[index];
		lines.push(`${index + 1}. ${step.title} [${step.kind}]`);
		if (step.description) {
			lines.push(`   ${step.description}`);
		}
		if (step.dependsOn.length > 0) {
			lines.push(localize('sessionAutonomyPlanDependsOn', "   Depends on: {0}", step.dependsOn.join(', ')));
		}
		if (step.riskClasses.length > 0) {
			lines.push(localize('sessionAutonomyPlanRisk', "   Risks: {0}", step.riskClasses.join(', ')));
		}
		if (step.estimatedApprovalRequired) {
			lines.push(localize('sessionAutonomyPlanApproval', "   Approval is expected before execution."));
		}
	}

	return lines.join('\n');
}

export function formatSessionExecutionSummaryText(sessionLabel: string | undefined, summary: SessionExecutionSummary | undefined): string {
	const lines: string[] = [];
	lines.push(sessionLabel
		? localize('sessionAutonomySummaryHeader', "Advisory summary for {0}", sessionLabel)
		: localize('sessionAutonomySummaryHeaderNoSession', "Advisory summary"));
	lines.push('');

	if (!summary) {
		lines.push(localize('sessionAutonomySummaryEmpty', "No advisory summary has been recorded for the active session yet."));
		return lines.join('\n');
	}

	lines.push(summary.headline);
	lines.push(summary.detail);
	if (summary.progressLabel) {
		lines.push(localize('sessionAutonomySummaryProgress', "Progress: {0}", summary.progressLabel));
	}
	if (summary.issueCount > 0) {
		lines.push(localize('sessionAutonomySummaryIssues', "Issues: {0}", summary.issueCount));
	}
	lines.push(localize('sessionAutonomySummaryUpdated', "Updated: {0}", formatTimestamp(summary.updatedAt)));
	return lines.join('\n');
}

export function formatSessionAutonomyStatusText(sessionLabel: string | undefined, entry: SessionExecutionMemoryEntry | undefined, summary: SessionExecutionSummary | undefined): string {
	const lines: string[] = [];
	lines.push(sessionLabel
		? localize('sessionAutonomyStatusHeader', "Advisory status for {0}", sessionLabel)
		: localize('sessionAutonomyStatusHeaderNoSession', "Advisory status"));
	lines.push('');

	if (!entry) {
		lines.push(localize('sessionAutonomyStatusEmpty', "No advisory planning or execution state has been recorded for the active session yet."));
		return lines.join('\n');
	}

	lines.push(localize('sessionAutonomyStatusPhase', "Phase: {0}", formatPhase(entry.phase)));
	if (summary?.progressLabel) {
		lines.push(localize('sessionAutonomyStatusProgress', "Progress: {0}", summary.progressLabel));
	}
	if (entry.lastStepResult) {
		lines.push(localize('sessionAutonomyStatusLastStep', "Last step: {0}", entry.lastStepResult.stepId));
		if (entry.lastStepResult.evaluation.summary) {
			lines.push(localize('sessionAutonomyStatusLastEvaluation', "Last evaluation: {0}", entry.lastStepResult.evaluation.summary));
		}
	}
	if (entry.result?.stopReason) {
		lines.push(localize('sessionAutonomyStatusStopReason', "Stop reason: {0}", entry.result.stopReason));
	}
	if (entry.errorMessage) {
		lines.push(localize('sessionAutonomyStatusError', "Error: {0}", entry.errorMessage));
	}
	if (entry.result?.issues.length) {
		lines.push(localize('sessionAutonomyStatusIssues', "Issues: {0}", entry.result.issues.length));
		lines.push(localize('sessionAutonomyStatusFirstIssue', "First issue: {0}", entry.result.issues[0].message));
	}
	lines.push(localize('sessionAutonomyStatusStarted', "Started: {0}", formatTimestamp(entry.startedAt)));
	lines.push(localize('sessionAutonomyStatusUpdated', "Updated: {0}", formatTimestamp(entry.updatedAt)));
	return lines.join('\n');
}

function formatPhase(phase: SessionExecutionPhase): string {
	switch (phase) {
		case SessionExecutionPhase.Planning:
			return localize('sessionAutonomyPhasePlanning', "Planning");
		case SessionExecutionPhase.Ready:
			return localize('sessionAutonomyPhaseReady', "Ready");
		case SessionExecutionPhase.Executing:
			return localize('sessionAutonomyPhaseExecuting', "Executing");
		case SessionExecutionPhase.Completed:
			return localize('sessionAutonomyPhaseCompleted', "Completed");
		case SessionExecutionPhase.Stopped:
			return localize('sessionAutonomyPhaseStopped', "Stopped");
		case SessionExecutionPhase.Rejected:
			return localize('sessionAutonomyPhaseRejected', "Rejected");
		case SessionExecutionPhase.Failed:
			return localize('sessionAutonomyPhaseFailed', "Failed");
		default:
			return phase;
	}
}

function formatTimestamp(value: number): string {
	return new Date(value).toISOString();
}
