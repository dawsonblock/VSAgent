/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

function toRepoPath(filePath) {
	return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function readText(relativePath) {
	return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function walk(relativePath) {
	const absolutePath = path.join(repoRoot, relativePath);
	const stat = fs.statSync(absolutePath);
	if (stat.isFile()) {
		return [absolutePath];
	}

	const results = [];
	for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
		const childPath = path.join(absolutePath, entry.name);
		if (entry.isDirectory()) {
			results.push(...walk(path.relative(repoRoot, childPath)));
		} else {
			results.push(childPath);
		}
	}
	return results;
}

function assertNoPattern(relativePath, pattern, message) {
	const text = readText(relativePath);
	if (pattern.test(text)) {
		failures.push(`${relativePath}: ${message}`);
	}
}

function assertNoPatternsInFiles(files, patterns) {
	for (const file of files) {
		const relativePath = toRepoPath(file);
		const text = fs.readFileSync(file, 'utf8');
		for (const { pattern, message } of patterns) {
			if (pattern.test(text)) {
				failures.push(`${relativePath}: ${message}`);
			}
		}
	}
}

function extractMethodBody(source, signature) {
	const start = source.indexOf(signature);
	if (start < 0) {
		return undefined;
	}

	const braceStart = source.indexOf('{', start);
	if (braceStart < 0) {
		return undefined;
	}

	let depth = 0;
	for (let index = braceStart; index < source.length; index++) {
		const ch = source[index];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return source.slice(braceStart + 1, index);
			}
		}
	}

	return undefined;
}

function assertMethodDoesNotContain(relativePath, signature, patterns, contextLabel) {
	const source = readText(relativePath);
	const body = extractMethodBody(source, signature);
	if (body === undefined) {
		failures.push(`${relativePath}: could not locate ${contextLabel} method '${signature}'.`);
		return;
	}

	for (const { pattern, message } of patterns) {
		if (pattern.test(body)) {
			failures.push(`${relativePath}: ${contextLabel} must stay mediated. ${message}`);
		}
	}
}

function assertMethodContainsAll(relativePath, signature, requiredSnippets, contextLabel) {
	const source = readText(relativePath);
	const body = extractMethodBody(source, signature);
	if (body === undefined) {
		failures.push(`${relativePath}: could not locate ${contextLabel} method '${signature}'.`);
		return;
	}

	for (const snippet of requiredSnippets) {
		if (!body.includes(snippet)) {
			failures.push(`${relativePath}: ${contextLabel} is missing required coverage for '${snippet}'.`);
		}
	}
}

const actionBrowserFiles = walk('src/vs/sessions/services/actions/browser')
	.filter(file => /\.(ts|mts|js)$/.test(file))
	.filter(file => !file.endsWith('sessionActionExecutorBridge.ts'));

assertNoPatternsInFiles(actionBrowserFiles, [
	{ pattern: /\.(executeCommand|writeFile|createFile|del)\(/, message: 'direct command or file mutation is only allowed inside sessionActionExecutorBridge.ts' },
	{ pattern: /child_process|\b(?:exec|spawn|fork|execFile)\s*\(/, message: 'process execution is only allowed inside sessionActionExecutorBridge.ts' },
	{ pattern: /\.openRepository\(/, message: 'git repository inspection is only allowed inside sessionActionExecutorBridge.ts' },
	{ pattern: /\.diffBetweenWithStats2?\(/, message: 'git diff inspection is only allowed inside sessionActionExecutorBridge.ts' },
]);

assertNoPattern(
	'src/vs/sessions/contrib/chat/browser/promptsService.ts',
	/sessionActionPolicy|sessionsProvider|sessionActionService|submitAction\(|approveAction\(/i,
	'promptsService must remain advisory and must not import policy, provider capability, or execution modules.'
);

assertNoPattern(
	'src/vs/sessions/contrib/chat/browser/promptsService.ts',
	/canReadWorkspace|canWriteWorkspace|canRunCommands|canMutateGit|canOpenWorktrees/,
	'promptsService must not inspect provider capability flags directly.'
);

const workbenchBoundaryFiles = [
	...walk('src/vs/workbench/contrib/chat/browser/agentSessions').filter(file => /\.(ts|mts|js)$/.test(file)),
	path.join(repoRoot, 'src/vs/workbench/contrib/chat/browser/chatSlashCommands.ts'),
	path.join(repoRoot, 'src/vs/workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.ts'),
].filter(file => !file.endsWith('agentSessionsService.ts'));

assertNoPatternsInFiles(workbenchBoundaryFiles, [
	{ pattern: /\.setChatSessionTitle\(/, message: 'rename must route through AgentSessionsService.' },
	{ pattern: /\.removeHistoryEntry\(/, message: 'delete must route through AgentSessionsService.' },
]);

const copilotProviderPath = 'src/vs/sessions/contrib/copilotChatSessions/browser/copilotChatSessionsProvider.ts';
const directRenameDeletePatterns = [
	{ pattern: /github\.copilot\.cli\.sessions\.delete/, message: 'direct Copilot CLI delete calls are only allowed in *Direct methods.' },
	{ pattern: /github\.copilot\.cli\.sessions\.setTitle/, message: 'direct Copilot CLI rename calls are only allowed in *Direct methods.' },
	{ pattern: /\.removeHistoryEntry\(/, message: 'direct chat-history deletion is only allowed in *Direct methods.' },
	{ pattern: /\.setChatSessionTitle\(/, message: 'direct chat-title mutation is only allowed in *Direct methods.' },
];

assertMethodDoesNotContain(copilotProviderPath, 'async deleteSession(', directRenameDeletePatterns, 'public Copilot provider mutation');
assertMethodDoesNotContain(copilotProviderPath, 'async deleteChat(', directRenameDeletePatterns, 'public Copilot provider mutation');
assertMethodDoesNotContain(copilotProviderPath, 'async renameChat(', directRenameDeletePatterns, 'public Copilot provider mutation');

const executorPath = 'src/vs/sessions/services/actions/browser/sessionActionExecutorBridge.ts';
const requiredExecutorKinds = [
	'SessionActionKind.SearchWorkspace',
	'SessionActionKind.ReadFile',
	'SessionActionKind.WritePatch',
	'SessionActionKind.RunCommand',
	'SessionActionKind.GitStatus',
	'SessionActionKind.GitDiff',
	'SessionActionKind.OpenWorktree',
];

assertMethodContainsAll(executorPath, 'supports(kind: SessionActionKind): boolean', requiredExecutorKinds, 'executor supports');
assertMethodContainsAll(executorPath, 'async execute(action: SessionAction, scope: NormalizedSessionActionScope): Promise<SessionActionResult>', requiredExecutorKinds, 'executor dispatch');

if (failures.length > 0) {
	console.error('VSAgent architecture guard failed:\n');
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exitCode = 1;
} else {
	console.log('VSAgent architecture guard passed.');
}
