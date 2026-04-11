/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionPlan, SessionPlanningRequest } from './sessionPlanTypes.js';

export interface ISessionPlanningService {
	readonly _serviceBrand: undefined;

	createPlan(request: SessionPlanningRequest): Promise<SessionPlan>;
}

export const ISessionPlanningService = createDecorator<ISessionPlanningService>('sessionPlanningService');
