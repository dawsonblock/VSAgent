/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry, IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IViewsRegistry, IViewContainersRegistry, Extensions as ViewContainerExtensions, ViewContainerLocation, WindowVisibility } from '../../../../workbench/common/views.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { AccessibilityVerbositySettingId } from '../../../../workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SESSION_AUTONOMY_STATUS_VIEW_ID, SessionAutonomyStatusFocusContext, SessionAutonomyStatusView } from './sessionAutonomyStatusView.js';
import { SESSION_ADVISORY_PLAN_VIEW_ID, SessionAdvisoryPlanFocusContext, SessionPlanView } from './sessionPlanView.js';
import { SESSION_EXECUTION_SUMMARY_VIEW_ID, SessionExecutionSummaryFocusContext, SessionExecutionSummaryView } from './sessionExecutionSummaryView.js';
import { formatSessionAutonomyStatusText, formatSessionExecutionSummaryText, formatSessionPlanText } from './sessionAutonomyViewContent.js';

export const SESSIONS_AUTONOMY_CONTAINER_ID = 'workbench.sessions.panel.autonomyContainer';

const autonomyContainerIcon = registerIcon('sessions-autonomy-container-icon', Codicon.pulse, localize('sessionsAutonomyContainerIcon', 'View icon for advisory autonomy in the Sessions window.'));
const statusViewIcon = registerIcon('sessions-autonomy-status-view-icon', Codicon.info, localize('sessionsAutonomyStatusViewIcon', 'View icon for advisory autonomy status.'));
const planViewIcon = registerIcon('sessions-autonomy-plan-view-icon', Codicon.listOrdered, localize('sessionsAutonomyPlanViewIcon', 'View icon for advisory autonomy plans.'));
const summaryViewIcon = registerIcon('sessions-autonomy-summary-view-icon', Codicon.note, localize('sessionsAutonomySummaryViewIcon', 'View icon for advisory autonomy summaries.'));

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
const autonomyContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_AUTONOMY_CONTAINER_ID,
	title: localize2('sessionsAutonomy', 'Autonomy'),
	icon: autonomyContainerIcon,
	order: 3,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_AUTONOMY_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: SESSIONS_AUTONOMY_CONTAINER_ID,
	hideIfEmpty: true,
	windowVisibility: WindowVisibility.Sessions,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

viewsRegistry.registerViews([
	{
		id: SESSION_AUTONOMY_STATUS_VIEW_ID,
		name: localize2('sessionsAutonomyStatus', 'Status'),
		containerIcon: statusViewIcon,
		ctorDescriptor: new SyncDescriptor(SessionAutonomyStatusView),
		canToggleVisibility: true,
		canMoveView: false,
		order: 1,
		weight: 100,
		windowVisibility: WindowVisibility.Sessions,
	},
	{
		id: SESSION_ADVISORY_PLAN_VIEW_ID,
		name: localize2('sessionsAdvisoryPlan', 'Plan'),
		containerIcon: planViewIcon,
		ctorDescriptor: new SyncDescriptor(SessionPlanView),
		canToggleVisibility: true,
		canMoveView: false,
		order: 2,
		weight: 90,
		windowVisibility: WindowVisibility.Sessions,
	},
	{
		id: SESSION_EXECUTION_SUMMARY_VIEW_ID,
		name: localize2('sessionsExecutionSummary', 'Summary'),
		containerIcon: summaryViewIcon,
		ctorDescriptor: new SyncDescriptor(SessionExecutionSummaryView),
		canToggleVisibility: true,
		canMoveView: false,
		order: 3,
		weight: 80,
		windowVisibility: WindowVisibility.Sessions,
	},
], autonomyContainer);

class SessionsAutonomyStatusAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsAutonomyStatusHelp';
	readonly type = AccessibleViewType.Help;
	readonly when = SessionAutonomyStatusFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const content = [
			localize('sessionsAutonomyStatusHelp.intro', "You are in the Sessions autonomy status view. The view shows the current advisory execution phase for the active session."),
			localize('sessionsAutonomyStatusHelp.progress', "The status view reports progress, the most recent step, stop reasons, and the latest recorded issue when one exists."),
			localize('sessionsAutonomyStatusHelp.accessibleView', "Open the focused status view in the Accessible View when you need the same information as plain text."),
		].join('\n');

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsAutonomyStatusHelp,
			{ type: AccessibleViewType.Help },
			() => content,
			() => viewsService.getActiveViewWithId<SessionAutonomyStatusView>(SESSION_AUTONOMY_STATUS_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

class SessionsAutonomyStatusAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsAutonomyStatus';
	readonly type = AccessibleViewType.View;
	readonly when = SessionAutonomyStatusFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const activeSession = sessionsManagementService.activeSession.get();
		if (!activeSession) {
			return undefined;
		}

		const entry = sessionsManagementService.activeAdvisoryExecutionState.get();
		if (!entry) {
			return undefined;
		}

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsAutonomyStatus,
			{ type: AccessibleViewType.View },
			() => {
				const currentActiveSession = sessionsManagementService.activeSession.get();
				const currentEntry = sessionsManagementService.activeAdvisoryExecutionState.get();
				const currentSummary = sessionsManagementService.activeAdvisoryExecutionSummary.get();

				if (!currentActiveSession || !currentEntry) {
					return localize('sessionsAutonomyStatus.empty', "No active advisory execution status is available.");
				}

				return formatSessionAutonomyStatusText(currentActiveSession.title.get(), currentEntry, currentSummary);
			},
			() => viewsService.getActiveViewWithId<SessionAutonomyStatusView>(SESSION_AUTONOMY_STATUS_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

class SessionsAdvisoryPlanAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsAdvisoryPlanHelp';
	readonly type = AccessibleViewType.Help;
	readonly when = SessionAdvisoryPlanFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const content = [
			localize('sessionsAdvisoryPlanHelp.intro', "You are in the Sessions advisory plan view. The view lists the current advisory steps for the active session."),
			localize('sessionsAdvisoryPlanHelp.details', "Each step includes its action kind, dependencies, and risk labels when those details are available."),
			localize('sessionsAdvisoryPlanHelp.accessibleView', "Open the focused plan view in the Accessible View when you need the plan as plain text."),
		].join('\n');

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsAdvisoryPlanHelp,
			{ type: AccessibleViewType.Help },
			() => content,
			() => viewsService.getActiveViewWithId<SessionPlanView>(SESSION_ADVISORY_PLAN_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

class SessionsAdvisoryPlanAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsAdvisoryPlan';
	readonly type = AccessibleViewType.View;
	readonly when = SessionAdvisoryPlanFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const activeSession = sessionsManagementService.activeSession.get();
		const plan = sessionsManagementService.activeAdvisoryPlan.get();
		if (!activeSession || !plan) {
			return undefined;
		}

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsAdvisoryPlan,
			{ type: AccessibleViewType.View },
			() => formatSessionPlanText(activeSession.title.get(), plan),
			() => viewsService.getActiveViewWithId<SessionPlanView>(SESSION_ADVISORY_PLAN_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

class SessionsExecutionSummaryAccessibilityHelp implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsExecutionSummaryHelp';
	readonly type = AccessibleViewType.Help;
	readonly when = SessionExecutionSummaryFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const content = [
			localize('sessionsExecutionSummaryHelp.intro', "You are in the Sessions execution summary view. The view shows the latest advisory summary for the active session."),
			localize('sessionsExecutionSummaryHelp.detail', "The summary view surfaces the current headline, progress label, and issue count when the advisory runtime recorded them."),
			localize('sessionsExecutionSummaryHelp.accessibleView', "Open the focused summary view in the Accessible View when you need a plain-text version."),
		].join('\n');

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsExecutionSummaryHelp,
			{ type: AccessibleViewType.Help },
			() => content,
			() => viewsService.getActiveViewWithId<SessionExecutionSummaryView>(SESSION_EXECUTION_SUMMARY_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

class SessionsExecutionSummaryAccessibleView implements IAccessibleViewImplementation {
	readonly priority = 110;
	readonly name = 'sessionsExecutionSummary';
	readonly type = AccessibleViewType.View;
	readonly when = SessionExecutionSummaryFocusContext;

	getProvider(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const activeSession = sessionsManagementService.activeSession.get();
		const summary = sessionsManagementService.activeAdvisoryExecutionSummary.get();
		if (!activeSession || !summary) {
			return undefined;
		}

		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsExecutionSummary,
			{ type: AccessibleViewType.View },
			() => formatSessionExecutionSummaryText(activeSession.title.get(), summary),
			() => viewsService.getActiveViewWithId<SessionExecutionSummaryView>(SESSION_EXECUTION_SUMMARY_VIEW_ID)?.focus(),
			AccessibilityVerbositySettingId.SessionsAutonomy,
		);
	}
}

AccessibleViewRegistry.register(new SessionsAutonomyStatusAccessibilityHelp());
AccessibleViewRegistry.register(new SessionsAutonomyStatusAccessibleView());
AccessibleViewRegistry.register(new SessionsAdvisoryPlanAccessibilityHelp());
AccessibleViewRegistry.register(new SessionsAdvisoryPlanAccessibleView());
AccessibleViewRegistry.register(new SessionsExecutionSummaryAccessibilityHelp());
AccessibleViewRegistry.register(new SessionsExecutionSummaryAccessibleView());
