# Solution Exploration — Phase 4

Goal: generate genuine alternatives — including the requester's proposal — and hunt for opportunities. Ask in **both** directions: *"is there something better?"* **and** *"are we doing too much?"*.

## Mandate

- At least 2–3 alternatives for anything non-trivial, always including:
  - the **minimal** thing (smallest change satisfying the MUSTs), and
  - **do-nothing / defer** (accept current behavior, or wait for a trigger) where legitimate.
- The requester's proposed approach is **one candidate, not the default**.
- Every candidate: pros (`+`), cons (`-`), rough cost, fit to architecture, and an **over-engineering verdict**.

## Generation techniques (use to force alternatives when stuck)

1. **Baseline / minimal** — smallest change that satisfies the MUSTs. Always present.
2. **Do-nothing / defer** — accept current behavior; define the trigger that would make us act later.
3. **Inversion** — "what if we were not allowed to change X?" or "what if we solved the opposite problem?"
4. **Constraint-removal** — "if we couldn't add a table / endpoint / dependency, what would we do?"
5. **Buy vs build** — is there an existing library, service, or in-house component that already does 80% of this?
6. **Simplification** — what could we *delete* instead of add? (A removal is a valid solution.)
7. **Standard pattern** — how does the industry/stack solve this idiomatically? (Boring is a feature.)

**Forced-alternative prompts (L3):**
- "If we had to ship today with zero new infrastructure…"
- "If we had unlimited time…" (then ask what of that is actually worth having)
- "If we could change only one file…"

## Genuine-alternative test

An alternative must differ on **at least one decision criterion** (from phase 5). Cosmetic variations (same design, different naming) do not count as alternatives — merge them. If you cannot name a second genuine alternative, you have not explored.

## Opportunity hunting

An opportunity is a better way at reasonable cost. Examples:
- A clean abstraction that unlocks future work cheaply (e.g., an `ExportProvider` interface).
- Reuse of an existing pattern instead of a new parallel one.
- A small structural split (e.g., `ReportDataModel` vs `ExcelRenderer`) that pays off without building a framework.

**Opportunity grading rubric** (score 1–5 each):

| Dimension | Question |
|-----------|----------|
| Value | How much does this help a real consumer, now or very soon? |
| Cost | How expensive to build/maintain? (5 = cheap) |
| Risk | How likely to introduce bugs/complexity? (5 = low risk) |
| Relevance | How directly does it serve the current goal? |

Pursue if **value + relevance ≥ 8** and **risk ≥ 3** and **cost ≥ 3** (i.e., high value/relevance, low risk, low cost). Otherwise, it is either OVER-ENGINEERING or OUT-OF-SCOPE — put it on the watchlist.

## Over-engineering check (apply to every candidate, including opportunities)

Red-flag checklist — if any item is true, the design is suspect:

1. No concrete near-term consumer exists.
2. "We might need it someday."
3. Configuration/options nobody asked for.
4. An abstraction with exactly one implementation.
5. A framework built for a single use case.
6. Generalizing before two concrete examples exist.
7. "While we're in here…"
8. Speculative extensibility (plugin points with no plugin).
9. More tables/fields/endpoints than the requirement asks for.
10. Test scaffolding bigger than the feature.

Default rule: build the abstraction when the **second concrete need** appears, not before. A small split today (data model vs renderer) is usually the sweet spot between hard-coding and a framework.

## Output

```text
ALTERNATIVES
A. <name> — <one-line summary>
   + <pro>   − <con>
   cost: <...>   fit: <...>
   over-engineering verdict: <ok / watch / yes, because ...>

B. <name> — ...
C. <name> — ...

OPPORTUNITIES FOUND
- [OPPORTUNITY] <idea> — value=<n> cost=<n> risk=<n> relevance=<n> → pursue / watchlist

EXPLICITLY NOT DOING (for now)
- <idea> — why not (no consumer yet / cost > benefit / out of scope)
```

## Rules

- Include the requester's proposed approach as **one candidate, not the default**.
- A candidate list without an over-engineering verdict is incomplete.
- Do not present a solution without at least one alternative — even a weak alternative forces honest comparison.
- Watch for false dichotomy (bias #8): if only two options appear, force a third.
- Prefer the boring, proven option unless the rubric says otherwise (bias #5).
