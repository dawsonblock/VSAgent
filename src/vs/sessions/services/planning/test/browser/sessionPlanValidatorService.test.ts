/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { getDefaultSessionPolicySnapshot, ISessionActionPolicyConfigService } from '../../../actions/browser/sessionActionPolicyConfigService.js';
import { ISessionActionPolicyService, SessionActionPolicyService } from '../../../actions/browser/sessionActionPolicyService.js';
import { SessionActionScopeService } from '../../../actions/browser/sessionActionScopeService.js';
import { ProviderCapabilitySet, SessionPolicySnapshot } from '../../../actions/common/sessionActionPolicy.js';
import { SessionActionExecutionContext, SessionActionKind, SessionActionRequestSource, SessionHostKind } from '../../../actions/common/sessionActionTypes.js';
import { SessionPlanningService } from '../../browser/sessionPlanningService.js';
import { SessionPlanValidatorService } from '../../browser/sessionPlanValidatorService.js';
import { SessionPlanCheckpointRequirement, SessionPlanRiskClass, SessionPlanStepKind } from '../../common/sessionPlanTypes.js';
import { SessionPlanValidationIssueCode } from '../../common/sessionPlanValidatorService.js';

suite('SessionPlanValidatorService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite() as Pick<DisposableStore, 'add'>;

	const workspaceRoot = URI.file('/workspace');
	const repositoryRoot = URI.file('/workspace/repo');
	const hostTarget = {
		kind: SessionHostKind.Local,
		providerId: 'provider-1',
	};

	function createProviderCapabilities(overrides?: Partial<ProviderCapabilitySet>): ProviderCapabilitySet {
		return {
			multipleChatsPerSession: false,
			hostKind: SessionHostKind.Local,
			canReadWorkspace: true,
			canWriteWorkspace: true,
			canRunCommands: true,
			canMutateGit: true,
			canOpenWorktrees: false,
			canUseExternalTools: true,
			requiresApprovalForWrites: true,
			requiresApprovalForCommands: true,
			requiresApprovalForGit: true,
			requiresApprovalForWorktreeActions: true,
			supportsStructuredApprovals: true,
			supportsReceiptMetadata: true,
			...overrides,
		};
	}

	function createExecutionContext(): SessionActionExecutionContext {
		return {
			sessionId: 'session-1',
			providerId: 'provider-1',
			sessionResource: URI.parse('session-plan:/session-1'),
			workspaceRoot,
			projectRoot: repositoryRoot,
			repositoryPath: repositoryRoot,
			worktreeRoot: repositoryRoot,
			hostTarget,
			advisorySources: [],
		};
	}

	function createValidator(policyOverrides?: Partial<SessionPolicySnapshot>): SessionPlanValidatorService {
		const scopeService = new SessionActionScopeService({
			_serviceBrand: undefined,
			extUri,
			asCanonicalUri: resource => resource,
		} as IUriIdentityService);

		const policyService = new SessionActionPolicyService({
			_serviceBrand: undefined,
			onDidChangePolicy: Event.None,
			async getPolicySnapshot(_executionContext, allowedRoots) {
				return {
					...getDefaultSessionPolicySnapshot(allowedRoots),
					...policyOverrides,
					allowedRoots,
				};
			},
		} as ISessionActionPolicyConfigService) as ISessionActionPolicyService;

		return disposables.add(new SessionPlanValidatorService(scopeService, policyService));
	}

	test('validatePlan accepts a read-only plan that fits the current Sessions policy envelope', async () => {
		const planningService = disposables.add(new SessionPlanningService());
		const validator = createValidator();

		const plan = await planningService.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Inspect the repo.',
			hostTarget,
			steps: [
				{
					kind: SessionPlanStepKind.SearchWorkspace,
					title: 'Search for the symbol',
					action: {
						kind: SessionActionKind.SearchWorkspace,
						requestedBy: SessionActionRequestSource.Session,
						query: 'needle',
					},
				},
				{
					kind: SessionPlanStepKind.ReadFile,
					title: 'Read the matching file',
					action: {
						kind: SessionActionKind.ReadFile,
						requestedBy: SessionActionRequestSource.Session,
						resource: URI.file('/workspace/repo/src/app.ts'),
					},
				},
			],
		});

		const result = await validator.validatePlan(plan, {
			executionContext: createExecutionContext(),
			providerCapabilities: createProviderCapabilities(),
		});

		assert.strictEqual(result.valid, true);
		assert.deepStrictEqual(result.issues, []);
	});

	test('validatePlan rejects executable steps without actions and invalid dependencies', async () => {
		const planningService = disposables.add(new SessionPlanningService());
		const validator = createValidator({ allowWorkspaceWrites: true });

		const plan = await planningService.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Patch the repo.',
			hostTarget,
			steps: [
				{
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch without action metadata',
					dependsOn: ['missing-step'],
				},
			],
		});

		const result = await validator.validatePlan(plan, {
			executionContext: createExecutionContext(),
			providerCapabilities: createProviderCapabilities(),
		});

		assert.strictEqual(result.valid, false);
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.MissingAction));
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.InvalidDependency));
	});

	test('validatePlan rejects plans that exceed the declared execution budget', async () => {
		const planningService = disposables.add(new SessionPlanningService());
		const validator = createValidator({
			allowCommands: true,
			allowWorkspaceWrites: true,
		});
		const fileOne = URI.file('/workspace/repo/src/one.ts');
		const fileTwo = URI.file('/workspace/repo/src/two.ts');

		const plan = await planningService.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Run a bounded repair.',
			hostTarget,
			budget: {
				maxSteps: 1,
				maxCommands: 0,
				maxFileWrites: 1,
				maxModifiedFiles: 1,
			},
			steps: [
				{
					kind: SessionPlanStepKind.RunCommand,
					title: 'Run validation',
					riskClasses: [SessionPlanRiskClass.LocalSafe],
					action: {
						kind: SessionActionKind.RunCommand,
						requestedBy: SessionActionRequestSource.Session,
						command: 'npm run test',
					},
				},
				{
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch files',
					action: {
						kind: SessionActionKind.WritePatch,
						requestedBy: SessionActionRequestSource.Session,
						patch: 'patch',
						files: [fileOne],
						operations: [
							{ resource: fileOne, contents: 'one' },
							{ resource: fileTwo, contents: 'two' },
						],
					},
				},
			],
		});

		const result = await validator.validatePlan(plan, {
			executionContext: createExecutionContext(),
			providerCapabilities: createProviderCapabilities(),
		});

		assert.strictEqual(result.valid, false);
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.BudgetExceeded));
	});

	test('validatePlan rejects worktree steps even when provider capabilities and policy would otherwise allow them', async () => {
		const planningService = disposables.add(new SessionPlanningService());
		const validator = createValidator({ allowWorktreeMutation: true });
		const worktreeRoot = URI.file('/workspace/repo-worktree');

		const plan = await planningService.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Create a repair worktree.',
			hostTarget,
			steps: [
				{
					kind: SessionPlanStepKind.OpenWorktree,
					title: 'Create the worktree',
					action: {
						kind: SessionActionKind.OpenWorktree,
						requestedBy: SessionActionRequestSource.Session,
						repository: repositoryRoot,
						worktreePath: worktreeRoot,
						branch: 'repair',
					},
				},
			],
		});

		const result = await validator.validatePlan(plan, {
			executionContext: createExecutionContext(),
			providerCapabilities: createProviderCapabilities({ canOpenWorktrees: true }),
		});

		assert.strictEqual(result.valid, false);
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.UnsupportedAction));
	});

	test('validatePlan rejects mutating steps denied by existing policy and checkpoint rules', async () => {
		const planningService = disposables.add(new SessionPlanningService());
		const validator = createValidator();
		const file = URI.file('/workspace/repo/src/app.ts');

		const plan = await planningService.createPlan({
			sessionId: 'session-1',
			providerId: 'provider-1',
			intent: 'Patch the repo.',
			hostTarget,
			steps: [
				{
					kind: SessionPlanStepKind.WritePatch,
					title: 'Patch the file',
					checkpointRequirement: SessionPlanCheckpointRequirement.None,
					action: {
						kind: SessionActionKind.WritePatch,
						requestedBy: SessionActionRequestSource.Session,
						patch: 'patch',
						files: [file],
					},
				},
			],
		});

		const result = await validator.validatePlan(plan, {
			executionContext: createExecutionContext(),
			providerCapabilities: createProviderCapabilities(),
		});

		assert.strictEqual(result.valid, false);
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.MissingCheckpoint));
		assert.ok(result.issues.some(issue => issue.code === SessionPlanValidationIssueCode.PolicyDenied));
	});
});
