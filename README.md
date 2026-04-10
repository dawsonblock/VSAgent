VSAgent — Developer README

Overview

VSAgent is a modified Code OSS runtime that introduces a Sessions-based AI execution layer with a centralized control spine.

The system is designed so that all agent-driven mutations are explicit, typed, scoped, and auditable.

This README explains how the system is structured and where to work when extending it.

⸻

High-Level Architecture

The system is split into three major layers:

1. Sessions Layer (src/vs/sessions)

Owns:
	•	UI (workbench, views)
	•	session lifecycle
	•	provider orchestration
	•	agent interaction

2. Action Spine (src/vs/sessions/services/actions)

Owns:
	•	execution authority
	•	policy enforcement
	•	approvals
	•	receipts

3. Substrate (existing VS Code + agent-host)

Owns:
	•	actual file system access
	•	terminal / command execution
	•	git operations
	•	remote host handling

⸻

Core Execution Flow

Every privileged action must follow this path:

Session → SessionActionService.submitAction()

1. Normalize Action
2. Normalize Scope (paths, cwd, host)
3. Fetch Provider Capabilities
4. Apply Policy (allow / deny / require approval)
5. Request Approval (if needed)
6. Execute via Executor Bridge
7. Append Receipt
8. Emit Result to Session

No direct mutation should bypass this path.

⸻

Directory Map

Sessions Core

src/vs/sessions/
  services/
    sessions/
      common/
        sessionsProvider.ts
      browser/
        sessionsProvidersService.ts
        sessionsManagementService.ts

Responsibilities:
	•	register providers
	•	manage active sessions
	•	route session requests

⸻

Action Spine

src/vs/sessions/services/actions/
  common/
    sessionActionTypes.ts
    sessionActionPolicy.ts
    sessionActionScope.ts
    sessionActionReceipts.ts

  browser/
    sessionActionService.ts
    sessionActionPolicyService.ts
    sessionActionApprovalService.ts
    sessionActionExecutorBridge.ts
    sessionActionReceiptService.ts
    sessionActionScopeService.ts

Responsibilities:
	•	define action model
	•	enforce policy
	•	handle approvals
	•	execute actions
	•	log receipts

⸻

Providers

src/vs/sessions/contrib/
  copilotChatSessions/
  localAgentHost/
  remoteAgentHost/

Responsibilities:
	•	session discovery
	•	backend routing
	•	capability declaration

Providers must NOT execute privileged actions directly.

⸻

UI / Views

src/vs/sessions/contrib/
  sessions/
  chat/
  logs/
  files/
  terminal/
  workspace/

These layers:
	•	display state
	•	trigger actions
	•	render receipts and approvals

They must not contain execution logic.

⸻

Key Services

SessionActionService

Location:

services/actions/browser/sessionActionService.ts

This is the authority boundary.

All privileged operations must go through here.

If you find code that:
	•	writes files
	•	runs commands
	•	mutates git
outside this service, it is a bug.

⸻

SessionActionPolicyService

Handles:
	•	allowed paths
	•	command restrictions
	•	host constraints
	•	approval requirements

Rules:
	•	deny on ambiguity
	•	stricter rule wins
	•	no implicit widening

⸻

SessionActionApprovalService

Builds structured approval payloads.

Must include:
	•	exact command or mutation
	•	scope
	•	provider + host
	•	risk classification

Never approve vague actions.

⸻

SessionActionExecutorBridge

Thin adapter to underlying systems.

Rules:
	•	no policy logic
	•	no approval logic
	•	no scope expansion

Only:

approved action → execution → result


⸻

SessionActionReceiptService

Append-only log per session.

Receipts include:
	•	action type
	•	scope
	•	provider
	•	approval metadata
	•	execution result

This is the source of truth for:
	•	audit
	•	debugging
	•	memory

⸻

Provider Capability Model

Defined in:

sessionsProvider.ts

Providers must declare:
	•	canReadWorkspace
	•	canWriteWorkspace
	•	canRunCommands
	•	canMutateGit
	•	canOpenWorktrees
	•	canUseExternalTools
	•	requiresApprovalForWrites
	•	requiresApprovalForCommands
	•	hostKind

Execution requires:

Action Allowed = 
  Provider Capability
  AND Policy Allow
  AND (Approval if required)


⸻

Scope Model

All actions operate on normalized scope:
	•	workspace root
	•	repo path
	•	worktree root
	•	cwd
	•	file paths
	•	host target (local / remote)

Invalid scope results in denial.

No fallback behavior.

⸻

Action Types

Defined in:

sessionActionTypes.ts

Supported actions:
	•	searchWorkspace
	•	readFile
	•	writePatch
	•	runCommand
	•	gitStatus
	•	gitDiff
	•	openWorktree

To add a new action:
	1.	define type
	2.	extend policy
	3.	extend executor bridge
	4.	add receipt mapping
	5.	add tests

⸻

Rules for Adding Features

DO
	•	use SessionActionService
	•	define typed actions
	•	normalize scope first
	•	enforce policy before execution
	•	emit receipts

DO NOT
	•	call filesystem APIs directly
	•	run commands directly
	•	mutate git outside the action spine
	•	rely on prompts for permissions
	•	bypass approval logic

⸻

Prompt / Skill System

Location:

contrib/chat/browser/promptsService.ts
skills/*

Used for:
	•	planning
	•	workflow hints
	•	repo conventions

Not used for:
	•	permissions
	•	execution authority

All prompts are advisory.

⸻

Action Log (Receipts)

Receipts are the system’s audit trail.

Used for:
	•	debugging
	•	replay
	•	memory systems
	•	operator visibility

Future systems should build on receipts, not chat logs.

⸻

Testing Strategy

Focus on enforcement, not UI.

Required coverage:
	•	action denied without capability
	•	action denied by policy
	•	approval-required action blocks
	•	approved action executes
	•	receipts are appended correctly
	•	scope violations are denied
	•	prompts do not widen authority

⸻

Development Workflow

When modifying the system:
	1.	Start at action types
	2.	update policy
	3.	update executor bridge
	4.	ensure receipts include new data
	5.	patch callers to use submitAction
	6.	add tests

Never start from UI.

⸻

Mental Model

Think of this system as:
	•	Sessions = UI + orchestration
	•	Action Spine = control plane
	•	Providers = execution backends
	•	Substrate = raw capabilities

Your job is to keep:

control centralized and explicit

