/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionAutonomyViews.css';
import * as DOM from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { formatSessionAutonomyStatusText } from './sessionAutonomyViewContent.js';

const $ = DOM.$;

export const SESSION_AUTONOMY_STATUS_VIEW_ID = 'workbench.sessions.panel.autonomyStatus';
export const SessionAutonomyStatusFocusContext = new RawContextKey<boolean>('sessions.autonomyStatusFocus', false, localize('sessionsAutonomyStatusFocus', "Whether the Sessions autonomy status view has keyboard focus"));

export class SessionAutonomyStatusView extends ViewPane {
	private emptyElement!: HTMLElement;
	private contentElement!: HTMLElement;
	private readonly focusContextKey: IContextKey<boolean>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.focusContextKey = SessionAutonomyStatusFocusContext.bindTo(contextKeyService);

		this._register(autorun(reader => {
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			activeSession?.title.read(reader);
			this._sessionsManagementService.activeAdvisoryExecutionState.read(reader);
			this._sessionsManagementService.activeAdvisoryExecutionSummary.read(reader);
			this._refresh();
		}));
	}

	override focus(): void {
		super.focus();
		this.contentElement?.focus();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = DOM.append(container, $('.session-autonomy-view'));
		this.emptyElement = DOM.append(root, $('.session-autonomy-empty'));
		this.contentElement = DOM.append(root, $('.session-autonomy-content'));
		this.contentElement.tabIndex = 0;
		this.contentElement.setAttribute('role', 'document');
		this.contentElement.setAttribute('aria-label', localize('sessionsAutonomyStatusAria', "Sessions autonomy status"));
		this._register(DOM.addDisposableListener(this.contentElement, 'focus', () => this.focusContextKey.set(true)));
		this._register(DOM.addDisposableListener(this.contentElement, 'blur', () => this.focusContextKey.set(false)));
		this._refresh();
	}

	private _refresh(): void {
		if (!this.contentElement) {
			return;
		}

		const activeSession = this._sessionsManagementService.activeSession.get();
		if (!activeSession) {
			this.emptyElement.textContent = localize('sessionsAutonomyStatusNoSession', "Select a session to inspect advisory execution status.");
			DOM.show(this.emptyElement);
			DOM.hide(this.contentElement);
			this.contentElement.textContent = '';
			return;
		}

		DOM.hide(this.emptyElement);
		DOM.show(this.contentElement);
		this.contentElement.textContent = formatSessionAutonomyStatusText(activeSession.title.get(), this._sessionsManagementService.activeAdvisoryExecutionState.get(), this._sessionsManagementService.activeAdvisoryExecutionSummary.get());
	}
}
