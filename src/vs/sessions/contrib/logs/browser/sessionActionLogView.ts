/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionActionLogView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ISessionActionReceiptService, SessionActionReceipt, SessionActionReceiptScopeSummary, SessionActionReceiptStatus } from '../../../services/actions/common/sessionActionReceipts.js';
import { SessionActionKind } from '../../../services/actions/common/sessionActionTypes.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const $ = DOM.$;

export const SESSION_ACTION_LOG_VIEW_ID = 'workbench.sessions.panel.actionLog';
export const SessionActionLogFocusContext = new RawContextKey<boolean>('sessions.actionLogFocus', false, localize('sessionsActionLogFocus', "Whether the Sessions action log has keyboard focus"));
export const SessionActionLogHasReceiptsContext = new RawContextKey<boolean>('sessions.actionLogHasReceipts', false, localize('sessionsActionLogHasReceipts', "Whether the active session has action-log receipts"));

export interface ISessionActionLogDetailItem {
	readonly id: string;
	readonly label: string;
	readonly value: string;
}

interface ISessionActionLogReceiptElement {
	readonly type: 'receipt';
	readonly receipt: SessionActionReceipt;
}

interface ISessionActionLogDetailElement {
	readonly type: 'detail';
	readonly receiptId: string;
	readonly detail: ISessionActionLogDetailItem;
}

type SessionActionLogElement = ISessionActionLogReceiptElement | ISessionActionLogDetailElement;

class SessionActionLogDelegate implements IListVirtualDelegate<SessionActionLogElement> {
	getHeight(element: SessionActionLogElement): number {
		return element.type === 'receipt' ? 46 : 28;
	}

	getTemplateId(element: SessionActionLogElement): string {
		return element.type;
	}
}

interface IReceiptTemplate {
	readonly container: HTMLElement;
	readonly time: HTMLElement;
	readonly summary: HTMLElement;
	readonly meta: HTMLElement;
	readonly status: HTMLElement;
}

class SessionActionLogReceiptRenderer implements ITreeRenderer<SessionActionLogElement, void, IReceiptTemplate> {
	readonly templateId = 'receipt';

	renderTemplate(container: HTMLElement): IReceiptTemplate {
		const row = DOM.append(container, $('.session-action-log-row'));
		const time = DOM.append(row, $('.session-action-log-time'));
		const content = DOM.append(row, $('.session-action-log-content'));
		const summary = DOM.append(content, $('.session-action-log-summary'));
		const meta = DOM.append(content, $('.session-action-log-meta'));
		const status = DOM.append(row, $('.session-action-log-status'));
		return { container: row, time, summary, meta, status };
	}

	renderElement(node: ITreeNode<SessionActionLogElement, void>, _index: number, templateData: IReceiptTemplate): void {
		if (node.element.type !== 'receipt') {
			return;
		}

		const { receipt } = node.element;
		templateData.time.textContent = formatReceiptTime(receipt.requestedAt);
		templateData.summary.textContent = getReceiptSummary(receipt);
		templateData.meta.textContent = getReceiptMetadataText(receipt);
		templateData.status.textContent = formatStatus(receipt.status);
		templateData.status.className = `session-action-log-status session-action-log-${receipt.status}`;
	}

	disposeTemplate(_templateData: IReceiptTemplate): void { }
}

interface IDetailTemplate {
	readonly container: HTMLElement;
	readonly label: HTMLElement;
	readonly value: HTMLElement;
}

class SessionActionLogDetailRenderer implements ITreeRenderer<SessionActionLogElement, void, IDetailTemplate> {
	readonly templateId = 'detail';

	renderTemplate(container: HTMLElement): IDetailTemplate {
		const row = DOM.append(container, $('.session-action-log-detail-row'));
		const label = DOM.append(row, $('.session-action-log-detail-label'));
		const value = DOM.append(row, $('.session-action-log-detail-value'));
		return { container: row, label, value };
	}

	renderElement(node: ITreeNode<SessionActionLogElement, void>, _index: number, templateData: IDetailTemplate): void {
		if (node.element.type !== 'detail') {
			return;
		}

		templateData.label.textContent = node.element.detail.label;
		templateData.value.textContent = node.element.detail.value;
	}

	disposeTemplate(_templateData: IDetailTemplate): void { }
}

