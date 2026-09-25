# `pi-persona`

User Preference Reinforcement Learning (Persona Engine) for the Pi coding agent (`@earendil-works/pi-coding-agent`).

## Overview

`pi-persona` learns the individual developer's unique coding taste, architecture idioms, workflow habits, and communication expectations over time.

### Core Features

- **User Preference Reinforcement Learning (UPRL)**: Self-tuning Q-value weights for individual developer habits.
- **Implicit Habit Mining**: Automatically extracts preference signals and corrections from user prompts (e.g. *"đừng dùng any"*, *"dùng early return"*, *"trả lời ngắn gọn"*).
- **Zero-Bloat Contextual Injection**: Synthesizes the top relevant constraints (~60 tokens) and injects them seamlessly before generation.
- **Human & Machine Stores**:
  - `~/.pi/agent/persona.json`: Machine state with historical Q-weights and reinforcement counters.
  - `~/.pi/agent/persona.md`: Clean, auto-exported Markdown profile of learned habits.
- **Master Tools**:
  - `get_persona`: Inspect active developer persona and confidence scores.
  - `update_persona`: Explicitly teach or refine a habit.
  - `feedback_persona`: Give positive reinforcement or negative penalty to a habit.
- **Slash Command**:
  - `/persona [status|list|learn <text>|reset]`

## Installation

Add bridge in `~/.pi/agent/extensions/pi-persona.ts`:

```ts
export { default } from '../pi-agent-stack/packages/pi-persona/index.ts'
```

Or run `scripts/install.sh`.
