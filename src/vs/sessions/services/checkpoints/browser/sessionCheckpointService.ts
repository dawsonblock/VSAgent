/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISessionActionService } from '../../actions/common/sessionActionService.js';
import { ISessionCheckpointService } from '../common/sessionCheckpointService.js';
import { SessionCheckpoint, SessionCheckpointRequest } from '../common/sessionCheckpointTypes.js';

export class SessionCheckpointService extends Disposable implements ISessionCheckpointService {
	declare readonly _serviceBrand: undefined;

	private readonly _checkpoints = new Map<string, SessionCheckpoint>();
	private readonly _sessionIndex = new Map<string, SessionCheckpoint[]>();
	private readonly _onDidCreateCheckpoint = this._register(new Emitter<SessionCheckpoint>());
	readonly onDidCreateCheckpoint = this._onDidCreateCheckpoint.event;

	constructor(
		@ISessionActionService private readonly _sessionActionService: ISessionActionService,
	) {
		super();
	}

	createCheckpoint(request: SessionCheckpointRequest): SessionCheckpoint {
		const receipts = this._sessionActionService.getReceiptsForSession(request.sessionId);
		const previousReceipt = receipts[receipts.length - 1];
		const checkpoint: SessionCheckpoint = {
			id: generateUuid(),
			sessionId: request.sessionId,
			providerId: request.providerId,
			planId: request.planId,
			stepId: request.step.id,
			createdAt: Date.now(),
			preActionReceiptCount: receipts.length,
			previousReceiptId: previousReceipt?.id,
			targetFiles: request.step.estimatedScope.files,
			repositoryPath: request.step.estimatedScope.repositoryPath,
			worktreeRoot: request.step.estimatedScope.worktreeRoot,
			summary: request.preActionSummary ?? request.step.description ?? request.step.title,
		};

		this._checkpoints.set(checkpoint.id, checkpoint);
		const existing = this._sessionIndex.get(checkpoint.sessionId) ?? [];
		existing.push(checkpoint);
		this._sessionIndex.set(checkpoint.sessionId, existing);
		this._onDidCreateCheckpoint.fire(checkpoint);
		return checkpoint;
	}

	getCheckpoint(checkpointId: string): SessionCheckpoint | undefined {
		return this._checkpoints.get(checkpointId);
	}

	getCheckpointsForSession(sessionId: string): readonly SessionCheckpoint[] {
		return this._sessionIndex.get(sessionId) ?? [];
	}
}

registerSingleton(ISessionCheckpointService, SessionCheckpointService, InstantiationType.Delayed);