export class SessionActionLogView extends ViewPane {
	private treeContainer!: HTMLElement;
	private emptyElement!: HTMLElement;
	private tree: WorkbenchObjectTree<SessionActionLogElement, void> | undefined;
	private activeSessionId: string | undefined;
	private readonly focusContextKey: IContextKey<boolean>;
	private readonly hasReceiptsContextKey: IContextKey<boolean>;

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
		@ISessionActionReceiptService private readonly _receiptService: ISessionActionReceiptService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.focusContextKey = SessionActionLogFocusContext.bindTo(contextKeyService);
		this.hasReceiptsContextKey = SessionActionLogHasReceiptsContext.bindTo(contextKeyService);

		this._register(autorun(reader => {
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			this.activeSessionId = activeSession?.sessionId;
			this._refresh();
		}));

		this._register(this._receiptService.onDidAppendReceipt(entry => {
			if (entry.sessionId === this.activeSessionId) {
				this._refresh();
			}
		}));
	}

	override focus(): void {
		super.focus();
		this.tree?.domFocus();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = DOM.append(container, $('.session-action-log-view'));
		this.emptyElement = DOM.append(root, $('.session-action-log-empty'));
		this.treeContainer = DOM.append(root, $('.session-action-log-tree'));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<SessionActionLogElement, void>,
			'SessionActionLogTree',
			this.treeContainer,
			new SessionActionLogDelegate(),
			[
				new SessionActionLogReceiptRenderer(),
				new SessionActionLogDetailRenderer(),
			],
			{
				accessibilityProvider: {
					getAriaLabel: element => element.type === 'receipt'
						? localize('sessionActionLogReceiptAriaLabel', "{0}. {1}. {2} action from provider {3}.", formatStatus(element.receipt.status), element.receipt.actionKind, getReceiptSummary(element.receipt), element.receipt.providerId)
						: `${element.detail.label}: ${element.detail.value}`,
					getWidgetAriaLabel: () => localize('sessionActionLogWidgetAriaLabel', "Sessions action log"),
				},
				identityProvider: {
					getId: element => element.type === 'receipt' ? element.receipt.id : `${element.receiptId}:${element.detail.id}`,
				},
				horizontalScrolling: false,
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: element => element.type === 'receipt' ? getReceiptSummary(element.receipt) : `${element.detail.label} ${element.detail.value}`,
				},
				renderIndentGuides: RenderIndentGuides.None,
			}
		));

		this._register(this.tree.onDidFocus(() => this.focusContextKey.set(true)));
		this._register(this.tree.onDidBlur(() => this.focusContextKey.set(false)));
		this._refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		this.tree?.layout(height, width);
	}

	private _refresh(): void {
		if (!this.tree) {
			return;
		}

		const activeSession = this._sessionsManagementService.activeSession.get();
		const receipts = activeSession ? this._receiptService.getReceiptsForSession(activeSession.sessionId) : [];
		this.hasReceiptsContextKey.set(receipts.length > 0);

		if (!activeSession) {
			this.emptyElement.textContent = localize('sessionActionLogNoSession', "Select a session to inspect mediated action receipts.");
			DOM.show(this.emptyElement);
			DOM.hide(this.treeContainer);
			this.tree.setChildren(null, []);
			return;
		}

		if (receipts.length === 0) {
			this.emptyElement.textContent = localize('sessionActionLogEmpty', "No mediated actions have been recorded for the active session yet.");
			DOM.show(this.emptyElement);
			DOM.hide(this.treeContainer);
			this.tree.setChildren(null, []);
			return;
		}

		DOM.hide(this.emptyElement);
		DOM.show(this.treeContainer);
		this.tree.setChildren(null, buildTree(receipts));
	}
}

export function buildTree(receipts: readonly SessionActionReceipt[]): IObjectTreeElement<SessionActionLogElement>[] {
	return [...receipts].sort((a, b) => b.requestedAt - a.requestedAt).map(receipt => ({
		element: { type: 'receipt', receipt },
		collapsible: true,
		collapsed: true,
		children: getSessionActionLogDetailItems(receipt).map(detail => ({
			element: {
				type: 'detail',
				receiptId: receipt.id,
				detail,
			},
		})),
	}));
}

