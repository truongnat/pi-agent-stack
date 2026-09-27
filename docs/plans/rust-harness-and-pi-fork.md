# Rust in the harness, and forking Pi

Research: 2026-09-27  
Sources: this repo (`crates/pi-core`, `packages/pi-native-bridge`, JEV/DCP/orchestrator), installed `@earendil-works/pi-coding-agent@0.87.1`, GitHub `earendil-works/pi` (MIT, ~109.6k stars, ~77 MB git, TypeScript, last push 2026-09-26).

Companion note: [pi-core-fork.md](./pi-core-fork.md) (install path already shipped). This document goes deeper.

---

## 1. Findings

1. **Upstream Pi has no Rust.** Native TUI bits are **C / Objective-C** (`packages/tui/native/{darwin,linux,win32}`) for clipboard and modifier keys. The agent loop is TypeScript (`@earendil-works/pi-agent-core`).
2. **Pi already has a “harness”** — `packages/agent/src/harness/` (`createAgentHarness`, compaction, tools, session). That is *their* runtime. Ours is a **layer of extensions** (JEV, DCP, orchestrator, goal, TypeSafe Python gates) sitting *on* that harness via `pi.registerTool` / lifecycle hooks.
3. **`crates/pi-core` is not a Pi fork.** It is our cdylib. Most of its FFI is **unused in production**: only `countTokens` (DCP), `trigramSimilarity` (RL lessons), and `killProcessGroup` (orchestrator) are imported. Scan, search, skeletonize, spawn, rank, hash sit behind the bridge and tests only.
4. **Forking the whole monorepo into this git tree is legal (MIT) and a poor fit.** ~110k-star product, weekly TypeScript churn, C prebuilds, our value is extensions + native hot paths. A fork is justified only for internals the extension API cannot reach.

---

## 2. Two harnesses (do not collapse them)

| Layer | Owner | Language | Job |
|---|---|---|---|
| **Pi AgentHarness** | earendil-works | TypeScript | Prompt, tools, compaction, session JSONL, TUI/RPC/JSON modes |
| **TypeSafe gates** | this repo `typesafe-harness/` | Python + shell | Pre-tool / prompt / stop hooks (`TYPESAFE_HARNESS=agy` etc.) |
| **JEV + DCP + RL + goal + orchestrator** | this repo `packages/` | TypeScript | Routing, prune, subagents, `/goal` |
| **pi-core** | this repo `crates/` | Rust | Tokens, scan, AST skeleton, process groups, ranking |

Rust should accelerate **our** packages and optional Pi *tools*, not replace `createAgentHarness`. Rewriting the agent loop in Rust is a new product.

Pi `agent-core` already depends on npm `ignore` (gitignore walks). Duplicating that in Rust is fine if **JEV / DCP / prefetch** call it; it does not replace Pi’s built-in `grep`/`find` tools unless we register our own tools.

---

## 3. Current Rust integration (gap)

### Wired today

| Call | Caller | Why it matters |
|---|---|---|
| `countTokens` / BPE | `pi-dcp/lib/tokens.ts` | Budget, prune, goal token bars |
| `trigramSimilarity` | `pi-rl-engine` lessons | Retrieve similar episodes |
| `killProcessGroup` | `pi-orchestrator` manager | Kill hung `pi --mode json` workers |

### Built, not called from harness packages

`scanDirectory`, `searchWorkspace`, `skeletonizeCode`, `spawnSupervised`, `hashToolSignature`, `rankDocuments`, `vectorCosineSimilarity`.

JEV `repomap.ts` still uses `readdirSync` / `readFileSync`. Orchestrator workers spawn `pi` via Node `child_process`, not `spawnSupervised`. Subagent “grep the repo” still goes through **child Pi’s JS tools**.

### Constraints

- Bun FFI only (`typeof Bun !== 'undefined'`). Node `pi` without Bun uses TS fallbacks (scan returns `[]`).
- dylib lookup is macOS-first (`libpi_core.dylib` under repo or `~/.pi/agent/pi-agent-stack/...`). Linux `.so` / Windows `.dll` paths exist but doctor/setup are Darwin-centric.
- JSON over CString for scan/search/skeleton: large repos need the caps already in `scanner` / `ast` (20k entries, 8k files, 1 MiB search, 512 KiB skeleton).

---

## 4. How to integrate Rust *into this harness* (do this)

Order is “wire what we already compiled,” then grow the crate.

### Phase R1 — Call the existing FFI (days)

1. **JEV prefetch / repomap** — `scanDirectory` + `searchWorkspace` instead of recursive `readdirSync` on large dirty trees (the original “small project OK, big repo dangerous” issue).
2. **DCP / context pack** — `skeletonizeCode` before stuffing files into the model; keep signatures, drop bodies.
3. **Orchestrator workers** — `spawnSupervised` for `pi --mode json` (timeout + process group already match Lovelace-style hung children). Keep JSONL parsing in TS.
4. **RL** — `rankDocuments` for lesson recall (already has trigram).
5. **Doctor** — already fails if Cargo exists and FFI does not load.

Success: a JEV turn on `db-pro`-scale trees does not walk `target/` / `node_modules`; skeletonized files show in DCP stats.

### Phase R2 — New native work that pays rent

