# Where Rust FFI pays off in this repo

Audit: 2026-09-27. Rule: move **inner loops over bytes/files/tokens**, not policy, HTTP, or TUI.

Already in `crates/pi-core` + `pi-native-bridge`: tokens (BPE/o200k), scan, search, skeleton, xxhash, spawn/kill, trigram, rank, cosine.

---

## Keep in TypeScript / do not port

| Surface | Why |
|---|---|
| JEV `ask()` / TypeSafe HTTP | Network + JSON policy; Rust does not cut latency |
| Orchestrator DAG, roster, consensus votes | Control flow |
| Goal state machine, steer/followUp | Pi API |
| Ember TUI, Markdown, Stitch, GDrive | UI / network |
| Bandit Q-table (`rl-qtable.json`) | Tens of rows |
| `verifyCachePrefixIntegrity` (3 regexes) | V8 already cheap; **stability** of the prefix matters, not regex µs |
| oxlint rules, xlsx2md CLI | Separate tools |

---

## Ranked bridge list

### P0 — already wired (keep using)

| Hot path | Package | Native call |
|---|---|---|
| Token budget | DCP `tokens.ts` | `countTokens` |
| Dedup key | DCP `toolCallKey` | `hashToolSignature` |
| Repo surfaces | JEV `repomap` | `scanDirectory` |
| Prefetch hits | JEV `route` | `searchWorkspace` |
| Bulky reads | DCP `skeletonize` | `skeletonizeCode` |
| Fallback CLIs | Orchestrator | `spawnSupervised` |
| Kill hung workers | Orchestrator | `killProcessGroup` |
| Lesson fuzzy | RL `trigramSimilarity` | vector crate |

### P1 — worth bridging next (CPU × every turn or every huge tool dump)

| Candidate | Where today | Why Rust | Status |
|---|---|---|---|
| **Skeleton in JEV compactor** | `compactor.ts` `summarizeToolOutput('read')` keeps a crude 100-char excerpt | Tree-sitter already in crate; same as DCP; **saves model tokens** (AI perf, not just wall-clock) | **This pass** |
| **Lesson rank** | `lessons.ts` O(n tokens × lessons) in JS + one trigram | `rankDocuments` (rayon) | **This pass** |
| JSONL worker parse | `json-stream.ts` | Only if traces >> 10k events/s; TS is fine now | later |
| `canonicalJson` | DCP `messages.ts` | Nested objects per tool call; JS is enough unless 10k calls/turn | later |
| Streaming search iterator | `scanner` still collects paths | Memory on huge monorepos | later |
| More AST langs | Go/Java/Vue | Skeleton coverage | later |
| Prompt-prefix **fingerprint** | none | xxhash of static system prompt → log cache-hit identity | later (observability) |

### P2 — maybe

| Candidate | Note |
|---|---|
| `compactHistory` char counting | Cheap; skip |
| Spill file I/O | Disk bound |
| Subscription line-stream | I/O bound |
| Persona extractor | Rare |

### AI / prompt / cache (not “faster loops”)

These improve **token cost and cache hit rate**, which dominate wall-clock:

1. **Prefix cache** — keep system prompt deterministic (`verifyCachePrefixIntegrity`). Rust does not help; **don’t put timestamps in system**. JEV advisor stays at the **tail**.
2. **Working memory** — DCP skeleton + JEV compact + Pi `keepRecentTokens` (Lost-in-the-Middle).
3. **Prefetch ACI** — 2×120 lines, native search (SWE-agent).
4. **Lessons** — retrieve 3 Reflexion snippets via native rank so the main prompt is short and relevant.
5. **o200k** — gpt-5/Codex budgets match the real BPE.

---

## Per-package heat map

| Package | Move to Rust? |
|---|---|
| `pi-dcp` | Tokens, hash, skeleton **done**. Pipeline orchestration stays TS. |
| `pi-jev-harness` | Scan/search **done**. Compactor skeleton **this pass**. Cache check stays TS. |
| `pi-rl-engine` | Trigram **done**. Rank **this pass**. Bandit stays TS. |
| `pi-orchestrator` | Kill + supervised fallbacks **done**. JSONL parse stays TS. |
| `pi-goal` | No. |
| `pi-persona` | No. |
| `pi-subscription-providers` | No (subprocess I/O). |
| `pi-stitch` / `pi-gdrive` / `pi-xlsx2md` | No. |
