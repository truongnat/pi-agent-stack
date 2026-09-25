# Solution Intelligence — Quick Reference

## Two hard rules
1. **Never implement the first plausible solution** before context, alternatives, impacts, scope.
2. **Do not expand scope merely because an improvement is possible** — justify value/cost/risk/relevance.

## Pipeline
`context-discovery → ⏸ stop & ask (question-escalation) → gap-analysis → impact-analysis → solution-exploration → tradeoff-analysis → scope-control → verification-planning`

## Stop & ask (question-escalation)
Ask **early** (end of context-discovery), **batched** (≤5, one message), only what passes the **leverage test**:
1. answer changes the outcome · 2. can't self-serve from code/docs · 3. no clearly-better option · 4. user-owned or genuinely ambiguous.

Classes: **BLOCKING** (must ask — never guess) · **DECISION** (user owns the trade-off; give options + recommendation) · **VERIFICATION** (confirm a fact) · **PREFERENCE** (default + note).

Never silently guess — deferred questions become `[assumed]` defaults with a **revisit trigger**. BLOCKING with no answer → stop, list what's blocked.

**Ownership:** agent decides correctness/structure/conventions/tests; user decides business rules, risk appetite, scope priorities, irreversible commitments, budgets.

## Depth levels
- **L1** fast pass — trivial, unambiguous, low blast radius (say "fast pass applied").
- **L2** standard — default; all 7 phases once.
- **L3** deep — escalation signal present: adds second-order impacts, sensitivity, pre-mortem, bias audit, migration/concurrency/security depth, confidence tags.

### Escalate to L3 on any of:
money · auth/secrets/tenant-isolation · irreversible ops · live data migration · concurrency/shared state · cross-team contract · compliance/privacy · scale · regression-prone area.

## 8 lenses (gap-analysis)
Requirement · Context · Architecture · Data · Security · UX/API · Operations · Testing

## 7 classification labels
`BLOCKER` (must fix or wrong) · `GAP` (missing info, get it now) · `RISK` (persistent uncertainty, manage/accept) · `OPPORTUNITY` (better way, net-positive now) · `TRADE-OFF` (both sides defensible, decide) · `OVER-ENGINEERING` (someday-maybe) · `OUT-OF-SCOPE` (related but separate)

### Hard distinctions
- GAP vs RISK → resolvable now? GAP. Persists? RISK.
- OPPORTUNITY vs OVER-ENGINEERING → concrete near-term consumer + net-positive now? OPPORTUNITY. Someday? OVER-ENGINEERING.
- BLOCKER vs TRADE-OFF → one side indefensible? BLOCKER. Real argument both ways? TRADE-OFF.

## Scope boundary (mandatory)
```
MUST   — traces to a BLOCKER/requirement · measurable DoD · effort S/M/L
SHOULD — desirable if cost stays low · DoD
COULD  — nice-to-have, only if trivial
NOT NOW — deferred + revisit trigger (never empty)
```

## Confidence tags
`verified` · `inferred` · `assumed` · `unknown` — tag every major claim; never present `assumed` as fact.

## Bias audit (before finalizing)
Anchoring · Availability · Confirmation · Sunk cost · Shiny-object · Premature optimization · Overconfidence · False dichotomy · Survivor · Groupthink/authority.

## Thinking-hard moves
Steelman the opposite · name what would make it wrong · second-order "and then what?" (max 2) · pre-mortem · invert the problem · Chesterton's fence · negative space ("what didn't they ask for?").

## Stopping rule
Stop when: BLOCKERs resolved/accepted · recommendation insensitive to remaining unknowns · scope bounded · bias audit done. (Another hour won't change the call.)

## Report skeleton
1 Request+context → ⏸ questions & decisions → 2 Gaps (labeled) → 3 Impact (+second-order) → 4 Alternatives (+over-eng verdicts) → 5 Trade-offs (criteria, matrix, sensitivity, confidence, sacrifice) → 6 Scope (MUST/SHOULD/COULD/NOT NOW + DoD + kill criteria) → 7 Verification (acceptance map + plan + rollback) → 8 Open questions.
