# Pi Coding Agent - Design System & TUI Specification (DESIGN.md)

> Synthesized and generated via **Google Stitch MCP**
> Project ID: `projects/10946548453860688721`
> Design System: **Ember Copper Terminal**
> Theme: Catppuccin Macchiato Slate (`#24273a`) with Radiant Ember Copper (`#f5a97f`)

---

## 1. Brand & Aesthetic Philosophy

This design system channels an uncompromising **TUI (Terminal User Interface)** aesthetic engineered for high-velocity software engineering, multi-agent orchestrations, and deep telemetry analysis. It balances the tactile precision of retro-futuristic hacker interfaces with modern developer ergonomics.

- **Tone**: Uncompromising utility, deterministic precision, tactile mechanical warmth.
- **Visual Structure**: CRT/Terminal box structures, crisp 1px borders, Unicode box-drawing glyphs (`┌`, `─`, `┐`, `│`, `└`, `┘`, `├`, `┼`), categorical status pills.
- **Typography**: Strictly monospaced (`JetBrains Mono`, `Fira Code`, `SF Mono`).

---

## 2. Color System & Semantic Tokens

### Surface Architecture
| Token | Hex | Role |
|---|---|---|
| **Base Canvas** | `#24273a` | Main view background (warm slate-violet) |
| **Recessed Panel** | `#1e2030` | Subagent logs, code editors, terminal streams |
| **Elevated Modal** | `#181926` | Popup dialogs (`/accounts`, `/usage`, fuzzy finders) |
| **Structural Border** | `#363a4f` | Hard 1px structural framing |
| **Active Glow Border** | `#f5a97f` | Focused panel, active input deck |

### Semantic & Telemetry Accents
| Token | Hex | Role |
|---|---|---|
| **Ember Copper (Primary)** | `#f5a97f` | Prompts (`>`), active cursor (`█`), keybind highlights |
| **Peach (Secondary)** | `#fab387` | Active subagent badges, numerical stats |
| **Mauve / Secondary** | `#c6a0f6` | JEV Reasoning accordion, AI thought blocks |
| **Sapphire (Tertiary)** | `#7dc4e4` | File paths, diff line numbers, network streams |
| **Emerald (Success)** | `#a6da95` | Git additions, passing tests, active health |
| **Amber (Warning)** | `#eed49f` | Rate limits, near quota expiry, compaction alert |
| **Red (Error)** | `#ed8796` | Syntax errors, halted loops, quota 429 exhaustion |
| **Foreground Text** | `#cad3f5` | Main reading text, assistant markdown |
| **Muted Text** | `#939ab7` | Line numbers, timestamps, inactive labels |

---

## 3. Core UI Screens & Layout Breakdown

### Screen 1: Main Terminal Workspace (Ember UX)
- **Top Model Rail**:
  ```text
  ember | antigravity/gemini-3.7-flash | jev active  ·  codex [53% 3h12m]  agy [ready 15%]  claude [35%]
  ```
- **Live Thought Block**:
  ```text
  ┌─[ ◐ THINKING (High · 4.2k tokens) ]──────────────────────────[▲ Collapse]─┐
  │ 1. Analyzing codebase AST for zero-allocation refactoring                │
  │ 2. Prefetched candidate: packages/pi-subscription-providers/src/...      │
  └──────────────────────────────────────────────────────────────────────────┘
  ```
- **Tool Execution Cards**:
  `[ ■ bash: bun test ]` with real-time streaming output & `[ ✓ typesafe-gate: PreToolUse (Score: 0.96) ]`.
- **Bottom Prompt Deck**: Multi-line prompt with line numbers, token counter `[128k/200k]`, and autocomplete popup.

---

### Screen 2: Multi-Agent DAG & Supervisor (`/agents`)
- **Visual DAG Graph**:
  ```text
  ┌───────────────────────┐
  │   JEV Supervisor      │
  │ (Orchestrator Leader) │
  └──────────┬────────────┘
             │
      ┌──────┴─────────────────────────┐
      ▼                                ▼
  ┌──────────────────────┐   ┌──────────────────────┐
  │ Worker 1: Architect  │   │ Worker 2: TestRunner │
  │ [Antigravity/Gemini] │   │ [Codex/GPT-5.6]      │
  └──────────┬───────────┘   └──────────┬───────────┘
             │                          │
             └──────────┬───────────────┘
                        ▼
             ┌──────────────────────┐
             │ Worker 3: Verifier   │
             │ [Claude Sonnet]      │
             └──────────────────────┘
  ```
- **Provider Diversity Guard**: Active badge ensuring $\ge 2$ independent provider backends to prevent common-mode LLM hallucination.

---

### Screen 3: Account Pool & Quota Manager Modal (`/accounts` & `/usage`)
- Centered popup modal with high-contrast `#f5a97f` glow border.
- Grouped providers (Codex, Antigravity, Claude, Cursor) with active indicators (`●` / `○`), subscription badges (`[Plus]`, `[Enterprise]`, `[Team]`), and ASCII usage meters:
  ```text
  ● 1. user@company.com  [PLUS]  5h ▰▰▰▰▱▱▱▱ 53% (3h12m)   week ▰▰▰▰▰▰▱▱ 78%
  ○ 2. backup@work.com   [PRO]   5h ▰▰▰▰▰▰▰▱ 88% (4h20m)   week ▰▰▰▰▱▱▱▱ 45%
  ```

---

### Screen 4: Google Stitch UI Studio (`/stitch`)
- **Left Panel**: Design System Tokens & Swatches inspector.
- **Center Canvas**: Grid preview of generated screens, wireframes, and variant comparisons (Variant A / B / C).
- **Right Panel**: Prompt Template Builder with real-time rule compliance (contrast, state variations, accessibility).

---

### Screen 5: Autonomous Multi-Turn Goal Loop (`/goal` & RL Engine)
- **Goal Objective Header**: Progress meter `[4/5 Subtasks]`, Turn budget `[8/20]`, Cost telemetry `[$0.038]`.
- **Independent JEV Judge**: Real-time evaluation score `0.94/1.0` with confidence intervals.
- **Persona RL Engine**: Real-time habit updates (`+2 concise returns`, `+1 strict typing`).

---

## 4. Keyboard Shortcuts & Interaction Pattern

| Keybind | Action |
|---|---|
| `Tab` | Cycle active focus between tiling panes / next agent node |
| `/usage` | Display live quota meters for all configured subscription CLIs |
| `/accounts` | Open interactive account switcher modal |
| `/stitch on` | Activate Google Stitch MCP UI design tools |
| `/goal <prompt>` | Launch autonomous multi-turn execution loop with JEV judge |
| `/persona` | Open preference reinforcement learning engine manager |
