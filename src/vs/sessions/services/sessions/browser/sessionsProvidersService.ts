/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SessionActionKind, SessionHostKind } from '../../actions/common/sessionActionTypes.js';
import { getSessionsProviderActionCapabilityDenial, ISessionProviderActionCapabilityDenial, ISessionsProvider, ISessionsProviderCapabilities, ISessionsProviderMetadata } from '../common/sessionsProvider.js';

export const ISessionsProvidersService = createDecorator<ISessionsProvidersService>('sessionsProvidersService');

export interface ISessionsProvidersChangeEvent {
	readonly added: readonly ISessionsProvider[];
	readonly removed: readonly ISessionsProvider[];
}

export interface ISessionsProvidersService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent>;
	registerProvider(provider: ISessionsProvider): IDisposable;
	getProviders(): ISessionsProvider[];
	getProvider<T extends ISessionsProvider>(providerId: string): T | undefined;
	getProviderCapabilities(providerId: string, sessionId?: string): ISessionsProviderCapabilities | undefined;
	getActionCapabilityDenial(providerId: string, actionKind: SessionActionKind, sessionId?: string): ISessionProviderActionCapabilityDenial | undefined;
	getProviderMetadata(providerId: string, sessionId?: string): ISessionsProviderMetadata | undefined;
	resolveProviderHostKind(providerId: string, sessionId?: string): SessionHostKind | undefined;
}

class SessionsProvidersService extends Disposable implements ISessionsProvidersService {
	declare readonly _serviceBrand: undefined;

	private readonly _providers = new Map<string, ISessionsProvider>();

	private readonly _onDidChangeProviders = this._register(new Emitter<ISessionsProvidersChangeEvent>());
	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent> = this._onDidChangeProviders.event;

	registerProvider(provider: ISessionsProvider): IDisposable {
		if (this._providers.has(provider.id)) {
			throw new Error(`Sessions provider '${provider.id}' is already registered.`);
		}

		this._providers.set(provider.id, provider);
		this._onDidChangeProviders.fire({ added: [provider], removed: [] });

		return toDisposable(() => {
			const entry = this._providers.get(provider.id);
			if (entry) {
				this._providers.delete(provider.id);
				this._onDidChangeProviders.fire({ added: [], removed: [provider] });
			}
		});
	}

	getProviders(): ISessionsProvider[] {
		return Array.from(this._providers.values());
	}

	getProvider<T extends ISessionsProvider>(providerId: string): T | undefined {
		return this._providers.get(providerId) as T | undefined;
	}

	getProviderCapabilities(providerId: string, sessionId?: string): ISessionsProviderCapabilities | undefined {
		const provider = this.getProvider(providerId);
		if (!provider) {
			return undefined;
		}

		return provider.getCapabilities?.(sessionId) ?? provider.capabilities;
	}

	getActionCapabilityDenial(providerId: string, actionKind: SessionActionKind, sessionId?: string): ISessionProviderActionCapabilityDenial | undefined {
		const capabilities = this.getProviderCapabilities(providerId, sessionId);
		if (!capabilities) {
			return undefined;
		}

		return getSessionsProviderActionCapabilityDenial(actionKind, capabilities);
	}

	getProviderMetadata(providerId: string, _sessionId?: string): ISessionsProviderMetadata | undefined {
		const provider = this.getProvider(providerId);
		if (!provider) {
			return undefined;
		}

		return {
			remoteAddress: provider.remoteAddress,
			outputChannelId: provider.outputChannelId,
		};
	}

	resolveProviderHostKind(providerId: string, sessionId?: string): SessionHostKind | undefined {
		return this.getProviderCapabilities(providerId, sessionId)?.hostKind;
	}
}

registerSingleton(ISessionsProvidersService, SessionsProvidersService, InstantiationType.Delayed);
