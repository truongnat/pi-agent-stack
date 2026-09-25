# pi-subscription-providers

Local Pi package that registers **Cursor**, **Google Antigravity**, and **Claude Code** as custom model providers for [Pi](https://pi.dev). Authentication stays with the official CLIs. [JEV](https://typesafe.ai) remains the policy engine for routing.

## Security

- Never scrapes browser cookies.
- Never prints OAuth tokens or API keys, and never reads `~/.pi/agent/auth.json`, `~/.cursor` credentials, or Antigravity credential files.
- Exception, usage display only: Grok's and Cursor's `/usage` are TUI-only (print mode sends them to the model), so the endpoints those modals call are used with the CLI's own unexpired token from `~/.grok/auth.json` / `~/.config/cursor/auth.json` (Pi's xAI OAuth first for Grok). Nothing is refreshed, written, logged, or used for inference.
- Auth is delegated to:
  - Cursor: `cursor-agent` / verified Cursor `agent` (`status`, `models`, print/stream-json)
  - Antigravity: `agy` stream-json only today. ACP binaries (`agy-acp` / `antigravity-acp`) are detected but reported **not ready** until an ACP stream adapter ships — they are never registered with a fake `default` model.
- Subprocesses get a **strict environment allowlist** (PATH, HOME, locale, XDG, …).
- All errors, logs, status files, and test output are **secret-redacted**.
- No fake OAuth and no private API reverse-engineering.

## Claude Code (`claude-code/sonnet|opus|haiku`)

Uses the machine's existing Claude Code login. Anthropic rejects direct third-party API calls on subscription plans ("Third-party apps now draw from extra usage"), even with a valid Claude Code token, so every request goes through `claude -p` and counts against the plan like normal Claude Code use. Tools, MCP, hooks, slash commands, and session history are off (`--tools "" --strict-mcp-config --settings '{"disableAllHooks":true}' --no-session-persistence --disable-slash-commands`); Claude Code's own system prompt is replaced by a one-line one (~4.7k instead of ~10.7k tokens per call), and the prompt is sent on stdin. Readiness is `claude auth status`; models are listed at startup whenever `claude` is on PATH.

## Compatibility mode

Both CLIs are agents, not native Pi tool-call APIs. This package streams assistant **text**, **thinking** (when present), **usage**, **errors**, and **stop reasons**. It does **not** claim native Pi `toolCall` wire semantics. Pi keeps ownership of its tools. JEV **hard-blocks** subscription/compatibility providers for explore/change/run/unclear turns and only allows them for answer turns. If a session is already on a subscription model when a tool turn arrives, JEV forces a fallback to a native API model.

## Setup

1. Ensure CLIs are installed and logged in (`cursor-agent status`, `agy models`).
2. Config (no credentials):

```json
{
	"cursor": {
		"enabled": true,
		"command": "auto",
		"timeoutMs": 120000,
		"maxOutputChars": 200000,
		"readinessTtlMs": 300000,
		"latencyEstimateMs": 12000,
		"marginalInputCost": 0.15,
		"marginalOutputCost": 0.6
	},
	"antigravity": {
		"enabled": true,
		"command": "auto",
		"timeoutMs": 120000,
		"maxOutputChars": 200000,
		"readinessTtlMs": 300000,
		"latencyEstimateMs": 6000,
		"marginalInputCost": 0.15,
		"marginalOutputCost": 0.6
	}
}
```

Path: `~/.pi/agent/subscription-providers.json`

3. Install the package:

```bash
pi install ./packages/pi-subscription-providers
```

4. Slash command: `/subscription-providers` or `/subscription-providers refresh`

## Usage and quota

One format for every provider, no extra packages. Each provider is read through its own official tool whenever one exists:

- Footer next to the input: the active provider's plan, quota, and account, e.g. `codex plus   5h ▰▱▱▱▱▱▱▱ 10% (3h19m)   week ▰▰▰▰▰▰▱▱ 74% (2d22h)   · me@example.com`, colored at ≥70% / ≥90%. Refreshed on session start, model switch, and after each agent run (cached 1–10 min per provider).
- `/usage`: one block per provider with the same header, quota bars, reset times, balances, and alerts. Uses cached results (1–10 min); `/usage refresh` bypasses the cache.
- JEV routing: Cursor/Antigravity quota is written into the status cache as `quotaAvailable`; when every pool of a provider is spent (e.g. Cursor auto + API at 100%), JEV skips it instead of paying for a failing request. Refreshed at session start and after each agent run (cached, no model call).
- A provider appears only when its tool is installed and signed in; otherwise it is hidden, not reported as an error.

| Provider    | Source                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | `codex app-server` JSON-RPC (`account/rateLimits/read`, `account/read`), the data behind `/status`                                                                                                                                         |
| Claude      | `claude auth status` + `claude -p /usage --settings '{"disableAllHooks":true}' --no-session-persistence` (local slash command: no model call, no hooks, no session history)                                                                |
| Antigravity | `agy -p /usage` (agy's own slash command); remaining % per model group, shown as used %                                                                                                                                                    |
| Grok        | `/usage` is TUI-only (print mode sends it to the model), so the billing endpoint it calls: `cli-chat-proxy.grok.com/v1/billing?format=credits` + `/v1/settings`, with Pi's xAI OAuth or the Grok CLI login; `XAI_API_KEY` shows `api` only |
| DeepSeek    | `api.deepseek.com/user/balance` with Pi's API key                                                                                                                                                                                          |
| Cursor      | `DashboardService/GetCurrentPeriodUsage` (what the TUI `/usage` calls; auto and API pools per billing month) + `cursor-agent about --format json` (plan + account)                                                                         |

## Accounts

Every login is saved in `~/.pi/agent/accounts.json` (mode 600), grouped by provider; one account per provider is in use at a time. `/accounts` picks or removes one, only while idle.

- Before a turn, an account whose quota is spent (readable for ChatGPT/Codex and Claude) is swapped for another one in the same pool.
- When a request fails with a usage-limit or login error, the account is blocked (1 hour for quota, 24 hours for login) and the next one takes over at once.
- Transient errors are retried by Pi (2 s, 4 s, 8 s backoff); this extension adds up to 1 s of jitter so several sessions do not retry in lockstep, and the retry runs on the new account.
- Other failures are resent automatically only when the failed reply showed nothing (no text, no thinking, no tool call), as a hidden follow-up; earlier tool results stay in context and nothing reruns.

## Costs

Models use non-zero **marginal opportunity costs** (`marginalInputCost` / `marginalOutputCost`) so JEV can compare paths. Billing mode is `subscription`, not free.

## Provider refresh contract

Pi calls `refreshModels` after every `registerProvider` with `allowNetwork=false`. That offline path returns the in-memory readiness snapshot only — it does **not** spawn CLI probes and must not call `publishProviders` again (that caused a refresh cascade). Network probes happen only when `allowNetwork=true` (or via our own `refreshStatus` before a single publish).

## Status cache

Compact readiness (no secrets) is written to `~/.pi/agent/subscription-providers-status.json` for JEV to read with TTL. Discovery is lazy and cached; CLIs are not probed every turn.

## Detect notes

On this machine, bare `agent` may be Grok’s CLI. Detection prefers `cursor-agent` and fingerprints help text before accepting `agent`.