export function getSessionActionLogDetailItems(receipt: SessionActionReceipt): readonly ISessionActionLogDetailItem[] {
	const details: ISessionActionLogDetailItem[] = [];
	const pushDetail = (label: string, value: string | undefined) => {
		if (!value) {
			return;
		}

		details.push({
			id: `${details.length}`,
			label,
			value,
		});
	};

	pushDetail(localize('sessionActionLog.detail.status', "Status"), formatStatus(receipt.status));
	pushDetail(localize('sessionActionLog.detail.session', "Session"), receipt.sessionId);
	pushDetail(localize('sessionActionLog.detail.provider', "Provider"), receipt.providerId);
	pushDetail(localize('sessionActionLog.detail.host', "Host"), formatHostTarget(receipt));
	pushDetail(localize('sessionActionLog.detail.requestedScope', "Requested Scope"), formatScopeSummary(receipt.requestedScope));
	pushDetail(localize('sessionActionLog.detail.approvedScope', "Approved Scope"), formatScopeSummary(receipt.approvedScope));
	appendActionSpecificDetails(receipt, pushDetail);
	pushDetail(localize('sessionActionLog.detail.approvalSummary', "Approval Summary"), receipt.approvalSummary);
	pushDetail(localize('sessionActionLog.detail.approvalFingerprint', "Approval Fingerprint"), receipt.approvalFingerprint);
	pushDetail(localize('sessionActionLog.detail.approval', "Approval"), formatApproval(receipt));
	pushDetail(localize('sessionActionLog.detail.denialReason', "Denial Reason"), receipt.denialReason);
	pushDetail(localize('sessionActionLog.detail.denial', "Denial"), formatDenial(receipt));
	pushDetail(localize('sessionActionLog.detail.advisorySources', "Advisory Sources"), receipt.advisorySources.length > 0 ? receipt.advisorySources.join(', ') : undefined);
	pushDetail(localize('sessionActionLog.detail.error', "Error"), receipt.error?.message);
	return details;
}

