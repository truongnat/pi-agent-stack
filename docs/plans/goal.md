# Plan: `/goal` for Pi

Status: implemented (2026-09-25). Shipped in `packages/pi-goal`.

We build our own `/goal` as a Pi extension in `packages/pi-goal`. It combines the two designs that already ship. From Codex we take the self-reported `update_goal` tool, the continuation prompt with its completion audit, and the automatic stop rules. From Claude Code we take the independent evaluator, run on Jev. It lives at the Pi level because the provider-native goals cannot reach Pi. Codex and Claude Code run behind Pi as answer-only CLI routes, so their own goal loops never fire. Pi 0.87.1 has no goal feature. The community packages would add a dependency we do not control, so we skip them.

## What the user gets

`/goal <objective>` sets a goal, and Pi keeps working on it across turns until it is complete, paused, blocked, or out of budget. `/goal` alone opens one menu with the status, objective, turns, time, tokens, and budget. From the menu you can edit, pause, resume, clear, or set a budget. `/goal pause`, `/goal resume`, `/goal clear`, `/goal edit <text>`, and `/goal budget <tokens>` do the same without the menu. The footer shows `goal ▸ 40K/200K · turn 3` while a goal is active. Esc pauses the goal. It does not clear it.

A message you type while a goal runs goes first. The goal picks up again after that turn, and your message counts as part of the goal's history.

## Design

### State

One goal per session. It is saved with `pi.appendEntry('goal-state', state)` on every change and restored from the last such entry in the branch on `session_start`, so `/resume` and restarts keep the goal.

```ts
type GoalStatus =
  "active" | "paused" | "blocked" | "budget_limited" | "complete";
interface GoalState {
  id: string;
  objective: string; // capped at 4,000 chars; longer text goes to a file the prompt points to
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number; // input + output of assistant messages in goal turns
  timeUsedMs: number;
  turns: number; // automatic continuations since the last user action
  emptyTurns: number;
  sameBlockerTurns: number;
  lastReason?: string; // last evaluator or blocker reason, shown in the menu
}
```

### The loop

Pi fires `agent_settled` once a run is fully over, after its retries and compaction. That is the Codex "thread idle" point. When the goal is active, the handler checks the stop rules below. If none applies, it calls `pi.sendUserMessage('Continue the goal (turn N).')`. The short visible line goes through `prompt()`, so `before_agent_start` runs for every continuation. JEV routes the model, pi-subscription-providers rotates accounts, and the RL engine records the turn, exactly as for a typed message. In the same `before_agent_start`, pi-goal returns `message` (hidden, `customType: 'goal-steering'`) carrying the full continuation prompt. When the user types a message during a goal, the same hook injects a short reminder of the active goal instead.

`agent_end` does the per-run accounting: tokens from `usage.input + usage.output`, elapsed time, whether the run produced text, thinking, or a tool call, and whether `update_goal` was called.

### Deciding "done"

There are two checks, and both must agree before a goal is marked complete.

1. **Self-report.** The model calls `update_goal({ status: 'complete' })` after the completion audit in the prompt, the same as Codex.
2. **Independent check.** Jev reads the objective, the last assistant message, and a short list of the run's tool calls and results. It answers a Noul "is the objective met" with a reason. This is the Claude Code evaluator on Jev, at about 300 ms and $0.04 per million input tokens. When Jev says "not met" with confidence ≥ 0.6, the goal stays active. The next continuation carries Jev's reason.

The answer-only routes (cursor, antigravity, claude-code) cannot call tools, so there Jev's check alone decides. When JEV is off or missing, the self-report alone decides. Jev is reached through a `globalThis.piAgentStackJev` bridge that pi-jev-harness sets. It follows the `piAgentStackAutomaticChange` pattern, so pi-goal does not import the harness.

### Tools for the model

`get_goal` returns the state. `update_goal({ status, reason })` accepts only `complete`, `blocked`, or `paused`. `paused` is valid only when the user asked for a pause in this conversation. Resume, clear, and budget stay with the user. There is no `create_goal`: goals come only from `/goal`, which avoids the model inventing goals. The tools are registered only while a goal is active, and JEV's `ALWAYS_KEEP` must include them so tool routing never hides them.

### Automatic stops

| Condition                                                       | New status                                                          | What the user sees                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| Esc / aborted run                                               | `paused`                                                            | "goal paused; /goal resume"                      |
| Retryable error                                                 | none, Pi retries first                                              | nothing extra                                    |
| Quota or login error                                            | unchanged while another account exists; `blocked` when none is left | rotation notice from pi-subscription-providers   |
| Other error after retries                                       | `blocked`                                                           | the error, with the reason saved in `lastReason` |
| 3 automatic turns in a row with no text, thinking, or tool call | `blocked`                                                           | "no progress for 3 turns"                        |
| Model reports `blocked` (same blocker 3 turns, per the prompt)  | `blocked`                                                           | the model's reason                               |
| `tokensUsed ≥ tokenBudget`                                      | `budget_limited`, plus one wrap-up turn with the budget prompt      | summary of progress and next step                |
| `turns ≥ maxTurns` (default 30, in config)                      | `paused`                                                            | "turn cap reached; /goal resume to continue"     |
| Self-report and Jev both say done                               | `complete`                                                          | final tokens, time, turns                        |

The turn cap has no Codex equivalent. It is our guard against a loop that looks like progress but is not.

### Prompts

We adapt the three Codex templates, `continuation`, `budget_limit`, and `objective_updated`, to Pi tool names and keep their substance. The objective is XML-escaped and wrapped as `<objective>` untrusted data. The continuation keeps the full scope and works from current files, not memory. It classifies the last turn as progress, verified wait, or no progress, and runs a requirement-by-requirement completion audit before `update_goal`. It sets `blocked` only after three turns on the same blocker. The Codex templates are Apache-2.0, so they get a credit line in the file header.

