---
name: solution-intelligence
description: >
  Context-aware problem analysis that runs BEFORE any implementation.
  Use when the user asks to fix an issue or bug, implement a feature,
  refine a requirement, or evaluate an idea and wants rigor (context, gaps,
  impacts, alternatives, trade-offs, and a bounded scope) instead of the first
  plausible solution. Loads phase files in order (context-discovery,
  question-escalation, gap-analysis, impact-analysis, solution-exploration,
  tradeoff-analysis, scope-control, verification-planning), with
  depth-and-calibration governing how hard to think. Use proactively before
  coding-from-spec, implementation, or code review when the problem is non-trivial.
---

# Solution Intelligence

A thinking layer that sits in front of any coding task. Input is an issue / bug / feature / requirement / idea. Output is a bounded, verified plan — not code.

```
Issue / Feature
      ↓
Understand Context        → context-discovery.md
      ↓  ⏸ stop & ask     → question-escalation.md
Find Gaps & Hidden Impacts → gap-analysis.md
      ↓
Map Blast Radius          → impact-analysis.md
      ↓
Generate Alternatives     → solution-exploration.md
      ↓
Evaluate Trade-offs       → tradeoff-analysis.md
      ↓
Lock Scope                → scope-control.md
      ↓
Define Verification       → verification-planning.md
      ↓
Implementation / Verification
```

`depth-and-calibration.md` governs the *whole* pipeline: how deep to go, when to escalate, and how to avoid thinking traps.

`question-escalation.md` governs *when to stop and ask the user*: batched, early, and only for questions that pass the leverage test (the answer actually changes the outcome). It fires at the end of context-discovery and again on any loop-back that invalidates an earlier answer.

## Two hard rules (never violate)

1. **Never implement the first plausible solution** before checking surrounding context, alternatives, impacts, and scope.
2. **Do not expand scope merely because an improvement is possible.** Every suggested improvement must justify its value, cost, risk, and relevance to the current goal.

Rule 1 prevents under-thinking. Rule 2 prevents over-engineering. They only work together.

## Depth levels — calibrate first

Pick a depth before starting, then let escalation signals move it up.

- **L1 — Fast pass.** Trivial, unambiguous, low blast radius. Output: context (2–3 bullets) + one-line gap check + one-line scope. Say "fast pass applied".
- **L2 — Standard.** Default for a real feature/bug. All 7 phases, one pass each.
- **L3 — Deep.** Triggered by escalation signals (see `depth-and-calibration.md`). Adds: second-order impacts, sensitivity analysis, pre-mortem, bias audit, migration/concurrency/security verification depth, and explicit confidence statements per major claim.

**Never run L3 as default on a small task** — that is ceremony (analysis paralysis). **Never stay at L1 when an escalation signal is present** — that is rushing.

## Escalation signals (any one → move to L3)

- Involves **money, payments, billing**.
- Touches **auth, permissions, secrets, or tenant isolation**.
- **Irreversible** operations (destructive migration, data deletion, breaking API).
- **Data migration / schema change** with existing production data.
- **Concurrency / shared mutable state** (races, double-spend, counters, sessions).
- **Cross-team or cross-service contract** change.
- **Compliance / legal / privacy** surface.
- Performance or scale beyond current load.
- The area has a **history of regressions**.

## Stop & ask (question escalation)

Stop and ask the user when a question passes the leverage test — see `question-escalation.md`. In one line: ask **early** (end of context-discovery), **batched** (≤5, one message), and **only what the code can't answer and whose answer changes the outcome**. Never silently guess a load-bearing decision; a deferred question becomes a visible `[assumed]` default with a revisit trigger.

## Run modes

### Bug / issue
`context-discovery → gap-analysis (why did it break) → impact-analysis → solution-exploration → tradeoff-analysis → scope-control → verification-planning`
Weights: correctness, minimal blast radius, regression safety.

### Feature / requirement
`requirement → existing capabilities → missing capabilities → design alternatives → future opportunities → over-engineering check → recommended scope`
Weights: fit to architecture, future-proofing with restraint, bounded scope.

### Idea / spike
Question the premise first. If the premise is weak, say so before any design work.

## Loop-back rules (when to revisit an earlier phase)

- A solution phase discovers a fact that contradicts the context → return to `context-discovery`.
- A trade-off exposes a criterion nobody considered → return to `gap-analysis`.
- Scope exposes an unverified assumption as load-bearing → return to `context-discovery`.
- Verification reveals an untestable requirement → return to `scope-control` (downscope or restate).
- A later phase invalidates an earlier user answer → **re-ask the user** with the new information (never silently re-interpret).

## Calibration rules (from depth-and-calibration.md)

- Tag every major claim with a **confidence level**: `verified / inferred / assumed / unknown`. Never present an assumption as fact.
- Audit for **bias** before finalizing the recommendation (anchoring, availability, confirmation, sunk cost, shiny-object, premature optimization).
- State **what would change your recommendation** — if you cannot name it, the analysis is not falsifiable.
- Follow the **stopping rule**: stop when another hour of analysis is unlikely to change the decision.

## How to run

Load and follow in order:

1. `depth-and-calibration.md` — pick depth, arm the bias guards.
2. `context-discovery.md` — understand the problem and the system.
3. `question-escalation.md` — if load-bearing unknowns remain, stop & ask (batched, early). Never silently guess.
4. `gap-analysis.md` — 8 lenses; label every finding `BLOCKER / GAP / RISK / OPPORTUNITY / TRADE-OFF / OVER-ENGINEERING / OUT-OF-SCOPE`.
5. `impact-analysis.md` — blast radius, first- and second-order.
6. `solution-exploration.md` — alternatives + opportunity hunt + over-engineering check.
7. `tradeoff-analysis.md` — criteria, matrix, sensitivity, recommendation + WHY.
8. `scope-control.md` — `MUST / SHOULD / COULD / NOT NOW` + definition of done.
9. `verification-planning.md` — how we will know it works.

Fill the report using `templates/analysis-report.template.md`. See `examples/` for filled examples.

## Output contract

Deliver the full analysis report before touching code for any non-trivial request. Declare the depth level used and the confidence tags. For L3, include sensitivity analysis, pre-mortem, and a bias audit. Record every question asked or defaulted in a **decision log** (`question-escalation.md`) — no later phase may silently re-decide it.
