/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionActionReceiptService, SessionActionReceipt, SessionActionReceiptStoreEntry } from './sessionActionReceipts.js';
import { SessionAction, SessionActionDenialReason, SessionActionResult } from './sessionActionTypes.js';

export interface ISessionActionActiveChangeEvent {
	readonly sessionId: string;
	readonly actionId: string;
	readonly active: boolean;
}

export interface ISessionActionDenialEvent {
	readonly sessionId: string;
	readonly providerId: string;
	readonly actionId: string;
	readonly denialReason: SessionActionDenialReason;
	readonly message?: string;
}

export interface ISessionActionService extends Pick<ISessionActionReceiptService, 'getReceiptsForSession'> {
	readonly _serviceBrand: undefined;

	readonly onDidAppendReceipt: Event<SessionActionReceiptStoreEntry>;
	readonly onDidChangeActiveAction: Event<ISessionActionActiveChangeEvent>;
	readonly onDidDenyAction: Event<ISessionActionDenialEvent>;

	submitAction(sessionId: string, providerId: string, action: SessionAction): Promise<SessionActionResult>;
	approveAction(sessionId: string, providerId: string, action: SessionAction): Promise<SessionActionResult>;
	getReceiptsForSession(sessionId: string): readonly SessionActionReceipt[];
}

export const ISessionActionService = createDecorator<ISessionActionService>('sessionActionService');
