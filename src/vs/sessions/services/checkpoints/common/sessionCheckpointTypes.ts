/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { SessionPlanStep } from '../../planning/common/sessionPlanTypes.js';

export interface SessionCheckpoint {
	readonly id: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly planId: string;
	readonly stepId: string;
	readonly createdAt: number;
	readonly preActionReceiptCount: number;
	readonly previousReceiptId?: string;
	readonly targetFiles: readonly URI[];
	readonly repositoryPath?: URI;
	readonly worktreeRoot?: URI;
	readonly summary: string;
}

export interface SessionCheckpointRequest {
	readonly sessionId: string;
	readonly providerId: string;
	readonly planId: string;
	readonly step: SessionPlanStep;
	readonly preActionSummary?: string;
}
