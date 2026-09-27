# Academic configuration for Pi (this stack)

Research date: 2026-09-27  
Scope: map peer-reviewed / arXiv primary work onto **Pi coding-agent + pi-agent-stack** knobs (JEV, DCP, compaction, orchestrator, `pi-defaults`, AGENTS.md). Not a survey of every agent paper.

## 1. Primary sources

| Paper | ID | Claim we use |
|---|---|---|
| Liu et al., *Lost in the Middle*, TACL 2023 | [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) | Relevant facts at **beginning or end** of context are used; middle of long context degrades. |
| Packer et al., *MemGPT*, 2023 | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) | Treat context as **working memory**; page old state out (compaction / DCP), keep a reserve. |
| Yang et al., *SWE-agent*, NeurIPS 2024 | [arXiv:2405.15793](https://arxiv.org/abs/2405.15793) | **ACI**: ~100-line file viewer, search capped (~50 hits), collapse old observations; interface design moves SWE-bench more than raw model size. |
| Yao et al., *ReAct*, ICLR 2023 | [arXiv:2210.03629](https://arxiv.org/abs/2210.03629) | Interleave thought and tool; loops without new evidence should stop. |
| Shinn et al., *Reflexion*, NeurIPS 2023 | [arXiv:2303.11366](https://arxiv.org/abs/2303.11366) | Verbal self-critique stored as episodic memory (our RL lessons). |
| Wu et al., *AutoGen*, 2023 | [arXiv:2308.08155](https://arxiv.org/abs/2308.08155) | Multi-agent conversation; more speakers need a **supervisor** and bounded fan-out. |
| Du et al., *Improving Factuality via Multiagent Debate*, 2023 | [arXiv:2305.14325](https://arxiv.org/abs/2305.14325) | Independent agents + synthesis beats one noisy chain; diversity of models helps. |
| Li et al., *CAMEL*, 2023 | [arXiv:2303.17760](https://arxiv.org/abs/2303.17760) | Role-conditioned agents (coder / researcher / tester) reduce role collapse. |
| Kahneman, *Thinking, Fast and Slow* (2011) | book | System-1 (Jev) for routing/guard; System-2 (main LM) for generation. |

SWE-agent ablation (same paper): removing the editor, lint, iterative search, or full-file dump each costs several SWE-bench Lite points. History collapse of all but last observations is net positive.

## 2. Mapping onto this stack

| Mechanism in Pi | Academic analogue | Config / code |
|---|---|---|
| JEV prefetch + trim | SWE-agent ACI + Lost-in-the-Middle (inject **few** files at the **tail**) | `prefetchFiles`, `prefetchLines`, `trimMinChars` |
| JEV hide tools | SWE-agent “don’t dump the whole IDE” | `route`, `routeMinHiddenTools` |
| JEV loop / stuck | ReAct without new observations | `THRESHOLDS.stuck` |
| JEV guard | Constitutional / safety filter | `guard`, `askConfidence` |
| Advisor briefing at **end** of context | Lost-in-the-Middle: put the brief at the recency peak | already tail-injected |
| DCP dedup / skeleton / purge | MemGPT paging + SWE-agent history collapse | `turnProtection.turns`, skeletonize |
| Pi `compaction.reserveTokens` / `keepRecentTokens` | MemGPT main-memory reserve + recency | `pi-defaults.json` |
| Orchestrator roles | CAMEL role-playing | roster |
| `minProvidersRequired: 2` | Debate / diversity | `orchestrator.json` |
| `maxConcurrentSubagents` | Coordination cost vs “more agents” | cap **3** (quota + Lovelace 180s stalls) |
| RL lessons | Reflexion verbal memory | `pi-rl-engine` |
| `steeringMode: one-at-a-time` | Single writer; avoid interleaved CoT | `pi-defaults.json` |

## 3. Settings we apply

**JEV (`config/jev-harness.json`)**

- `prefetchFiles`: 1 → **2** (SWE-agent: a second file beats a 1-file miss; still not a dump).
- `prefetchLines`: 80 → **120** (ACI ~100-line viewer).
- `prefetchMaxCandidates`: 20 → **24** (search still capped; SWE-agent ~50 max hits).
- `compactionReserveTokens`: 16384 → **32768** (align with Pi compaction; MemGPT reserve).
- `advisorMaxTokens`: 150 → **280** (role + verification without stuffing the middle).
- `trimMinChars`: 6000, `keepHeadChars`: 2000 (keep; collapse the body of huge tool dumps).
- `modelSwitchConfidence`: **0.82** (keep high — switching mid-task is Lost-in-the-Middle on a new prefix).
- New: **`thresholds`** object so academic knobs are file-tunable, not hardcoded.

**Pi (`config/pi-defaults.json`)**

- Compaction already `reserveTokens: 32768`, `keepRecentTokens: 24000` (recency bias).
- `steeringMode` / `followUpMode`: `one-at-a-time` (single writer).
- `defaultThinkingLevel`: `high` for System-2 coding; JEV still scales down for explore.

**DCP (`config/dcp.json`)**

- `turnProtection.turns`: **6** (protect the recency window Liu et al. show is usable).
- `purgeErrors.turns`: **3**.
- Skeletonize bulky reads (already shipped) ≈ SWE-agent “don’t keep full files in history”.

**Orchestrator (`config/orchestrator.json`)**

- `maxConcurrentSubagents`: **3** (debate needs ≥2 providers; more than 3 hits Codex idle/quota in this deployment).
- `minProvidersRequired`: 2 (keep).
- `alwaysOrchestrate`: true (CAMEL roles on by default).

**AGENTS.md**

- Explicit ACI rules: small reads, no middle-context dumps, verify, cap parallel writers.

## 4. Deep custom (code)

`THRESHOLDS` in `jev.ts` is now overridable from `jev-harness.json`:

```json
"thresholds": {
  "toolNeeded": 0.35,
  "prefetchFile": 0.55,
  "dropResult": 0.3,
  "stuck": 0.7,
  "secrets": 0.7,
  "askConfidence": 0.5
}
```

Shipped values: `prefetchFile` **0.55** (slightly easier second-file prefetch), others unchanged.

## 5. What we still do not copy from papers

- Full MemGPT paging API (function-calling memory editor) — DCP + Pi compaction is the analogue.
- SWE-agent custom editor/linter ACI — Pi already has `edit` + tests; we do not fork Pi’s TUI.
- Unbounded AutoGen debate rounds — Lovelace logs show idle death; cap concurrency instead.

## 6. How to retune later

Edit `~/.pi/agent/jev-harness.json` (synced from `config/jev-harness.json` on `bun run setup`). Restart Pi. Logs: `~/.jev-harness/log.jsonl`.