## Files

- `packages/pi-goal/index.ts`: wiring, command, footer.
- `packages/pi-goal/src/state.ts`: `GoalState`, the transitions, and persistence (pure, tested).
- `packages/pi-goal/src/loop.ts`: stop rules and the continuation decision (pure, tested).
- `packages/pi-goal/src/prompts.ts`: the three templates and their rendering.
- `packages/pi-goal/src/tools.ts`: `get_goal`, `update_goal`.
- `packages/pi-goal/test/*.test.ts`
- `packages/pi-jev-harness`: the `piAgentStackJev` bridge with one goal question, and the goal tools in `ALWAYS_KEEP`.
- `scripts/install.sh`: extension bridge. `README.md`, `docs/architecture.md`: docs.

## Steps

1. State, `/goal` command and menu, persistence, footer. No loop yet. Unit tests for transitions and restore.
2. Loop: `agent_settled` continuation, `before_agent_start` steering, `agent_end` accounting, all stop rules. Unit tests feed fake `agent_end` messages through the rules.
3. Tools, plus the `ALWAYS_KEEP` entry in JEV.
4. Jev bridge and the evaluator question. Test that a Jev "not met" keeps the goal active and a disagreeing self-report is overruled.
5. End-to-end over RPC with a real small goal: "make `test/sum.test.ts` pass" in a temp repo with a failing test. It must complete in a few turns, stop on Esc, and resume. Then run one check in the TUI through tmux for the footer and the menu.
6. Docs and install. Measure token use per continuation turn and record it in the package README.

About half a day for steps 1–4 and two hours for 5–6.

## Verify before step 2

- `agent_settled` fires once per settled run and not during a retry sleep. Confirm this in `agent-session.js` `_emitAgentSettled` and with a log line in RPC mode.
- `sendUserMessage` from `agent_settled` lands in the deferred-settled queue and starts a normal `prompt()`. Confirm that `before_agent_start` fires for it and that JEV sees the short line as the task. If JEV routes on the short line alone, pass the objective in the injected message and let JEV read it.
- The abort `stopReason` value for Esc (`aborted`) and that `agent_settled` still fires after it.

## Done when

- A goal set with `/goal` keeps running without further input until one of the stop rules fires, and each stop leaves a clear status and reason in `/goal`.
- Esc, `/goal pause`, and a typed message all take control back within one turn.
- The goal survives `/resume` and a Pi restart.
- On an answer-only route, completion is decided by Jev, and the loop still stops.
- `npm run check` passes in `packages/pi-goal`, and the RPC run from step 5 completes.

## Research

Sources: Codex CLI 0.156.0 source, `openai/codex` `codex-rs/ext/goal` and `codex-rs/tui/src` (Apache-2.0). The Claude Code 2.1.282 binary, from its strings. Pi 0.87.1 `dist/core/agent-session.js` and `extensions/types.d.ts`. npm metadata for the Pi community packages.

### Codex

Goals are stored per thread in SQLite (`thread_goals`) with objective, status, token budget, tokens used, and time used. The statuses are `active`, `paused`, `blocked` (shown as "stalled"), `budget_limited`, `usage_limited`, and `complete`. The user drives it with `/goal <objective>` and a `/goal` menu that shows status, objective, time, tokens, and budget and offers `edit`, `pause` or `resume`, and `clear`. The footer reads "Pursuing goal (40K / 50K)", and a paused goal asks "Resume paused goal?" on return. Objectives too long for the prompt are written to `goal-objective.md` and referenced by path.

The model gets `get_goal`, `create_goal` (only on an explicit user request, and it fails if an unfinished goal exists), and `update_goal` with `complete`, `blocked`, or `paused`. `paused` requires an explicit user request. The model cannot resume or budget-limit a goal.

When the thread goes idle with an active goal, the goal extension starts a hidden turn with the continuation prompt. It stops the goal by itself on a turn error (to avoid loops that burn tokens), on a usage limit, after three automatic turns with no activity, and after three turns whose tool calls all failed. When the budget runs out it marks the goal `budget_limited` and sends one wrap-up prompt. An edited objective gets an "objective updated" prompt that supersedes the old one.

### Claude Code

`/goal <condition>` and `/goal clear`. The model can also propose a goal, which the user approves with one key. The goal runs as a session Stop hook. After each turn a separate evaluator checks the condition from the conversation alone, without running commands or reading files. "Met" clears the goal. "Not met" re-prompts, bumps the iteration count, and keeps the last reason. Conditions are capped at 500 characters and should name one measurable end state with its check, for example "bun test exits 0". It needs a trusted workspace and hooks enabled.

### Pi

No built-in goal in 0.87.1. The hooks that make one possible:

- `agent_settled` fires when a run is fully over.
- `before_agent_start` can inject a hidden message.
- `agent_end` sees the run's messages and usage.
- Also used: `sendUserMessage` and `sendMessage`, `registerTool`, `registerCommand`, `appendEntry`, `ui.setStatus` and `ui.select`.

Community packages exist: `pi-codex-goal` 0.3.1, `pi-goal-x` 0.31.9, `@narumitw/pi-goal` 0.54.8, `pi-goal` 0.1.7, `@agimon-ai/doompi-goal` (alpha). None is installed here, and we do not depend on them.

The two designs trade off differently. Codex trusts the model's self-audit and backs it with hard stop rules. Claude Code trusts an outside judge that sees only the conversation. The self-audit fails when the model declares victory early. The outside judge fails when the evidence is not visible in the conversation. Running both, with Jev as the cheap judge, covers each failure with the other.
