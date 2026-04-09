/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ITaskService } from '../../../../workbench/contrib/tasks/common/taskService.js';
import { TaskRunSource } from '../../../../workbench/contrib/tasks/common/tasks.js';
import { localize } from '../../../../nls.js';
import { NormalizedSessionActionScope } from '../common/sessionActionScope.js';
import { ReadFileAction, RunCommandAction, SessionAction, SessionActionKind, SessionActionResult, SessionActionStatus, SessionCommandLaunchKind, WritePatchAction } from '../common/sessionActionTypes.js';

export interface ISessionActionExecutorBridge {
	readonly _serviceBrand: undefined;

	supports(kind: SessionActionKind): boolean;
	execute(action: SessionAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult>;
}

export const ISessionActionExecutorBridge = createDecorator<ISessionActionExecutorBridge>('sessionActionExecutorBridge');

export class SessionActionExecutorBridge implements ISessionActionExecutorBridge {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@ITaskService private readonly _taskService: ITaskService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) { }

	supports(kind: SessionActionKind): boolean {
		switch (kind) {
			case SessionActionKind.ReadFile:
			case SessionActionKind.WritePatch:
			case SessionActionKind.RunCommand:
				return true;
			default:
				return false;
		}
	}

	async execute(action: SessionAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult> {
		switch (action.kind) {
			case SessionActionKind.ReadFile:
				return this._readFile(action as ReadFileAction);
			case SessionActionKind.WritePatch:
				return this._writePatch(action as WritePatchAction);
			case SessionActionKind.RunCommand:
				return this._runCommand(action as RunCommandAction, scope);
			default:
				throw new Error(`Unsupported action kind '${action.kind}'`);
		}
	}

	private async _readFile(action: ReadFileAction): Promise<SessionActionResult> {
		const contents = await this._fileService.readFile(action.resource);
		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.ReadFile,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			resource: action.resource,
			contents: contents.value.toString(),
			summary: localize('sessionActionExecutorBridge.readFileSummary', "Read file '{0}'.", action.resource.toString()),
		};
	}

	private async _writePatch(action: WritePatchAction): Promise<SessionActionResult> {
		if (!action.operations || action.operations.length === 0) {
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.WritePatch,
				status: SessionActionStatus.Failed,
				advisorySources: action.advisorySources ?? [],
				filesTouched: action.files,
				applied: false,
				summary: localize('sessionActionExecutorBridge.writePatchUnsupported', "Could not apply the requested write because no file operations were provided."),
			};
		}

		for (const operation of action.operations) {
			if (operation.delete) {
				await this._fileService.del(operation.resource, {
					recursive: true,
					useTrash: operation.useTrash ?? true,
				});
				continue;
			}

			if (typeof operation.contents === 'string') {
				await this._fileService.writeFile(operation.resource, VSBuffer.fromString(operation.contents));
			}
		}

		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.WritePatch,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			filesTouched: action.operations.map(operation => operation.resource),
			applied: true,
			summary: localize('sessionActionExecutorBridge.writePatchSummary', "Applied file updates for {0} target(s).", action.operations.length),
		};
	}

	private async _runCommand(action: RunCommandAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult> {
		if (action.launchKind === SessionCommandLaunchKind.Task) {
			const cwd = scope.cwd?.path;
			if (!cwd) {
				return {
					actionId: action.id ?? 'unknown',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Failed,
					advisorySources: action.advisorySources ?? [],
					commandLine: action.command,
					stderrExcerpt: 'No working directory was resolved for the task run.',
					summary: localize('sessionActionExecutorBridge.taskMissingCwd', "Could not run task because no working directory was resolved."),
				};
			}

			const workspaceFolder = this._workspaceContextService.getWorkspaceFolder(cwd);
			if (!workspaceFolder) {
				return {
					actionId: action.id ?? 'unknown',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Failed,
					advisorySources: action.advisorySources ?? [],
					commandLine: action.command,
					stderrExcerpt: 'No workspace folder was found for the task run.',
					summary: localize('sessionActionExecutorBridge.taskMissingFolder', "Could not run task because no workspace folder was found for the resolved cwd."),
				};
			}

			const taskLabel = action.taskLabel ?? action.command;
			const task = await this._taskService.getTask(workspaceFolder, taskLabel);
			if (!task) {
				return {
					actionId: action.id ?? 'unknown',
					kind: SessionActionKind.RunCommand,
					status: SessionActionStatus.Failed,
					advisorySources: action.advisorySources ?? [],
					commandLine: action.command,
					stderrExcerpt: `Task '${taskLabel}' was not found.`,
					summary: localize('sessionActionExecutorBridge.taskNotFound', "Could not run task '{0}' because it was not found in the workspace folder.", taskLabel),
				};
			}

			await this._taskService.run(task, undefined, TaskRunSource.User);
			return {
				actionId: action.id ?? 'unknown',
				kind: SessionActionKind.RunCommand,
				status: SessionActionStatus.Executed,
				advisorySources: action.advisorySources ?? [],
				commandLine: action.command,
				summary: localize('sessionActionExecutorBridge.taskSummary', "Queued task '{0}' for execution.", taskLabel),
			};
		}

		const value = await this._commandService.executeCommand(action.command, ...(action.args ?? []));
		return {
			actionId: action.id ?? 'unknown',
			kind: SessionActionKind.RunCommand,
			status: SessionActionStatus.Executed,
			advisorySources: action.advisorySources ?? [],
			commandLine: this._toCommandLine(action.command, action.args),
			value: value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'object' ? value : undefined,
			summary: localize('sessionActionExecutorBridge.commandSummary', "Executed command '{0}'.", action.command),
		};
	}

	private _toCommandLine(command: string, args: readonly unknown[] | undefined): string {
		const parts = [command, ...(args ?? []).map(arg => this._formatCommandArg(arg))];
		return parts.join(' ').trim();
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

registerSingleton(ISessionActionExecutorBridge, SessionActionExecutorBridge, InstantiationType.Delayed);
