/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SessionEvaluationRequest, SessionEvaluationResult } from './sessionEvaluationTypes.js';

export interface ISessionEvaluationService {
	readonly _serviceBrand: undefined;

	evaluateStep(request: SessionEvaluationRequest): SessionEvaluationResult;
}

export const ISessionEvaluationService = createDecorator<ISessionEvaluationService>('sessionEvaluationService');
