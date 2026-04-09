/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IAgentHostToolConfirmationRequest, IAgentHostToolConfirmationResolution } from './agentHostSessionHandler.js';

export const enum AgentHostToolConfirmationSource {
	Local = 'local',
	Remote = 'remote',
}

export interface IAgentHostToolConfirmationResolverRequest extends IAgentHostToolConfirmationRequest {
	readonly source: AgentHostToolConfirmationSource;
	readonly connectionAuthority: string;
}

export interface IAgentHostToolConfirmationResolverService {
	readonly _serviceBrand: undefined;

	resolveToolConfirmation(request: IAgentHostToolConfirmationResolverRequest): Promise<IAgentHostToolConfirmationResolution | undefined>;
}

export const IAgentHostToolConfirmationResolverService = createDecorator<IAgentHostToolConfirmationResolverService>('agentHostToolConfirmationResolverService');

class AgentHostToolConfirmationResolverService implements IAgentHostToolConfirmationResolverService {
	declare readonly _serviceBrand: undefined;

	async resolveToolConfirmation(_request: IAgentHostToolConfirmationResolverRequest): Promise<IAgentHostToolConfirmationResolution | undefined> {
		return undefined;
	}
}

registerSingleton(IAgentHostToolConfirmationResolverService, AgentHostToolConfirmationResolverService, InstantiationType.Delayed);
