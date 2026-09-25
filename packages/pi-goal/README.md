# `pi-goal`

Multi-turn autonomous goal loop extension for the Pi coding agent (`@earendil-works/pi-coding-agent`).

## Overview

`pi-goal` combines the best of **Codex CLI** (self-reported `update_goal`, requirement audit, robust automatic stop rules) and **Claude Code** (independent JEV evaluator) into an autonomous goal loop running directly inside Pi.

### Features

- **/goal <objective>**: Starts an autonomous multi-turn goal. Pi continues executing across turns until the objective is accomplished, verified, paused, blocked, or out of budget.
- **/goal** menu: Interactive control panel (`ctx.ui.select`) showing live status, objective, elapsed time, token usage, and budget.
- **Subcommands**: `/goal pause`, `/goal resume`, `/goal clear`, `/goal edit <objective>`, `/goal budget <tokens>`.
- **Automatic Stop Rules**:
  - `Esc` or turn abort pauses execution cleanly.
  - Model self-reports `complete` / `blocked` / `paused` with reasons via `update_goal`.
  - Independent **JEV Evaluator** validation when JEV is configured.
  - Automatic blocker detection (3 consecutive unprogressed turns).
  - Configurable token budget limits and max turn caps (default 30 turns).
- **Session Persistence**: Goal state is saved to the session branch (`pi.appendEntry('goal-state', state)`) and restored on restart or `/resume`.

## Installation

Add bridge in `~/.pi/agent/extensions/pi-goal.ts`:

```ts
export { default } from '../pi-agent-stack/packages/pi-goal/index.ts'
```

Or run `scripts/install.sh`.
