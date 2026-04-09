/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { ProviderCapabilitySet, SessionActionPolicyDecision } from '../common/sessionActionPolicy.js';
import { SessionActionApprovalReceipt } from '../common/sessionActionReceipts.js';
import { ApprovalRequirement, RunCommandAction, SessionAction, SessionActionKind, WritePatchAction } from '../common/sessionActionTypes.js';

export interface SessionActionApprovalDecision {
	readonly approved: boolean;
	readonly approval: SessionActionApprovalReceipt;
}

export interface ISessionActionApprovalService {
	readonly _serviceBrand: undefined;

	requestApproval(action: SessionAction, policyDecision: SessionActionPolicyDecision, providerCapabilities: ProviderCapabilitySet): Promise<SessionActionApprovalDecision>;
}

export const ISessionActionApprovalService = createDecorator<ISessionActionApprovalService>('sessionActionApprovalService');

export class SessionActionApprovalService implements ISessionActionApprovalService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IDialogService private readonly _dialogService: IDialogService,
	) { }

	async requestApproval(action: SessionAction, policyDecision: SessionActionPolicyDecision, providerCapabilities: ProviderCapabilitySet): Promise<SessionActionApprovalDecision> {
		if (policyDecision.approvalRequirement !== ApprovalRequirement.Required) {
			return {
				approved: true,
				approval: {
					required: false,
					granted: true,
					source: 'implicit',
					summary: 'No additional approval was required for this action.',
					fingerprint: `${action.kind}:${action.id ?? 'pending'}`,
				},
			};
		}

		const summary = this._summarize(action, providerCapabilities);
		const result = await this._dialogService.confirm({
			message: localize('sessionActionApproval.message', "Allow Sessions Action"),
			detail: summary,
			primaryButton: localize('sessionActionApproval.allow', "Allow"),
			cancelButton: localize('sessionActionApproval.deny', "Deny"),
		});

		return {
			approved: result.confirmed,
			approval: {
				required: true,
				granted: result.confirmed,
				source: 'dialog',
				summary,
				fingerprint: `${action.kind}:${action.id ?? 'pending'}`,
			},
		};
	}

	private _summarize(action: SessionAction, providerCapabilities: ProviderCapabilitySet): string {
		switch (action.kind) {
			case SessionActionKind.RunCommand: {
				const commandAction = action as RunCommandAction;
				const args = commandAction.args?.map(arg => this._formatCommandArg(arg)).join(' ') ?? '';
				const cwd = commandAction.cwd?.toString() ?? 'default cwd';
				return localize('sessionActionApproval.runCommandSummary', "Provider: {0}\nHost: {1}\nCommand: {2} {3}\nCwd: {4}", providerCapabilities.hostKind, providerCapabilities.hostKind, commandAction.command, args, cwd);
			}
			case SessionActionKind.WritePatch: {
				const writeAction = action as WritePatchAction;
				return localize('sessionActionApproval.writePatchSummary', "Provider: {0}\nHost: {1}\nFiles: {2}", providerCapabilities.hostKind, providerCapabilities.hostKind, writeAction.files.map(file => file.toString()).join('\n'));
			}
			default:
				return localize('sessionActionApproval.defaultSummary', "Provider: {0}\nAction: {1}", providerCapabilities.hostKind, action.kind);
		}
	}

	private _formatCommandArg(arg: unknown): string {
		if (typeof arg === 'string') {
			return arg;
		}

		if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null || arg === undefined) {
			return String(arg);
		}

		if (URI.isUri(arg)) {
			return arg.toString();
		}

		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}
}

registerSingleton(ISessionActionApprovalService, SessionActionApprovalService, InstantiationType.Delayed);
