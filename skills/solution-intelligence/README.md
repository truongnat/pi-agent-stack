# solution-intelligence

A **meta-skill** (a thinking layer) that runs *before* implementation. It takes an issue / bug / feature / requirement / idea and — instead of jumping to code — expands context, finds gaps and hidden impacts, generates alternatives, evaluates trade-offs, and locks a bounded scope.

It is the missing piece that sits **before** coding-from-spec / implementation / code-review / UI-testing. It turns an agent from *"do what you're told"* into *"understand → look at the system → find gaps → weigh options → fix scope → then build"* — with explicit mechanisms for **thinking hard**, **knowing when to stop and ask**, and avoiding both under-thinking and over-thinking.

## Two hard rules

1. **Never implement the first plausible solution** before checking surrounding context, alternatives, impacts, and scope.
2. **Do not expand scope merely because an improvement is possible.** Every suggested improvement must justify its value, cost, risk, and relevance to the current goal.

Together they prevent both under-thinking and over-engineering.

## Structure

```
solution-intelligence/
├── SKILL.md                      # orchestrator (entry point, YAML frontmatter)
├── depth-and-calibration.md      # meta-layer: depth levels, bias audit, thinking-hard moves, stopping rule
├── question-escalation.md        # stop & ask: leverage test, question classes, ownership matrix, deferred defaults
├── context-discovery.md          # Phase 1 — understand problem + system + constraints + consumers
├── gap-analysis.md               # Phase 2 — 8 lenses × deep probes + 7 classification labels
├── impact-analysis.md            # Phase 3 — blast radius, second-order, coupling, data lineage, time dimension
├── solution-exploration.md       # Phase 4 — generation techniques, opportunity rubric, over-engineering red flags
├── tradeoff-analysis.md          # Phase 5 — criteria, matrix, sensitivity, steelmans, pre-mortem, confidence
├── scope-control.md              # Phase 6 — MUST/SHOULD/COULD/NOT NOW + DoD + kill criteria
├── verification-planning.md      # Phase 7 — acceptance map, coverage map, concurrency patterns, rollback
├── QUICKREF.md                   # one-page cheat sheet
├── templates/
│   └── analysis-report.template.md
└── examples/
    ├── refresh-token-support.example.md
    └── export-to-excel.example.md
```

## How it thinks harder

- **Depth levels (L1/L2/L3)** — fast-pass for trivial work, deep mode triggered by escalation signals (money, auth, irreversible ops, live migration, concurrency, cross-team contracts, compliance, scale, regression-prone areas). L3 adds second-order impacts, sensitivity analysis, pre-mortem, a bias audit, and confidence tags on every major claim.
- **Stop & ask** — a leverage-test gate decides when the agent must pause and ask the user (batched, ≤5, early) versus when it should decide or default with a visible `[assumed]` tag. BLOCKING questions are never guessed; DECISION questions go to the user with options + a recommendation; the rest become revisitable defaults. An ownership matrix keeps the agent from deciding business/security-posture calls on the user's behalf.
- **Confidence taxonomy** — `verified / inferred / assumed / unknown`; never present an assumption as fact.
- **Bias audit** — anchoring, availability, confirmation, sunk cost, shiny-object, premature optimization, overconfidence, false dichotomy, survivorship, groupthink.
- **Thinking-hard moves** — steelman the opposite, name what would falsify a claim, second-order "and then what?", pre-mortem, inversion, Chesterton's fence, negative space.
- **Stopping rule** — stop when another hour of analysis won't change the decision; guardrails against both rushing and analysis paralysis.

## Install (Claude Code / agent that supports Skills)

Copy the folder into your skills directory, e.g.:

```bash
cp -r solution-intelligence ~/.claude/skills/
```

Then the skill is invocable by its description — e.g. *"fix issue #123"* or *"implement feature X"* triggers the analysis pipeline before any code.

## Usage

Trigger with plain language:
- "Fix issue #123" → bug pipeline.
- "Add refresh token support" → feature pipeline.
- "Should we migrate to X?" → idea pipeline (premise questioned first).

Each run produces a full report (see `templates/analysis-report.template.md`) with:
restated request → context → questions & decisions → gaps (labeled) → impact (+ second-order) → alternatives (+ over-engineering verdicts) → trade-offs (criteria, matrix, sensitivity, confidence, sacrifice) → scope (MUST/SHOULD/COULD/NOT NOW + DoD + kill criteria) → verification (acceptance map + plan + rollback) → open questions.
