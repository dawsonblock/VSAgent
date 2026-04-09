/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProviderCapabilitySet } from './sessionActionPolicy.js';
import { NormalizedPathScope, SessionAction, SessionActionDenialReason, SessionActionExecutionContext, SessionActionScope } from './sessionActionTypes.js';

export interface NormalizedSessionActionScope {
	readonly requestedScope: SessionActionScope;
	readonly workspaceRoot?: NormalizedPathScope;
	readonly projectRoot?: NormalizedPathScope;
	readonly repositoryPath?: NormalizedPathScope;
	readonly worktreeRoot?: NormalizedPathScope;
	readonly cwd?: NormalizedPathScope;
	readonly files: readonly NormalizedPathScope[];
	readonly hostTarget: SessionActionExecutionContext['hostTarget'];
}

export interface SessionActionScopeResolution {
	readonly scope?: NormalizedSessionActionScope;
	readonly denialReason?: SessionActionDenialReason;
	readonly message?: string;
}

export interface ISessionActionScopeService {
	readonly _serviceBrand: undefined;

	resolveScope(action: SessionAction, executionContext: SessionActionExecutionContext, providerCapabilities: ProviderCapabilitySet): SessionActionScopeResolution;
}

export const ISessionActionScopeService = createDecorator<ISessionActionScopeService>('sessionActionScopeService');
