/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface SessionExecutionSummary {
	readonly headline: string;
	readonly detail: string;
	readonly progressLabel?: string;
	readonly issueCount: number;
	readonly updatedAt: number;
}

export interface ISessionExecutionSummaryService {
	readonly _serviceBrand: undefined;

	getSessionSummary(sessionId: string): IObservable<SessionExecutionSummary | undefined>;
	getSessionSummaryValue(sessionId: string): SessionExecutionSummary | undefined;
}

export const ISessionExecutionSummaryService = createDecorator<ISessionExecutionSummaryService>('sessionExecutionSummaryService');
