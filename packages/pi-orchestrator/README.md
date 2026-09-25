# `pi-orchestrator`

Multi-Agent Orchestrator & Subagent Supervisor for the Pi coding agent (`@earendil-works/pi-coding-agent`).

## Overview

`pi-orchestrator` enables the master Pi agent to coordinate specialized subagents with isolated context scratchpads, role-scoped tools, cost-aware model assignment, and parallel/sequential execution DAGs.

### Core Features

- **Supervisor-Worker Pattern**: The Master agent decomposes tasks and delegates them to specialized workers with isolated scratchpads in `~/.pi-orchestrator/scratchpads/`.
- **Predefined Subagent Roster**:
  - `researcher`: Fast codebase navigation, documentation lookup, and file search (`flash`).
  - `coder`: Code generation, targeted edits, and refactorings (`sonnet` / `cursor`).
  - `tester`: Test suite execution, verification, and failure trace analysis (`mini` / `local`).
  - `reviewer`: Code review, diff inspection, and security analysis (`pro` / `opus`).
- **Master Agent Tools**:
  - `invoke_subagent`: Spawns subagents in parallel or sequentially.
  - `manage_subagents`: Inspects live subagents, views logs, kills runaway workers, or clears history.
  - `send_subagent_message`: Dispatches intermediate guidance to an active subagent.
- **Control Slash Command**:
  - `/agents`: Interactive dashboard for monitoring and managing active subagents.
  - `/agents list`, `/agents roster`, `/agents kill <id>`, `/agents kill-all`, `/agents clear`.

## Installation

Add bridge in `~/.pi/agent/extensions/pi-orchestrator.ts`:

```ts
export { default } from '../pi-agent-stack/packages/pi-orchestrator/index.ts'
```

Or run `scripts/install.sh`.
