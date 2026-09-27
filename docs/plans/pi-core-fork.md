# Pi Core — Deep Research & Fork Strategy

Research date: 2026-09-27  
Source session: Antigravity `640437a3-da98-4eae-a1ac-6e2ae2289434` (quota exhausted mid-write)

Deeper follow-up (Rust wiring + fork options): [rust-harness-and-pi-fork.md](./rust-harness-and-pi-fork.md).

---

## 1. What upstream Pi actually is

| | |
|---|---|
| Repo | https://github.com/earendil-works/pi |
| License | MIT |
| Stars | ~110k |
| Language | TypeScript |
| npm | `@earendil-works/pi-coding-agent` (this machine: **0.87.1**) |
| Binary | `~/.bun/bin/pi` → bundled `cli.js` |

### Stack

Pi does **not** have a Rust core. There is no `Cargo.toml` in earendil-works/pi.

| Layer | Technology |
|---|---|
| CLI | Node/Bun bundled JS (`cli.js`) |
| Agent loop | `@earendil-works/pi-agent-core` (TypeScript) |
| Providers | `@earendil-works/pi-ai` (TypeScript) |
| TUI | `@earendil-works/pi-tui` (TypeScript + native **C / Objective-C** `.node` addon on Darwin) |
| Session | `@earendil-works/chord` (TypeScript) |

Packages under `packages/`: `agent`, `ai`, `chord`, `client`, `coding-agent`, `durable`, `evals`, `protocol`, `server`, `session-backends`, `telemetry`, `tui`.

### How it is installed today

```bash
bun add -g @earendil-works/pi-coding-agent
```

`pi-agent-stack` already depends on `^0.87.1` as a **devDependency** (types / extension APIs). `scripts/install.sh` previously **required** `pi` on PATH and exited if missing.

---

## 2. This repo’s `crates/pi-core`

`crates/pi-core` is **our** native engine (cdylib + rlib), not a fork of earendil-works/pi:

- BPE token count (`tiktoken-rs`)
- Ripgrep-style scan (`ignore` + `memchr` + rayon)
- Tree-sitter skeletonizer (TS/Rust/Python)
- POSIX process supervisor
- SIMD-ish vector ranker / DCP helpers

JS talks to it through `packages/pi-native-bridge` (Bun FFI, TS fallbacks).

That is the right place to deepen Rust. Rewriting Pi’s agent loop in Rust would mean reimplementing the product, not “forking the core.”

---

## 3. Fork strategies (decision)

| Option | What it means | Verdict |
|---|---|---|
| **A. Auto-install npm CLI** | `bun run setup` installs `@earendil-works/pi-coding-agent` globally if `pi` is missing | **Do this.** Matches “clone repo → install → `pi` works.” |
| **B. git submodule / vendor the whole Pi monorepo** | Track 110k-star tree, pin commits, merge forever | **Do not.** Size, merge cost, and our extensions already hook the published CLI. |
| **C. Fork and patch TUI/agent in a copy** | Only if we must change Pi internals that extensions cannot reach | Deferred until a specific missing hook is proven. |
| **D. Grow `crates/pi-core`** | Hot paths we already own (scan, tokens, DCP, process) | Continue independently of upstream. |

Upstream is MIT, so a fork is *legal*. It is not the install path users need.

---

## 4. Install path (implemented)

`scripts/install.sh` now:

1. Ensures Bun (or npm) can install `@earendil-works/pi-coding-agent@^0.87.1` globally when `pi` is absent.
2. Continues rsync + native `cargo build --release` + extension links as before.

Users still get **published Pi**, plus this stack’s extensions and optional Rust speedups. They do not get a second, diverging Pi binary in git.

---

## 5. When a real fork would be justified

Only if we hit a wall that extensions cannot fix, for example:

- TUI chrome that Pi does not expose (beyond `ember-ui.ts` / theme JSON)
- Agent-loop changes (tool dispatch, streaming) that have no extension hook
- Bundling a single static binary with no Node/Bun

Until then: stay on npm Pi + our packages + `crates/pi-core`.

---

## 6. Recommended next Rust work (in this repo)

Status (2026-09-27):

1. **Doctor + setup** — `install.sh` still `cargo build --release`. `doctor.sh` fails if Cargo is present and the dylib is missing, or if Bun FFI cannot load it.
2. **Scanner / AST** — walk caps (`MAX_SCAN_ENTRIES`, `MAX_FILES_SEARCHED`, 1 MiB search files, skip NUL binaries); Tree-Sitter skipped above 512 KiB; Rust `impl` and Python class methods keep signatures.
3. **Agent loop stays TypeScript** — still `@earendil-works/pi-coding-agent`. Rust is scan/tokens/AST/process only.

TUI “hybrid Rust UI” remains a **separate product** (desktop/ratatui), not a drop-in replacement for `@earendil-works/pi-tui`.
