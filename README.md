# 🥧 Pi Agent Stack

A modular, production-ready extension stack for the [Pi coding agent](https://pi.dev) — featuring cost-aware model routing, subscription CLI integration, multi-account rotation, Google Stitch UI design systems, multi-agent orchestration, autonomous goal loops, and a global agent skill library.

---

## ⚡ Key Capabilities

- **🧠 JEV Advisor & Intelligent Routing**: Pre-turn strategic briefings, cost-optimal model selection, context prefetch, safety gates, and loop breaker.
- **🔄 Multi-Provider & Account Rotation**: Seamlessly route through Cursor, Antigravity (`agy`), Claude Code, Codex, and Grok with automatic quota rotation across saved accounts.
- **🎨 Google Stitch & Ember UI Design**: On-demand MCP bridge for Google Stitch UI generation, semantic design system management, and Ember-themed TUI message components.
- **🤖 Multi-Agent Orchestrator**: Subagent execution with DAG concurrency, provider diversity enforcement ($\ge 2$ distinct providers), consensus voting, and isolated scratchpads.
- **🎯 Autonomous Goal Loop (`/goal`)**: Multi-turn goal supervisor with turn/token budget stops, self-auditing milestones, and independent JEV evaluator.
- **👤 Persona Engine (`/persona`)**: Real-time developer preference learning with continuous feedback and automatic sync to `~/.pi/agent/persona.md`.
- **📈 Ground-Truth RL Engine**: Contextual bandit updating Q-values based on verifiable test outcomes and semantic lessons store.
- **📊 Developer & Office Tooling**: Native integration for Excel conversion (`xlsx2md`) and Google Drive full-text search and asset download.

---

## 📦 Monorepo Packages

| Package | Purpose |
| :--- | :--- |
| [`crates/pi-core`](crates/pi-core) | High-performance native Rust core: BPE tokenization, Ripgrep search, Tree-Sitter AST skeletonizer, POSIX process supervisor, and SIMD vector ranker. |
| [`packages/pi-native-bridge`](packages/pi-native-bridge) | Bun FFI bridge with zero-dependency TypeScript fallbacks for seamless native execution. |
| [`packages/pi-jev-harness`](packages/pi-jev-harness) | JEV reasoning, model routing, strategic briefings, result trimming, and safety guard. |
| [`packages/pi-subscription-providers`](packages/pi-subscription-providers) | CLI adapters (`cursor-agent`, `agy`, `claude`), quota tracking, and multi-account pool. |
| [`packages/pi-stitch`](packages/pi-stitch) | Google Stitch MCP bridge, Ember TUI theme tokens, and Markdown styling utilities. |
| [`packages/pi-orchestrator`](packages/pi-orchestrator) | Multi-agent pool supervisor, DAG workflow execution, and consensus evaluation. |
| [`packages/pi-persona`](packages/pi-persona) | Developer preference reinforcement learning and persona profile management. |
| [`packages/pi-goal`](packages/pi-goal) | Multi-turn autonomous goal loop with token budget controls and self-reflection. |
| [`packages/pi-rl-engine`](packages/pi-rl-engine) | Verifier-driven reinforcement learning and episodic lessons memory. |
| [`packages/pi-dcp`](packages/pi-dcp) | Dynamic Context Pruning, deduplication, error purge, and lossless compression. |
| [`packages/pi-xlsx2md`](packages/pi-xlsx2md) | Excel workbook densified conversion, diffing, and Markdown metadata generator. |
| [`packages/pi-gdrive`](packages/pi-gdrive) | Google Drive full-text search, metadata inspection, and asset downloader. |

---

## 🚀 Quick Start

### 1. Requirements
- **[Bun](https://bun.sh)** (v1.2+) — *All JS/TS tooling is 100% Bun-first*
- **[Pi CLI](https://pi.dev)** — `bun run setup` installs `@earendil-works/pi-coding-agent` globally if `pi` is missing
- *(Optional)* **Rust / Cargo** (for native speedups; pure TS fallbacks are built-in)
- *(Optional)* **Python 3.10+** (for `xlsx2md` CLI core)
- *(Optional)* Provider CLIs: `cursor-agent`, `agy`, `claude`, `codex`

### 2. 1-Command Installation

```bash
git clone https://github.com/truongnat/pi-agent-stack.git
cd pi-agent-stack
bun run setup
```
*(Hoặc `bash scripts/install.sh`)*

### 3. Environment & API Keys

API keys reside in `~/.keys/` and are never committed:

```bash
mkdir -p ~/.keys
cp config/jev.env.example ~/.keys/jev.env           # JEV routing configuration
cp config/typesafe.env.example ~/.keys/typesafe.env # TypeSafe harness
cp config/stitch.env.example ~/.keys/stitch.env     # Google Stitch MCP key
```

### 4. Health Check

```bash
bash scripts/doctor.sh
pi -p 'Reply with exactly pong.'
```

---

## 🎮 Essential Commands

| Command | Action |
| :--- | :--- |
| `/usage [refresh]` | View real-time quota, plan limits, and token reset windows for all signed-in providers. |
| `/accounts` | Interactive menu to switch active account or rotate credentials across providers. |
| `/goal <prompt>` | Launch autonomous multi-turn goal execution loop with milestone checks and budget limits. |
| `/persona [show\|export\|stats]` | Inspect learned developer preferences, style rules, and coding habits. |
| `/agents [list\|status\|kill]` | Monitor running subagents, DAG execution state, and provider consensus. |
| `/stitch [on\|off\|status\|key]` | Activate/deactivate Google Stitch MCP design tools and configure API keys. |
| `/jev-harness [on\|off\|status]` | Toggle JEV intelligent routing, strategic briefings, and view savings metrics. |
| `/rl [on\|off\|passive\|stats]` | Manage RL policy engine and review learned Q-value weights. |
| `/lessons [list\|search <q>]` | Search learned repository patterns, architectural rules, and past reflections. |

---

## 📂 System Architecture & Paths

```
~/.pi/agent/
├── pi-agent-stack/                     # Active staged stack loaded by Pi
├── settings.json                       # Merged Pi settings & extension registry
├── subscription-providers.json         # Provider configurations & fallback models
├── subscription-providers-status.json  # Live provider readiness & quota cache
├── accounts.json                       # Multi-account credential store (0600)
├── persona.md                          # Auto-exported developer persona rules
└── stitch-tools.json                   # Cached Google Stitch tool definitions

~/.agents/skills/                       # Global skill library shared across all coding agents
~/.jev-harness/                         # JEV execution traces, briefings, and spill logs
~/.keys/                                # Environment & API key storage (.env)
```

---

## 🛠️ Development & Quality Assurance

All packages use **[Bun](https://bun.sh)** for typechecking, linting, formatting, and unit tests:

```bash
# Run full verification across any package:
bun run --cwd packages/pi-stitch check
bun run --cwd packages/pi-jev-harness check
bun run --cwd packages/pi-orchestrator check
bun run --cwd packages/pi-subscription-providers check
bun run --cwd packages/pi-persona check
bun run --cwd packages/pi-goal check
bun run --cwd packages/pi-rl-engine check
bun run --cwd packages/pi-xlsx2md check
bun run --cwd packages/pi-gdrive check
```

After making modifications, sync to the Pi runtime:
```bash
rsync -av --exclude 'node_modules' --exclude '.git' packages/ ~/.pi/agent/pi-agent-stack/packages/
```

---

## 📄 License

MIT © [truongnat](https://github.com/truongnat). See [LICENSE](LICENSE) for details.  
Third-party component notices are documented in [THIRD-PARTY.md](THIRD-PARTY.md).
