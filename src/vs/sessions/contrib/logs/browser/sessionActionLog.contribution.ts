/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IViewsRegistry, IViewContainersRegistry, Extensions as ViewContainerExtensions, WindowVisibility } from '../../../../workbench/common/views.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibleContentProvider } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry, IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionActionReceiptService } from '../../../services/actions/common/sessionActionReceipts.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SESSIONS_LOGS_CONTAINER_ID } from './logs.contribution.js';
import { formatSessionActionLogText, SessionActionLogFocusContext, SESSION_ACTION_LOG_VIEW_ID, SessionActionLogView } from './sessionActionLogView.js';

const actionLogViewIcon = registerIcon('sessions-action-log-view-icon', Codicon.history, localize('sessionsActionLogViewIcon', 'View icon for the Sessions action log.'));

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
const logsContainer = viewContainerRegistry.get(SESSIONS_LOGS_CONTAINER_ID);

if (logsContainer) {
	viewsRegistry.registerViews([{
		id: SESSION_ACTION_LOG_VIEW_ID,
		name: localize2('sessionsActionLog', 'Action Log'),
		containerIcon: actionLogViewIcon,
		ctorDescriptor: new SyncDescriptor(SessionActionLogView),
		canToggleVisibility: true,
		canMoveView: false,
		order: 2,
		weight: 90,
		windowVisibility: WindowVisibility.Sessions,
	}], logsContainer);
}

class SessionsActionLogAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsActionLogHelp';
	readonly type = AccessibleViewType.Help;
	readonly when = SessionActionLogFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const content = [
			localize('sessionsActionLog.help.intro', "You are in the Sessions action log. The view shows mediated action receipts for the active session."),
			localize('sessionsActionLog.help.navigation', "Use the up and down arrow keys to move between receipts. Use the left and right arrow keys to collapse or expand receipt details."),
			localize('sessionsActionLog.help.scope', "Expanded details include approval, denial, scope, file targets, output excerpts, and advisory sources when they are available."),
			localize('sessionsActionLog.help.accessibleView', "Open the focused action log in the Accessible View with the standard Accessible View command when you need a plain-text summary."),
		].join('\n');

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsActionLogHelp,
			{ type: AccessibleViewType.Help },
			() => content,
			() => {
				viewsService.getActiveViewWithId<SessionActionLogView>(SESSION_ACTION_LOG_VIEW_ID)?.focus();
			},
			AccessibilityVerbositySettingId.SessionsActionLog,
		);
	}
}

class SessionsActionLogAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsActionLog';
	readonly type = AccessibleViewType.View;
	readonly when = SessionActionLogFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const receiptService = accessor.get(ISessionActionReceiptService);
		const activeSession = sessionsManagementService.activeSession.get();
		if (!activeSession) {
			return undefined;
		}

		const receipts = receiptService.getReceiptsForSession(activeSession.sessionId);
		if (receipts.length === 0) {
			return undefined;
		}

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsActionLog,
			{ type: AccessibleViewType.View },
			() => formatSessionActionLogText(activeSession.title.get(), receipts),
			() => {
				viewsService.getActiveViewWithId<SessionActionLogView>(SESSION_ACTION_LOG_VIEW_ID)?.focus();
			},
			AccessibilityVerbositySettingId.SessionsActionLog,
		);
	}
}

AccessibleViewRegistry.register(new SessionsActionLogAccessibilityHelp());
AccessibleViewRegistry.register(new SessionsActionLogAccessibleView());
