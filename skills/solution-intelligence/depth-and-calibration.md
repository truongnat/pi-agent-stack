# Depth & Calibration — meta-layer

This file governs *how hard to think*. The phase files say *what* to do; this file says *how deep*, *when deeper*, and *what traps to avoid*. Read it first.

## 1. Depth levels

| Level | When | What it adds | Output size |
|-------|------|--------------|-------------|
| L1 Fast pass | Trivial, unambiguous, low blast radius | context (2–3 bullets), one-line gap check, one-line scope | a few lines |
| L2 Standard | Default for a real feature/bug | all 7 phases, one pass | full report |
| L3 Deep | Escalation signal present | second-order impacts, sensitivity analysis, pre-mortem, bias audit, migration/concurrency/security depth, confidence per claim | full report + depth addenda |

Escalation signals (any one → L3):

1. Money, payments, billing.
2. Auth, permissions, secrets, tenant isolation.
3. Irreversible operations (destructive migration, deletion, breaking API).
4. Data migration / schema change on live data.
5. Concurrency / shared mutable state (races, double-spend, counters, sessions).
6. Cross-team or cross-service contract change.
7. Compliance, legal, privacy surface.
8. Performance/scale beyond current load.
9. The area has a history of regressions.

## 2. Confidence taxonomy

Tag every major claim in the report:

- `verified` — confirmed by code, docs, tests, or the user.
- `inferred` — deduced from strong evidence, not directly confirmed.
- `assumed` — plausible, unconfirmed; treat as a risk until checked.
- `unknown` — genuinely open; becomes a GAP or an Open Question.

Rules:

- Never present an `assumed` claim as fact.
- A load-bearing `assumed` claim is a defect of the analysis — promote it to an Open Question.
- The recommendation may rest on `inferred` claims, but not on `assumed` ones without flagging the dependency.

## 3. Thinking-hard protocols

Apply as depth rises. Each is a concrete move, not a slogan.

- **Steelman the opposite.** Argue the strongest case *against* your current recommendation. If you can't beat it, you don't understand it yet.
- **Ask "what would make this wrong?"** For every load-bearing claim, name the observation that would falsify it. If none exists, the claim is unfalsifiable and shouldn't drive a decision.
- **Second-order thinking.** For each direct impact, ask "and then what?" — but only once or twice, then stop (infinite regress is a trap).
- **Pre-mortem.** "It's 6 months later, this failed. Why?" Write the failure story first; then check whether the plan defends against it.
- **Invert the problem.** "What would we do if we were *not allowed* to change X?" Reveals hidden dependencies.
- **Trace the fences.** For any existing structure you'd remove or change, ask why it was put there (Chesterton's fence). Do not remove what you don't understand.
- **Check the negative space.** What did the request *not* mention that it arguably should? (e.g., a new endpoint with no rate limiting.)

## 4. Bias checklist — audit before finalizing

Run through this list before locking a recommendation. Name any bias that is active, and re-examine the affected step.

1. **Anchoring** — is the requester's first proposal weighting the alternatives unfairly? (It should be one candidate, not the default.)
2. **Availability** — is a recent incident or a vivid example distorting likelihood estimates?
3. **Confirmation** — are you only collecting evidence that supports the early favorite?
4. **Sunk cost** — is an existing investment being defended rather than evaluated?
5. **Shiny-object** — is a novel technology being favored over a boring, proven one?
6. **Premature optimization** — optimizing something before it's measured or before it's a bottleneck.
7. **Overconfidence** — are severity/likelihood stated with more certainty than evidence allows? (Use the confidence taxonomy.)
8. **False dichotomy** — are alternatives presented as A-or-B when a C exists? (Force a third option.)
9. **Survivor bias** — are you judging from successes only, ignoring what failed in similar situations?
10. **Groupthink / authority** — is a choice being kept because a senior person said so, not because it survives scrutiny?

## 5. Anti-patterns (both directions)

Under-thinking:
- Jumping to code before context.
- Presenting one solution with no alternative.
- Missing a BLOCKER because a lens was skipped.
- Treating an assumption as fact.

Over-thinking:
- Running the full ceremony on a trivial task (use L1).
- Infinite second-order regress ("and then what?" forever).
- Demanding certainty that doesn't exist (some things are RISK, not GAP).
- Analysis paralysis: re-analyzing instead of deciding. Analysis is complete when the decision is made; the report is the evidence, not the goal.

## 6. Stopping rule

**Stop when another hour of analysis is unlikely to change the decision.** Concretely:

- All BLOCKERs are resolved or explicitly accepted.
- The recommendation is insensitive to the remaining unknowns (a sensitivity check confirms it).
- The scope is bounded (MUST/SHOULD/COULD/NOT NOW are non-empty and justified).
- The bias audit is clean or its findings are acknowledged.

If any of the four is false, keep going. If all four are true, stop — further thinking is now a cost, not a benefit.
