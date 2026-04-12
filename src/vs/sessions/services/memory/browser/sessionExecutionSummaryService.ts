/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { derived, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISessionExecutionMemoryService, SessionExecutionMemoryEntry, SessionExecutionPhase } from '../common/sessionExecutionMemoryService.js';
import { ISessionExecutionSummaryService, SessionExecutionSummary } from '../common/sessionExecutionSummaryService.js';

export class SessionExecutionSummaryService implements ISessionExecutionSummaryService {
	declare readonly _serviceBrand: undefined;

	private readonly _summaries = new Map<string, IObservable<SessionExecutionSummary | undefined>>();

	constructor(
		@ISessionExecutionMemoryService private readonly _memoryService: ISessionExecutionMemoryService,
	) { }

	getSessionSummary(sessionId: string): IObservable<SessionExecutionSummary | undefined> {
		let summary = this._summaries.get(sessionId);
		if (!summary) {
			summary = derived(reader => createSessionExecutionSummary(this._memoryService.getSessionEntry(sessionId).read(reader)));
			this._summaries.set(sessionId, summary);
		}

		return summary;
	}

	getSessionSummaryValue(sessionId: string): SessionExecutionSummary | undefined {
		return this.getSessionSummary(sessionId).get();
	}
}

export function getSessionExecutionProgressLabel(entry: SessionExecutionMemoryEntry | undefined): string | undefined {
	if (!entry?.progress) {
		return undefined;
	}

	return localize('sessionExecutionProgressLabel', "{0}/{1} steps", entry.progress.completedSteps, entry.progress.totalSteps);
}

export function createSessionExecutionSummary(entry: SessionExecutionMemoryEntry | undefined): SessionExecutionSummary | undefined {
	if (!entry) {
		return undefined;
	}

	const progressLabel = getSessionExecutionProgressLabel(entry);
	const issueCount = entry.result?.issues.length ?? (entry.errorMessage ? 1 : 0);
	const defaultDetail = entry.summary ?? entry.intent ?? localize('sessionExecutionNoDetail', "No advisory execution details are available yet.");
	let headline: string;
	let detail: string;

	switch (entry.phase) {
		case SessionExecutionPhase.Planning:
			headline = localize('sessionExecutionSummaryPlanningHeadline', "Planning Advisory Steps");
			detail = defaultDetail;
			break;
		case SessionExecutionPhase.Ready:
			headline = localize('sessionExecutionSummaryReadyHeadline', "Plan Ready");
			detail = entry.plan
				? localize('sessionExecutionSummaryReadyDetail', "Prepared a {0}-step advisory plan for the active session.", entry.plan.steps.length)
				: defaultDetail;
			break;
		case SessionExecutionPhase.Executing:
			headline = localize('sessionExecutionSummaryExecutingHeadline', "Executing Advisory Steps");
			detail = entry.lastReceipt?.executionSummary
				?? entry.lastReceipt?.error?.message
				?? entry.lastStepResult?.evaluation.summary
				?? entry.lastStepResult?.result.summary
				?? defaultDetail;
			break;
		case SessionExecutionPhase.Completed:
			headline = localize('sessionExecutionSummaryCompletedHeadline', "Advisory Run Completed");
			detail = entry.result?.reasons[0]
				?? entry.lastReceipt?.executionSummary
				?? entry.lastStepResult?.evaluation.summary
				?? localize('sessionExecutionSummaryCompletedDetail', "The advisory run completed successfully.");
			break;
		case SessionExecutionPhase.Stopped:
			headline = localize('sessionExecutionSummaryStoppedHeadline', "Advisory Run Stopped");
			detail = entry.result?.issues[0]?.message
				?? entry.result?.stopReason
				?? defaultDetail;
			break;
		case SessionExecutionPhase.Rejected:
			headline = localize('sessionExecutionSummaryRejectedHeadline', "Plan Rejected");
			detail = entry.result?.issues[0]?.message
				?? localize('sessionExecutionSummaryRejectedDetail', "The advisory plan was rejected before execution.");
			break;
		case SessionExecutionPhase.Failed:
			headline = localize('sessionExecutionSummaryFailedHeadline', "Advisory Run Failed");
			detail = entry.errorMessage ?? entry.result?.issues[0]?.message ?? defaultDetail;
			break;
		default:
			headline = localize('sessionExecutionSummaryDefaultHeadline', "Advisory State");
			detail = defaultDetail;
	}

	return {
		headline,
		detail,
		progressLabel,
		issueCount,
		updatedAt: entry.updatedAt,
	};
}

registerSingleton(ISessionExecutionSummaryService, SessionExecutionSummaryService, InstantiationType.Delayed);
