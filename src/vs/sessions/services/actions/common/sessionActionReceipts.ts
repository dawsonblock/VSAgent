/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { PolicyDenialMetadata } from './sessionActionPolicy.js';
import { NormalizedHostTarget, SessionActionDenialReason, SessionActionKind, SessionHostKind } from './sessionActionTypes.js';

export const enum SessionActionReceiptStatus {
	Denied = 'denied',
	ApprovalRequired = 'approvalRequired',
	Approved = 'approved',
	Executed = 'executed',
	Failed = 'failed',
}

export interface SessionActionReceiptScopeSummary {
	readonly workspaceRoot?: URI;
	readonly projectRoot?: URI;
	readonly repositoryPath?: URI;
	readonly worktreeRoot?: URI;
	readonly cwd?: URI;
	readonly files: readonly URI[];
	readonly hostTarget: NormalizedHostTarget;
}

export interface SessionActionReceiptError {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
}

export interface SessionActionApprovalReceipt {
	readonly required: boolean;
	readonly granted: boolean;
	readonly source: 'implicit' | 'dialog' | 'existingApproval';
	readonly summary: string;
	readonly fingerprint?: string;
	readonly correlationId?: string;
}

export interface SessionActionReceipt {
	readonly id: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly hostKind: SessionHostKind;
	readonly hostTarget: NormalizedHostTarget;
	readonly actionId: string;
	readonly actionKind: SessionActionKind;
	readonly query?: string;
	readonly includePattern?: string;
	readonly isRegexp?: boolean;
	readonly maxResults?: number;
	readonly resultCount?: number;
	readonly resource?: URI;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly ref?: string;
	readonly requestedScope: SessionActionReceiptScopeSummary;
	readonly approvedScope: SessionActionReceiptScopeSummary;
	readonly requestedAt: number;
	readonly decidedAt: number;
	readonly completedAt?: number;
	readonly status: SessionActionReceiptStatus;
	readonly filesTouched: readonly URI[];
	readonly cwd?: URI;
	readonly repositoryPath?: URI;
	readonly worktreePath?: URI;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly branch?: string;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly approvalSummary?: string;
	readonly approvalFingerprint?: string;
	readonly denialReason?: SessionActionDenialReason;
	readonly approval?: SessionActionApprovalReceipt;
	readonly denial?: PolicyDenialMetadata;
	readonly advisorySources: readonly string[];
	readonly executionSummary?: string;
	readonly error?: SessionActionReceiptError;
}

export interface SessionActionReceiptStoreEntry {
	readonly sessionId: string;
	readonly receipt: SessionActionReceipt;
}

export interface ISessionActionReceiptService {
	readonly _serviceBrand: undefined;

	readonly onDidAppendReceipt: Event<SessionActionReceiptStoreEntry>;
	appendReceipt(receipt: SessionActionReceipt): void;
	getReceiptsForSession(sessionId: string): readonly SessionActionReceipt[];
}

export const ISessionActionReceiptService = createDecorator<ISessionActionReceiptService>('sessionActionReceiptService');