| Work | Why |
|---|---|
| Streaming search (iterator, not collect-all-paths) | Even 8k file cap allocates; true large monorepos need bounded memory |
| More grammars (Go, Java, Vue) | Skeleton coverage for this user’s stacks |
| Content-hash / DCP duplicate index in Rust | `hashToolSignature` is unused; DCP duplicate purge is TS |
| Linux/Windows dylib in `setup` + path matrix in the bridge | So `pi` on Linux is not silent-fallback |

Do **not**: port JEV routing, goal loop, or orchestrator DAG to Rust. Those are policy, not inner loops.

### Phase R3 — Optional native *tools* registered with Pi

If built-in `grep`/`find` stay slow, register `native_grep` / `native_skeleton` via `pi.registerTool` that call the bridge. Extensions can add tools; they cannot swap Pi’s agent-loop implementation.

TypeSafe Python gates stay Python (Jev System 1). Rust does not belong in `gate.py`.

---

## 5. Forking Pi — options and cost

Repo facts (GitHub API, 2026-09-27): MIT, default `main`, language TypeScript, size ~77k KB, packages: `agent`, `ai`, `chord`, `client`, `coding-agent`, `durable`, `evals`, `protocol`, `server`, `session-backends`, `telemetry`, `tui`. TUI native is AppKit/clang, not Cargo.

| Strategy | What we gain | What we pay | Verdict |
|---|---|---|---|
| **S0. npm pin + extensions** (current) | Setup installs `@earendil-works/pi-coding-agent@^0.87.1`; we ship extensions + `pi-core` | Cannot patch agent-session internals | **Keep** |
| **S1. Git submodule `vendor/pi`** | Read/patch source, pin SHA, `bun link` a local CLI | Submodule pain, rebuild TUI `.node`, merge every upstream week | Only if S0 blocks a named bug |
| **S2. Org fork `truongnat/pi`** | PRs back upstream; our default remote | Same as S1 plus public fork maintenance | If we contribute TUI/hooks upstream |
| **S3. Vendor a subset** (copy `agent-session` / theme) | Small tree | License OK; we diverge silently; upgrades break | Avoid |
| **S4. Rewrite agent loop in Rust** | One binary, no Node | Reimplement providers, TUI, RPC, sessions — years | **Out of scope** |

### When S1/S2 is justified (checklist)

A fork (or submodule) is worth it only if **all** of these are true:

1. A concrete bug or feature **cannot** be done with `registerTool`, `registerShortcut`, `on('input'|'agent_end'|…)`, themes, or `ember-ui.ts`.
2. The patch is **small** (TUI native, one `AgentSession.prompt` branch, idle semantics).
3. We can **rebase** onto `0.87.x` at least monthly.
4. We still **publish** a `pi` binary via `bun run setup` (build from submodule or `bun add -g` fallback).

Examples that still do **not** need a fork: subagent JSON streaming, goal steer/followUp, Ember chrome, model pool, idle timeouts — all extension-side.

Examples that **would**: changing how `pi --mode json` emits thinking; replacing Darwin TUI with a Rust renderer; making `prompt()` queue when `activeRun` is set without `isStreaming`.

---

## 6. Hybrid architecture (recommended)

```
 bun run setup
    ├─ npm/bun global: earendil-works pi CLI  (S0)
    ├─ cargo build -p pi-core                 (R1/R2)
    └─ rsync extensions → ~/.pi/agent/

 pi (TS AgentHarness)
    ├─ extensions: jev, dcp, goal, orchestrator, persona, stitch
    │      └─ pi-native-bridge → libpi_core.{dylib,so,dll}
    └─ child workers: pi --mode json  (orchestrator)
           └─ same dylib if PATH/HOME stack is installed
```

Optional later: `vendor/pi` submodule **read-only** for debugging upstream, not as the shipped CLI, until a patch exists.

---

## 7. Decision

- **Integrate Rust** by calling scan/search/skeleton/spawn from JEV, DCP, and orchestrator (Phase R1). Grow the crate only where those calls are hot.
- **Do not fork Pi into this repository** until a named extension-API wall exists. Keep MIT npm Pi + our stack.
- **Do not rewrite Pi’s AgentHarness in Rust.**

## 8. What “xịn” means for *this* crate (not a Pi rewrite)

Amateur today: four languages of skeleton, OpenAI counted as cl100k even for gpt-5.5/Codex, JEV repomap walks `readdirSync` (gitignore-blind), DCP dedup hashes in JS, scan/search FFI unused.

Premium bar:

| Surface | Done | Still open |
|---|---|---|
| Tokenizer | gpt-5 / gpt-4o / Codex / luna → **o200k_base** | Gemini-native tokenizer |
| JEV map | `scanDirectory` (ignore-aware) for `packages/*` surfaces | Prefetch `searchWorkspace` for the actual query |
| DCP | `hashToolSignature` (xxhash) as dedup key | Skeletonize large tool results |
| Orchestrator | JSON worker + idle/retry (TS spawn) | `spawnSupervised` FFI |
| AST | TS/TSX/Rust/Python + impl/class methods | Go, Java, Vue |
| Scan | Size/binary caps | Streaming iterator, no full path vec |

Shipped:

- o200k family; JEV native `scanRepoMap`; DCP xxhash keys
- JEV prefetch `searchWorkspace` (rg fallback)
- DCP skeletonize of bulky `read` / `read_file` results
- Orchestrator fallback CLIs via `spawnSupervised` (JSON Pi worker still streams with Node `spawn`)
