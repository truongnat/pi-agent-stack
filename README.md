# Pi Agent Stack

A portable, reproducible setup for the [Pi](https://pi.dev) coding agent: cost-aware model routing, subscription CLIs as providers, live plan quota, Google Stitch design tools, and a shared skill library for every agent on the machine.

- **Routes each turn to the cheapest sufficient model.** JEV picks model and thinking level; subscription routes serve answer turns, native models handle tool turns.
- **Uses the logins you already have.** Cursor, Antigravity, and Claude Code run through their official CLIs, so subscription usage counts against your plans.
- **Shows plan quota where you type.** A footer line for the active provider, and `/usage` for every signed-in one, without spending model tokens.
- **Designs UI with Google Stitch.** Stitch's MCP tools, loaded only when design work starts, with design skills consulted before each prompt.
- **Installs one skill library for all agents.** 82 skills in `~/.agents/skills`, read by Pi, Codex, Cursor, and agy.

The repo holds code and portable configuration only: no API keys, Pi auth, session history, caches, `node_modules`, or personal absolute paths.

## Quick start

Requirements: Pi, Node 22+, Python 3. Optional, for subscription routes: `cursor-agent`, `agy`, `claude`, `codex`.

```bash
git clone https://github.com/truongnat/pi-agent-stack.git
cd pi-agent-stack
bash scripts/install.sh
```

The installer stages the repo into `~/.pi/agent/pi-agent-stack`, registers the extensions, merges Pi settings (keeping unrelated packages), installs DCP and SoL-Pi, syncs the TypeSafe harness, and installs the global skills. Defaults:

```text
provider: openai-codex
model:    gpt-5.6-luna
thinking: high
```

Keys live in `~/.keys/` and are never committed:

```bash
mkdir -p ~/.keys
cp config/jev.env.example ~/.keys/jev.env      # edit, then source it from your shell startup
echo 'export API_KEY="…"' >> ~/.keys/typesafe.env  # TypeSafe harness
```

Google Stitch takes its key from `/stitch key` inside Pi (stored at `~/.keys/stitch-api-key`, mode 600).

Verify:

```bash
bash scripts/doctor.sh
pi -p 'Reply with exactly pong.'
```

## What's inside

| Component                                                                  | What it does                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/pi-jev-harness`](packages/pi-jev-harness)                       | JEV reasons around tool calls: routing, context prefetch, result trimming, loop control, guard. Picks model and thinking level per turn and keeps the DCP `compress` tool visible. |
| [`packages/pi-subscription-providers`](packages/pi-subscription-providers) | `cursor`, `antigravity`, and `claude-code` providers over `cursor-agent`, `agy`, and `claude -p`; readiness cache; plan-quota footer and `/usage`.                                 |
| [`packages/pi-stitch`](packages/pi-stitch)                                 | Google Stitch tools bridged from Stitch's official remote MCP server.                                                                                                              |
| [`packages/pi-rl-engine`](packages/pi-rl-engine)                           | Verified task feedback (test outcomes, lessons) that gives JEV cost-safe quality hints.                                                                                            |
| [`packages/pi-redmine`](packages/pi-redmine)                               | Redmine tools: get and list issues, comment, log time.                                                                                                                             |
| [`packages/pi-gdrive`](packages/pi-gdrive)                                 | Google Drive tools: search, resolve specs, download files and docs.                                                                                                                |
| [`packages/pi-xlsx2md`](packages/pi-xlsx2md)                               | Excel to Markdown (densified merges) and workbook diffs.                                                                                                                           |
| [`NVlabs/SoL-Pi`](https://github.com/NVlabs/SoL-Pi)                        | Context-cost optimizers (Observation Pack, Action Fusion, Evidence-Preserving Reducer, Online Context Compact). Cloned by the installer; config in `config/sol-pi.json`.           |
| `@davecodes/pi-dcp@0.2.0`                                                  | Pinned DCP (dynamic context pruning) from npm; config in `config/dcp.json`, source mirrored in `vendor/pi-dcp` for audit.                                                          |
| [`typesafe-harness/`](typesafe-harness)                                    | Shared PreToolUse gate, skill prompter, and Stop claim verifier for Pi, Codex, Antigravity, Claude, and Grok.                                                                      |
| [`config/`](config)                                                        | Portable templates: Pi defaults, JEV, providers, DCP, SoL-Pi, Antigravity hooks, and the skill checklist.                                                                          |
| [`scripts/`](scripts)                                                      | `install.sh` (setup), `doctor.sh` (health check), `sync-settings.mjs` (settings merge).                                                                                            |

## Providers and quota

| Provider      | Models                      | Runs through      | Login used                      |
| ------------- | --------------------------- | ----------------- | ------------------------------- |
| `claude-code` | `sonnet`, `opus`, `haiku`   | `claude -p`       | the machine's Claude Code login |
| `cursor`      | Cursor catalog              | `cursor-agent`    | `cursor-agent login`            |
| `antigravity` | Gemini, Claude, GPT via agy | `agy` stream-json | `agy` login                     |

These are compatibility routes: they answer from the conversation but do not run Pi tools, so JEV sends tool turns to a native model. Selecting an `anthropic/*` model without a usable key (missing, or OAuth, which Anthropic rejects from third-party apps) switches to the same `claude-code` tier automatically.

**Footer** — the active provider's plan, quota, and account, refreshed after each run:

```text
codex plus   5h ▰▱▱▱▱▱▱▱ 10% (2h08m)   week ▰▰▰▰▰▰▱▱ 74% (2d21h)   · you@example.com
```

**`/usage`** — one block per installed, signed-in provider (`/usage refresh` bypasses the cache):

| Provider    | Source (no model call)                                                    |
| ----------- | ------------------------------------------------------------------------- |
| Codex       | `codex app-server`, the data behind `/status`                             |
| Claude      | `claude auth status` + `claude -p /usage` (hooks and session history off) |
| Antigravity | `agy -p /usage`                                                           |
| Grok        | Grok billing endpoint (the TUI `/usage` is interactive-only)              |
| Cursor      | Cursor dashboard usage RPC + `cursor-agent about`                         |
| DeepSeek    | account balance endpoint (API key)                                        |

When every quota pool of Cursor or Antigravity is spent, the provider is marked `quotaAvailable: false` so JEV skips it instead of paying for a failing request.

## Google Stitch

Stitch's 15 tools register as `stitch_*` but stay off until needed, so their schemas cost nothing on ordinary turns:

1. The model calls `stitch_design` (or you run `/stitch on`). Design-system tools, whose schemas are large, need `design_system: true`.
2. `stitch_design` returns a short workflow with the local paths of the design skills: refer to them, make sure the project has a design system, then fill a prompt template (screen, device, layout, components with states, real content, tokens, banned patterns).
3. One screen per generate call; review with `impeccable` and fix with `edit_screens`.

Oversized results (embedded DESIGN.md, HTML) are slimmed while staying valid JSON.

## Global skills

`install.sh` installs the checklist in [`config/skills.json`](config/skills.json), 82 skills, into `~/.agents/skills`. Skills load on demand and cost no tokens until a task matches one. A skill already present under the same `SKILL.md` name is kept, so local edits are never overwritten.

<details>
<summary><b>Public repos</b> (71 skills, <code>npx skills add</code>)</summary>

| Repo                                                                                            | Skills                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [mattpocock/skills](https://github.com/mattpocock/skills)                                       | 36: `tdd`, `diagnosing-bugs`, `code-review`, `research`, `grilling`, `domain-modeling`, `writing-for-agents`, … |
| [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)                                   | 11: `officecli`, `officecli-docx/-pptx/-xlsx/…`, `morph-ppt`, `morph-ppt-3d`                                    |
| [truongnat/clean-code-skills](https://github.com/truongnat/clean-code-skills)                   | 7: `clean-code`, `clean-architecture`, `clean-code-review`, …                                                   |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)                           | 6: `ponytail`, `ponytail-audit`, `-debt`, `-gain`, `-help`, `-review`                                           |
| [stablyai/orca](https://github.com/stablyai/orca)                                               | `orca-cli`, `orchestration`, `computer-use`                                                                     |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)                                 | `design-taste-frontend`, `stitch-design-taste`                                                                  |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable)                                     | `impeccable`                                                                                                    |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `ui-ux-pro-max`                                                                                                 |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)       | `karpathy-guidelines`                                                                                           |
| [blader/humanizer](https://github.com/blader/humanizer)                                         | `humanizer`                                                                                                     |
| [typesafe-ai/skills](https://github.com/typesafe-ai/skills)                                     | `typesafe-ai`                                                                                                   |
| [vercel-labs/skills](https://github.com/vercel-labs/skills)                                     | `find-skills`                                                                                                   |

</details>

- **Vendored in [`skills/`](skills):** `master-writer` (with its learned `USER-VOICE.md`), `reflect`, `remake`, `solution-intelligence`. No public source; copied only when missing.
- **Installed by their own CLI**, when it is on PATH: `ai-memory-*` ×6 (`ai-memory install-instructions`) and `browser-skill` (`bsk install-skill`).
- **Not included:** company skills (`bsn-*`, `redmine`, `get-dev-token`, `get-spec`, `xlsx2md`).

```bash
npx -y skills update -g -y                                   # update everything later
npx -y skills add <owner/repo> -s <skill> -g -y -a codex     # add one, then list it in config/skills.json
```

## Routing and cost

JEV prefers the cheapest sufficient route and switches automatically only when confidence and savings gates pass. Explore, change, run, and unclear turns always go to a native model (preferring `openai-codex/gpt-5.6-luna`); subscription CLIs serve answer turns only.

DCP cuts context cost locally: it deduplicates repeated tool results, purges stale error inputs, and adds the `compress` tool. It never rewrites the on-disk transcript.

The RL engine updates its Q-table only when a turn changed the worktree and the project's tests gave a conclusive result; runtime or start-up failures are recorded as skipped and never penalize a model. JEV uses verified history only as a tie-breaker among near-equal-cost candidates after three trials, and never to justify a more expensive route.

## Commands

| Command                                | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `/usage [refresh]`                     | Plan quota, balance, and account for every signed-in provider |
| `/subscription-providers [refresh]`    | Readiness of the Cursor, Antigravity, and Claude Code routes  |
| `/stitch [status\|key\|on\|off]`       | Stitch status, API key, and tool activation                   |
| `/jev-harness [on\|off]`               | JEV counters and savings, or toggle the harness               |
| `/dcp context`, `/dcp stats`           | Context usage and pruning savings                             |
| `/rl [on\|off\|passive\|stats]`        | RL engine mode and statistics                                 |
| `/rl-verify`                           | Run the ground-truth test verifier and compute the reward     |
| `/lessons [list\|search <q>\|summary]` | Learned lessons and episodic reflections                      |
| `/reflect <note>`                      | Record a lesson or rule for this repository                   |

## Where things live

| Path                                             | Content                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `~/.pi/agent/pi-agent-stack/`                    | Staged copy of this repo that Pi loads            |
| `~/.pi/agent/settings.json`                      | Pi settings (merged, never overwritten wholesale) |
| `~/.pi/agent/subscription-providers.json`        | Provider config (from `config/`)                  |
| `~/.pi/agent/subscription-providers-status.json` | Readiness and quota cache, read by JEV            |
| `~/.pi/agent/stitch-tools.json`                  | Cached Stitch tool catalog                        |
| `~/.agents/skills/`                              | Global skills shared by all agents                |
| `~/.jev-harness/log.jsonl`                       | JEV decision log                                  |
| `~/.keys/`                                       | API keys (JEV, TypeSafe, Stitch)                  |

## Development

Each package checks on its own (typecheck, lint, format, tests):

```bash
cd packages/pi-jev-harness && npm ci && npm run check
cd ../pi-subscription-providers && npm ci && npm run check
cd ../pi-stitch && npm ci && npm run check
cd ../pi-rl-engine && npm test
```

After editing, re-run `bash scripts/install.sh` (or copy the changed files into `~/.pi/agent/pi-agent-stack/`) and `/reload` in Pi.

The vendored DCP source is third-party code under its original AGPL-3.0-or-later license; this stack uses the npm package rather than treating that code as its own. See [THIRD-PARTY.md](THIRD-PARTY.md).
