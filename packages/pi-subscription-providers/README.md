# pi-subscription-providers

Local Pi package that registers **Cursor** and **Google Antigravity** as custom model providers for [Pi](https://pi.dev). Authentication stays with the official CLIs. [JEV](https://typesafe.ai) remains the policy engine for routing.

## Security

- Never scrapes browser cookies.
- Never reads or prints OAuth tokens, API keys, `~/.pi/agent/auth.json`, `~/.cursor` credentials, or Antigravity credential files.
- Auth is delegated to:
  - Cursor: `cursor-agent` / verified Cursor `agent` (`status`, `models`, print/stream-json)
  - Antigravity: `agy` stream-json only today. ACP binaries (`agy-acp` / `antigravity-acp`) are detected but reported **not ready** until an ACP stream adapter ships — they are never registered with a fake `default` model.
- Subprocesses get a **strict environment allowlist** (PATH, HOME, locale, XDG, …).
- All errors, logs, status files, and test output are **secret-redacted**.
- No fake OAuth and no private API reverse-engineering.

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

## Costs

Models use non-zero **marginal opportunity costs** (`marginalInputCost` / `marginalOutputCost`) so JEV can compare paths. Billing mode is `subscription`, not free.

## Provider refresh contract

Pi calls `refreshModels` after every `registerProvider` with `allowNetwork=false`. That offline path returns the in-memory readiness snapshot only — it does **not** spawn CLI probes and must not call `publishProviders` again (that caused a refresh cascade). Network probes happen only when `allowNetwork=true` (or via our own `refreshStatus` before a single publish).

## Status cache

Compact readiness (no secrets) is written to `~/.pi/agent/subscription-providers-status.json` for JEV to read with TTL. Discovery is lazy and cached; CLIs are not probed every turn.

## Detect notes

On this machine, bare `agent` may be Grok’s CLI. Detection prefers `cursor-agent` and fingerprints help text before accepting `agent`.
