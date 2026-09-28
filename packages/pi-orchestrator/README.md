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
- **Provider Diversity Guard**:
  - Requires at least 2 available/configured providers (`minProvidersRequired: 2`) before dispatching subagents, protecting against single-provider rate-limiting or quota exhaustion.
- **Control Slash Command**:
  - `/agents`: Interactive dashboard for monitoring and managing active subagents.
  - `/agents status`, `/agents list`, `/agents roster`, `/agents kill <id>`, `/agents kill-all`, `/agents clear`.
- **Live session dashboard**: The first Pi session starts a local dashboard at `http://127.0.0.1:4317`; other Pi sessions attach automatically. It shows live chat/tool activity and an agent dependency canvas. The detached local host exits after the final Pi session closes. Set `PI_DASHBOARD_PORT` to change the port.
- Build the standalone `pi-live-dashboard` repo with `bun install && bun run build`; it writes the bundle to `~/.agents/outputs/pi-agent-stack/artifacts/dashboard`. The orchestrator only serves that bundle and the live session stream.

## Configuration

Config lives at `~/.pi/agent/orchestrator.json`:

```json
{
	"enabled": true,
	"guard": true,
	"minProvidersRequired": 2
}
```

- `enabled` (boolean, default: `true`): Enable/disable orchestrator capabilities.
- `guard` (boolean, default: `true`): Enforce provider diversity verification.
- `minProvidersRequired` (number, default: `2`): Minimum distinct LLM providers required.

## Installation

Add bridge in `~/.pi/agent/extensions/pi-orchestrator.ts`:

```ts
export { default } from '../pi-agent-stack/packages/pi-orchestrator/index.ts'
```

Or run `scripts/install.sh`.
