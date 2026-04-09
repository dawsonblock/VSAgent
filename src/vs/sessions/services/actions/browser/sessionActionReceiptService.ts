/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISessionActionReceiptService, SessionActionReceipt, SessionActionReceiptStoreEntry } from '../common/sessionActionReceipts.js';

export class SessionActionReceiptService extends Disposable implements ISessionActionReceiptService {
	declare readonly _serviceBrand: undefined;

	private readonly _receipts = new Map<string, SessionActionReceipt[]>();
	private readonly _onDidAppendReceipt = this._register(new Emitter<SessionActionReceiptStoreEntry>());
	readonly onDidAppendReceipt = this._onDidAppendReceipt.event;

	appendReceipt(receipt: SessionActionReceipt): void {
		const existing = this._receipts.get(receipt.sessionId) ?? [];
		existing.push(receipt);
		this._receipts.set(receipt.sessionId, existing);
		this._onDidAppendReceipt.fire({ sessionId: receipt.sessionId, receipt });
	}

	getReceiptsForSession(sessionId: string): readonly SessionActionReceipt[] {
		return this._receipts.get(sessionId) ?? [];
	}
}

registerSingleton(ISessionActionReceiptService, SessionActionReceiptService, InstantiationType.Delayed);
