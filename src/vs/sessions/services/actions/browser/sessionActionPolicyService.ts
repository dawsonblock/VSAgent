/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { CommandRiskClass, PolicyDenialMetadata, SessionActionPolicyDecision, SessionActionPolicyInput, SessionActionPolicyMode, SessionPolicySnapshot, ScopeConstraint } from '../common/sessionActionPolicy.js';
import { ApprovalRequirement, RunCommandAction, SessionAction, SessionActionDenialReason, SessionActionExecutionContext, SessionActionKind, SessionActionRequestSource, SessionCommandLaunchKind } from '../common/sessionActionTypes.js';
import { ISessionActionPolicyConfigService } from './sessionActionPolicyConfigService.js';

export interface ISessionActionPolicyService {
	readonly _serviceBrand: undefined;

	getPolicySnapshot(executionContext: SessionActionExecutionContext, allowedRoots: readonly URI[]): Promise<SessionPolicySnapshot>;
	evaluate(input: SessionActionPolicyInput): SessionActionPolicyDecision;
}

export const ISessionActionPolicyService = createDecorator<ISessionActionPolicyService>('sessionActionPolicyService');

export class SessionActionPolicyService implements ISessionActionPolicyService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISessionActionPolicyConfigService private readonly _configService: ISessionActionPolicyConfigService,
	) { }

	getPolicySnapshot(executionContext: SessionActionExecutionContext, allowedRoots: readonly URI[]): Promise<SessionPolicySnapshot> {
		return this._configService.getPolicySnapshot(executionContext, allowedRoots);
	}

	evaluate(input: SessionActionPolicyInput): SessionActionPolicyDecision {
		const approvedScope = input.normalizedScope.requestedScope;
		const scopeConstraints = this._buildScopeConstraints(input);
		switch (input.action.kind) {
			case SessionActionKind.SearchWorkspace:
			case SessionActionKind.ReadFile:
				return this._readDecision(input, approvedScope, scopeConstraints);
			case SessionActionKind.WritePatch:
				return this._writeDecision(input, approvedScope, scopeConstraints);
			case SessionActionKind.RunCommand:
				return this._commandDecision(input, approvedScope, scopeConstraints);
			case SessionActionKind.GitStatus:
			case SessionActionKind.GitDiff:
				return this._gitReadDecision(input, approvedScope, scopeConstraints);
			case SessionActionKind.OpenWorktree:
				return this._worktreeDecision(input, approvedScope, scopeConstraints);
			default:
				return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.UnsupportedAction, 'This action kind is not supported by the Sessions action policy service.', CommandRiskClass.None);
		}
	}

	private _readDecision(input: SessionActionPolicyInput, approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[]): SessionActionPolicyDecision {
		if (!input.providerCapabilities.canReadWorkspace) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, 'The active provider cannot read from the workspace.', CommandRiskClass.ReadOnly);
		}

		if (!input.policy.allowWorkspaceReads) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, 'Workspace reads are blocked by the active Sessions policy.', CommandRiskClass.ReadOnly);
		}

		return {
			mode: SessionActionPolicyMode.Allow,
			approvalRequirement: ApprovalRequirement.None,
			approvedScope,
			commandRiskClass: CommandRiskClass.ReadOnly,
			scopeConstraints,
		};
	}

	private _writeDecision(input: SessionActionPolicyInput, approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[]): SessionActionPolicyDecision {
		if (!input.providerCapabilities.canWriteWorkspace) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, 'The active provider cannot write to the workspace.', CommandRiskClass.WorkspaceWrite);
		}

		if (!input.policy.allowWorkspaceWrites) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, 'Workspace writes are blocked by the active Sessions policy.', CommandRiskClass.WorkspaceWrite);
		}

		const approvalRequirement = input.action.requestedBy === SessionActionRequestSource.User
			? ApprovalRequirement.None
			: input.providerCapabilities.requiresApprovalForWrites ? ApprovalRequirement.Required : ApprovalRequirement.None;

		return {
			mode: approvalRequirement === ApprovalRequirement.Required ? SessionActionPolicyMode.RequireApproval : SessionActionPolicyMode.Allow,
			approvalRequirement,
			approvedScope,
			commandRiskClass: CommandRiskClass.WorkspaceWrite,
			scopeConstraints,
		};
	}

	private _commandDecision(input: SessionActionPolicyInput, approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[]): SessionActionPolicyDecision {
		if (!input.providerCapabilities.canRunCommands) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, 'The active provider cannot run commands.', CommandRiskClass.ProcessExecution);
		}

		const action = input.action as RunCommandAction;
		const riskClass = this._classifyCommandRisk(action);
		const isTask = action.launchKind === SessionCommandLaunchKind.Task;
		const isInternalCommand = this._isInternalCommand(action.command, input.policy.commandAllowPatterns);
		const commandLine = this._getCommandLine(action);

		if (input.policy.commandDenyPatterns.some(pattern => pattern.test(commandLine))) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, `The command '${action.command}' is blocked by Sessions policy.`, riskClass, action.command);
		}

		if (!this._isRiskClassAllowed(input, riskClass)) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, `The command '${action.command}' is not permitted by the active Sessions policy.`, riskClass, action.command);
		}

		if (riskClass === CommandRiskClass.GitMutation && !input.providerCapabilities.canMutateGit) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, `The active provider cannot mutate git state through Sessions command mediation.`, riskClass, action.command);
		}

		if (!isTask && !isInternalCommand && !input.providerCapabilities.canUseExternalTools) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, `The active provider cannot invoke external tools through Sessions command mediation.`, riskClass, action.command);
		}

		const requiresAllowList = action.requestedBy !== SessionActionRequestSource.User && action.launchKind !== undefined && !isTask;
		if (requiresAllowList && !isInternalCommand) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, `The command '${action.command}' is not in the Sessions command allowlist.`, riskClass, action.command);
		}

		const approvalRequired = this._requiresCommandApproval(action, riskClass, isTask, isInternalCommand, input);
		return {
			mode: approvalRequired ? SessionActionPolicyMode.RequireApproval : SessionActionPolicyMode.Allow,
			approvalRequirement: approvalRequired ? ApprovalRequirement.Required : ApprovalRequirement.None,
			approvedScope,
			commandRiskClass: riskClass,
			scopeConstraints,
		};
	}

	private _gitReadDecision(input: SessionActionPolicyInput, approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[]): SessionActionPolicyDecision {
		if (!input.providerCapabilities.canMutateGit) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, 'The active provider cannot inspect or mutate git state through Sessions mediation.', CommandRiskClass.GitMutation);
		}

		if (!input.policy.allowGitMutation) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, 'Git inspection and mutation are blocked by the active Sessions policy.', CommandRiskClass.GitMutation);
		}

		return {
			mode: SessionActionPolicyMode.Allow,
			approvalRequirement: ApprovalRequirement.None,
			approvedScope,
			commandRiskClass: CommandRiskClass.GitMutation,
			scopeConstraints,
		};
	}

	private _worktreeDecision(input: SessionActionPolicyInput, approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[]): SessionActionPolicyDecision {
		if (!input.providerCapabilities.canOpenWorktrees) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.ProviderCapabilityMissing, 'The active provider cannot open worktrees through Sessions mediation.', CommandRiskClass.GitMutation);
		}

		if (!input.policy.allowWorktreeMutation) {
			return this._deny(approvedScope, scopeConstraints, SessionActionDenialReason.PolicyDenied, 'Worktree mutation is blocked by the active Sessions policy.', CommandRiskClass.GitMutation);
		}

		const approvalRequired = input.providerCapabilities.requiresApprovalForWorktreeActions || input.action.requestedBy !== SessionActionRequestSource.User;
		return {
			mode: approvalRequired ? SessionActionPolicyMode.RequireApproval : SessionActionPolicyMode.Allow,
			approvalRequirement: approvalRequired ? ApprovalRequirement.Required : ApprovalRequirement.None,
			approvedScope,
			commandRiskClass: CommandRiskClass.GitMutation,
			scopeConstraints,
		};
	}

	private _classifyCommandRisk(action: SessionAction & { readonly kind: SessionActionKind.RunCommand }): CommandRiskClass {
		if (action.command.startsWith('_git.') || action.command.startsWith('github.copilot.cli.sessions.commitTo')) {
			return CommandRiskClass.GitMutation;
		}

		if (action.command.startsWith('_sessions.') || action.command.startsWith('github.copilot.cli.sessions.')) {
			return CommandRiskClass.WorkspaceWrite;
		}

		return CommandRiskClass.ProcessExecution;
	}

	private _requiresCommandApproval(action: RunCommandAction, riskClass: CommandRiskClass, isTask: boolean, isInternalCommand: boolean, input: SessionActionPolicyInput): boolean {
		if (riskClass === CommandRiskClass.GitMutation) {
			return input.providerCapabilities.requiresApprovalForGit || input.policy.approvalMode === 'always';
		}

		if (action.requestedBy !== SessionActionRequestSource.User) {
			return input.providerCapabilities.requiresApprovalForCommands || riskClass !== CommandRiskClass.None || input.policy.approvalMode === 'always';
		}

		if (!isTask && !isInternalCommand) {
			return input.providerCapabilities.requiresApprovalForCommands || input.policy.approvalMode === 'always';
		}

		return false;
	}

	private _isRiskClassAllowed(input: SessionActionPolicyInput, riskClass: CommandRiskClass): boolean {
		switch (riskClass) {
			case CommandRiskClass.ReadOnly:
				return input.policy.allowWorkspaceReads;
			case CommandRiskClass.WorkspaceWrite:
				return input.policy.allowWorkspaceWrites;
			case CommandRiskClass.GitMutation:
				return input.policy.allowGitMutation;
			case CommandRiskClass.ProcessExecution:
				return input.policy.allowCommands;
			case CommandRiskClass.None:
			default:
				return true;
		}
	}

	private _isInternalCommand(command: string, allowPatterns: readonly RegExp[]): boolean {
		return allowPatterns.some(pattern => pattern.test(command));
	}

	private _getCommandLine(action: RunCommandAction): string {
		return [action.command, ...(action.args ?? []).map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))].join(' ').trim();
	}

	private _buildScopeConstraints(input: SessionActionPolicyInput): ScopeConstraint[] {
		const constraints: ScopeConstraint[] = [];
		const pushConstraint = (kind: ScopeConstraint['kind'], values: readonly URI[] | undefined) => {
			if (values && values.length > 0) {
				constraints.push({ kind, paths: values });
			}
		};

		pushConstraint('workspaceRoot', input.normalizedScope.workspaceRoot ? [input.normalizedScope.workspaceRoot.path] : undefined);
		pushConstraint('projectRoot', input.normalizedScope.projectRoot ? [input.normalizedScope.projectRoot.path] : undefined);
		pushConstraint('repositoryPath', input.normalizedScope.repositoryPath ? [input.normalizedScope.repositoryPath.path] : undefined);
		pushConstraint('worktreeRoot', input.normalizedScope.worktreeRoot ? [input.normalizedScope.worktreeRoot.path] : undefined);
		pushConstraint('cwd', input.normalizedScope.cwd ? [input.normalizedScope.cwd.path] : undefined);
		pushConstraint('files', input.normalizedScope.files.map(file => file.path));
		return constraints;
	}

	private _deny(approvedScope: SessionActionPolicyDecision['approvedScope'], scopeConstraints: readonly ScopeConstraint[], denialReason: SessionActionDenialReason, message: string, commandRiskClass: CommandRiskClass, blockedCommand?: string): SessionActionPolicyDecision {
		const denialMetadata: PolicyDenialMetadata = {
			reason: denialReason,
			message,
			blockedCommand,
		};

		return {
			mode: SessionActionPolicyMode.Deny,
			denialReason,
			approvalRequirement: ApprovalRequirement.None,
			approvedScope,
			commandRiskClass,
			scopeConstraints,
			denialMetadata,
		};
	}
}

registerSingleton(ISessionActionPolicyService, SessionActionPolicyService, InstantiationType.Delayed);
