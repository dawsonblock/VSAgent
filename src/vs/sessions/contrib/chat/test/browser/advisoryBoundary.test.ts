/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { AgenticPromptsService } from '../../browser/promptsService.js';

suite('AgenticPromptsServiceAdvisoryBoundary', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prompts remain advisory and disconnected from policy, capabilities, and execution services', () => {
		const members = new Set(Object.getOwnPropertyNames(AgenticPromptsService.prototype));

		assert.strictEqual(Object.getPrototypeOf(AgenticPromptsService), PromptsService);
		assert.ok(!members.has('submitAction'));
		assert.ok(!members.has('approveAction'));
		assert.ok(!members.has('getPolicySnapshot'));
		assert.ok(!members.has('evaluate'));
		assert.deepStrictEqual([...members].filter(name => !['constructor', 'createPromptFilesLocator', 'findAgentSkills', 'listPromptFiles', 'listPromptFilesForStorage', 'getSourceFolders', 'getBuiltinSkills', 'discoverBuiltinSkills', 'getBuiltinSkillPaths', 'getCopilotRoot'].includes(name)).sort(), []);
	});
});