export function formatSessionActionLogText(sessionLabel: string | undefined, receipts: readonly SessionActionReceipt[]): string {
	const lines: string[] = [];
	lines.push(sessionLabel
		? localize('sessionActionLogAccessibleHeader', "Action log for {0}", sessionLabel)
		: localize('sessionActionLogAccessibleHeaderNoSession', "Action log"));
	lines.push('');

	if (receipts.length === 0) {
		lines.push(localize('sessionActionLogAccessibleEmpty', "No mediated action receipts are available for the active session."));
		return lines.join('\n');
	}

	for (const receipt of [...receipts].sort((a, b) => b.requestedAt - a.requestedAt)) {
		lines.push(`${formatReceiptTime(receipt.requestedAt)} | ${formatStatus(receipt.status)} | ${receipt.actionKind} | ${receipt.providerId} | ${receipt.hostKind}`);
		lines.push(getReceiptSummary(receipt));
		for (const detail of getSessionActionLogDetailItems(receipt)) {
			lines.push(`- ${detail.label}: ${detail.value}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

function getReceiptSummary(receipt: SessionActionReceipt): string {
	return receipt.executionSummary ?? receipt.error?.message ?? localize('sessionActionLogNoSummary', "No execution summary recorded.");
}

function getReceiptMetadataText(receipt: SessionActionReceipt): string {
	return [receipt.sessionId, receipt.providerId, receipt.hostKind, receipt.actionKind].join(' | ');
}

function formatReceiptTime(requestedAt: number): string {
	return new Date(requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatStatus(status: SessionActionReceiptStatus): string {
	switch (status) {
		case SessionActionReceiptStatus.ApprovalRequired:
			return localize('sessionActionLogStatusApprovalRequired', "Approval Required");
		case SessionActionReceiptStatus.Approved:
			return localize('sessionActionLogStatusApproved', "Approved");
		case SessionActionReceiptStatus.Denied:
			return localize('sessionActionLogStatusDenied', "Denied");
		case SessionActionReceiptStatus.Executed:
			return localize('sessionActionLogStatusExecuted', "Executed");
		case SessionActionReceiptStatus.Failed:
			return localize('sessionActionLogStatusFailed', "Failed");
		default:
			return status;
	}
}

function appendActionSpecificDetails(receipt: SessionActionReceipt, pushDetail: (label: string, value: string | undefined) => void): void {
	switch (receipt.actionKind) {
		case SessionActionKind.SearchWorkspace:
			pushDetail(localize('sessionActionLog.detail.query', "Query"), receipt.query);
			pushDetail(localize('sessionActionLog.detail.includePattern', "Include Pattern"), receipt.includePattern);
			pushDetail(localize('sessionActionLog.detail.isRegexp', "Regular Expression"), formatBooleanDetail(receipt.isRegexp));
			pushDetail(localize('sessionActionLog.detail.maxResults', "Max Results"), typeof receipt.maxResults === 'number' ? String(receipt.maxResults) : undefined);
			pushDetail(localize('sessionActionLog.detail.resultCount', "Result Count"), typeof receipt.resultCount === 'number' ? String(receipt.resultCount) : undefined);
			pushDetail(localize('sessionActionLog.detail.matchCount', "Match Count"), typeof receipt.matchCount === 'number' ? String(receipt.matchCount) : undefined);
			pushDetail(localize('sessionActionLog.detail.matches', "Matches"), formatSearchMatches(receipt));
			break;
		case SessionActionKind.ReadFile:
			pushDetail(localize('sessionActionLog.detail.resource', "Resource"), receipt.resource?.toString());
			pushDetail(localize('sessionActionLog.detail.startLine', "Start Line"), typeof receipt.startLine === 'number' ? String(receipt.startLine) : undefined);
			pushDetail(localize('sessionActionLog.detail.endLine', "End Line"), typeof receipt.endLine === 'number' ? String(receipt.endLine) : undefined);
			pushDetail(localize('sessionActionLog.detail.readEncoding', "Encoding"), receipt.readEncoding);
			pushDetail(localize('sessionActionLog.detail.readByteSize', "Byte Size"), typeof receipt.readByteSize === 'number' ? String(receipt.readByteSize) : undefined);
			pushDetail(localize('sessionActionLog.detail.readLineCount', "Line Count"), typeof receipt.readLineCount === 'number' ? String(receipt.readLineCount) : undefined);
			pushDetail(localize('sessionActionLog.detail.readIsPartial', "Partial Read"), formatBooleanDetail(receipt.readIsPartial));
			pushDetail(localize('sessionActionLog.detail.readContents', "Contents"), receipt.readContents);
			break;
		case SessionActionKind.WritePatch:
			pushDetail(localize('sessionActionLog.detail.operation', "Operation"), receipt.operation);
			pushDetail(localize('sessionActionLog.detail.operationCount', "Operation Count"), typeof receipt.operationCount === 'number' ? String(receipt.operationCount) : undefined);
			pushDetail(localize('sessionActionLog.detail.filesTouched', "Touched Files"), receipt.filesTouched.length > 0 ? receipt.filesTouched.map(file => file.toString()).join('\n') : undefined);
			pushDetail(localize('sessionActionLog.detail.writeOperations', "Write Operations"), formatWriteOperations(receipt));
			break;
		case SessionActionKind.RunCommand:
			pushDetail(localize('sessionActionLog.detail.cwd', "Cwd"), receipt.cwd?.toString());
			pushDetail(localize('sessionActionLog.detail.command', "Command"), receipt.command);
			pushDetail(localize('sessionActionLog.detail.arguments', "Arguments"), receipt.args?.join('\n'));
			pushDetail(localize('sessionActionLog.detail.stdout', "Stdout"), receipt.stdout);
			pushDetail(localize('sessionActionLog.detail.stderr', "Stderr"), receipt.stderr);
			pushDetail(localize('sessionActionLog.detail.exitCode', "Exit Code"), typeof receipt.exitCode === 'number' ? String(receipt.exitCode) : undefined);
			break;
		case SessionActionKind.GitStatus:
			pushDetail(localize('sessionActionLog.detail.repository', "Repository"), receipt.repositoryPath?.toString());
			pushDetail(localize('sessionActionLog.detail.operation', "Operation"), receipt.operation);
			pushDetail(localize('sessionActionLog.detail.branch', "Branch"), receipt.branch);
			pushDetail(localize('sessionActionLog.detail.filesChanged', "Files Changed"), typeof receipt.filesChanged === 'number' ? String(receipt.filesChanged) : undefined);
			pushDetail(localize('sessionActionLog.detail.stdout', "Stdout"), receipt.stdout);
			pushDetail(localize('sessionActionLog.detail.stderr', "Stderr"), receipt.stderr);
			break;
		case SessionActionKind.GitDiff:
			pushDetail(localize('sessionActionLog.detail.repository', "Repository"), receipt.repositoryPath?.toString());
			pushDetail(localize('sessionActionLog.detail.operation', "Operation"), receipt.operation);
			pushDetail(localize('sessionActionLog.detail.ref', "Ref"), receipt.ref);
			pushDetail(localize('sessionActionLog.detail.filesChanged', "Files Changed"), typeof receipt.filesChanged === 'number' ? String(receipt.filesChanged) : undefined);
			pushDetail(localize('sessionActionLog.detail.insertions', "Insertions"), typeof receipt.insertions === 'number' ? String(receipt.insertions) : undefined);
			pushDetail(localize('sessionActionLog.detail.deletions', "Deletions"), typeof receipt.deletions === 'number' ? String(receipt.deletions) : undefined);
			pushDetail(localize('sessionActionLog.detail.gitChanges', "Changes"), formatGitChanges(receipt));
			pushDetail(localize('sessionActionLog.detail.stdout', "Stdout"), receipt.stdout);
			pushDetail(localize('sessionActionLog.detail.stderr', "Stderr"), receipt.stderr);
			break;
		case SessionActionKind.OpenWorktree:
			pushDetail(localize('sessionActionLog.detail.repository', "Repository"), receipt.repositoryPath?.toString());
			pushDetail(localize('sessionActionLog.detail.operation', "Operation"), receipt.operation);
			pushDetail(localize('sessionActionLog.detail.worktree', "Worktree"), receipt.worktreePath?.toString());
			pushDetail(localize('sessionActionLog.detail.branch', "Branch"), receipt.branch);
			pushDetail(localize('sessionActionLog.detail.stdout', "Stdout"), receipt.stdout);
			pushDetail(localize('sessionActionLog.detail.stderr', "Stderr"), receipt.stderr);
			break;
	}
}

function formatBooleanDetail(value: boolean | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	return value
		? localize('sessionActionLog.boolean.true', "Yes")
		: localize('sessionActionLog.boolean.false', "No");
}

function formatSearchMatches(receipt: SessionActionReceipt): string | undefined {
	if (!receipt.searchMatches || receipt.searchMatches.length === 0) {
		return undefined;
	}

	return receipt.searchMatches.map(match => `${match.resource.toString()}:${match.lineNumbers.join(', ')} (${match.matchCount}) ${match.preview}`).join('\n');
}

function formatWriteOperations(receipt: SessionActionReceipt): string | undefined {
	if (!receipt.writeOperations || receipt.writeOperations.length === 0) {
		return undefined;
	}

	return receipt.writeOperations.map(operation => `${operation.status} ${operation.resource.toString()}${typeof operation.bytesWritten === 'number' ? ` (${operation.bytesWritten} bytes)` : ''}${operation.error ? ` - ${operation.error}` : ''}`).join('\n');
}

function formatGitChanges(receipt: SessionActionReceipt): string | undefined {
	if (!receipt.gitChanges || receipt.gitChanges.length === 0) {
		return undefined;
	}

	return receipt.gitChanges.map(change => `${change.resource.toString()} (+${change.insertions}/-${change.deletions})`).join('\n');
}

function formatScopeSummary(scope: SessionActionReceiptScopeSummary): string | undefined {
	const parts = [
		scope.workspaceRoot ? `workspace=${scope.workspaceRoot.toString()}` : undefined,
		scope.projectRoot ? `project=${scope.projectRoot.toString()}` : undefined,
		scope.repositoryPath ? `repo=${scope.repositoryPath.toString()}` : undefined,
		scope.worktreeRoot ? `worktree=${scope.worktreeRoot.toString()}` : undefined,
		scope.cwd ? `cwd=${scope.cwd.toString()}` : undefined,
		scope.files.length > 0 ? `files=${scope.files.map(file => file.toString()).join(', ')}` : undefined,
		formatHostTargetFromScope(scope),
	].filter((value): value is string => !!value);

	return parts.length > 0 ? parts.join(' | ') : undefined;
}

function formatHostTarget(receipt: SessionActionReceipt): string {
	return [receipt.hostTarget.kind, receipt.hostTarget.providerId, receipt.hostTarget.authority].filter((value): value is string => !!value).join(' | ');
}

function formatHostTargetFromScope(scope: SessionActionReceiptScopeSummary): string | undefined {
	const values = [scope.hostTarget.kind, scope.hostTarget.providerId, scope.hostTarget.authority].filter((value): value is string => !!value);
	return values.length > 0 ? `host=${values.join(' | ')}` : undefined;
}

function formatApproval(receipt: SessionActionReceipt): string | undefined {
	if (!receipt.approval) {
		return undefined;
	}

	const parts = [receipt.approvalSummary, receipt.approvalFingerprint, receipt.approval.source].filter((value): value is string => !!value);
	return parts.join(' | ');
}

function formatDenial(receipt: SessionActionReceipt): string | undefined {
	if (!receipt.denial && !receipt.denialReason) {
		return undefined;
	}

	const parts = [receipt.denialReason ?? receipt.denial?.reason, receipt.denial?.message, receipt.denial?.blockedCommand, receipt.denial?.blockedPath?.toString()].filter((value): value is string => !!value);
	return parts.join(' | ');
}
