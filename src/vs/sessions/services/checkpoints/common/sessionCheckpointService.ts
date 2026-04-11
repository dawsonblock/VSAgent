/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionCheckpoint, SessionCheckpointRequest } from './sessionCheckpointTypes.js';

export interface ISessionCheckpointService {
	readonly _serviceBrand: undefined;

	readonly onDidCreateCheckpoint: Event<SessionCheckpoint>;

	createCheckpoint(request: SessionCheckpointRequest): SessionCheckpoint;
	getCheckpoint(checkpointId: string): SessionCheckpoint | undefined;
	getCheckpointsForSession(sessionId: string): readonly SessionCheckpoint[];
}

export const ISessionCheckpointService = createDecorator<ISessionCheckpointService>('sessionCheckpointService');
