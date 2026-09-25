# Solution Analysis — [title]

> Blank report. Fill one section per phase. Labels come from the fixed taxonomy; confidence tags from the calibration taxonomy.

## 0. Depth & calibration
- Depth level: L1 / L2 / L3
- Escalation signals present: <list or none>
- Bias audit result: <which biases active, and how they were countered>

## 1. Request (context-discovery)

REQUEST (restated)
<one paragraph — outcome vs solution noted>

TYPE: bug | feature | refactor | idea

CURRENT CONTEXT
- Stack/runtime: <...>
- Architecture: <...>
- Touchpoints (modules/files/tables): <...>
- Prior art: <...>
- Recent changes: <...>
- Failure history: <...>

CONSTRAINTS
- Hard: <...>   Soft: <...>   Implicit: <...>

CONSUMERS & STAKEHOLDERS
| Party | What they care about |
|-------|----------------------|
|       |                      |

ASSUMPTIONS (with confidence tag)
- [assumed] <...>
- [inferred] <...>

UNKNOWNS / QUESTIONS (ordered by leverage)
1. <...> — answerable by <who/what>

## 1b. Stop & Ask (question-escalation)

NEED INPUT (blocking / decision / preference / verification)
Q1. <question> — Context: <1 line> · Options: a/b/c · Recommendation: <...> · If wrong: <cost>

DEFERRED DEFAULTS (won't ask; assumed)
- <question> → default <X> [assumed] · revisit if <trigger>

DECISION LOG
| Q# | Answer / default | Used in |
|----|------------------|---------|
|    |                  |         |

## 2. Gaps & Hidden Impacts (gap-analysis)

| Class | Lens | Finding | Consequence if ignored | Sev × Lik (for RISK) |
|-------|------|---------|------------------------|----------------------|
| BLOCKER | | | | |
| GAP | | | | |
| RISK | | | | |
| OPPORTUNITY | | | | |
| TRADE-OFF | | | | |
| OUT-OF-SCOPE | | | | |

SECOND-ORDER GAPS
- <...>

NEGATIVE SPACE
- <...>

OVER-ENGINEERING WATCHLIST
- <...>

## 3. Impact (impact-analysis)

| Area | What changes / breaks | Severity | Likelihood | Reversible? |
|------|----------------------|----------|------------|-------------|
|      |                      |          |            |             |

SECOND-ORDER CASCADE
- <direct> → <second> → <third if material>

COUPLING (fan-in / fan-out / dangerous quadrant)
- <...>

DATA LINEAGE (if applicable)
- <...>

TIME DIMENSION (immediate / delayed)
- <...>

BREAKING CHANGES
- <...>

ROLLBACK SURFACE
- <...>

CROSS-CUTTING CONCERNS
- <...>

## 4. Alternatives (solution-exploration)

A. <name> — <one-line summary>
   + <pro>   − <con>
   cost: <...>   fit: <...>
   over-engineering verdict: <ok / watch / yes, because ...>

B. <name> — ...

OPPORTUNITIES FOUND
- <idea> — value=<n> cost=<n> risk=<n> relevance=<n> → pursue / watchlist

EXPLICITLY NOT DOING (for now)
- <idea> — why not

## 5. Trade-offs (tradeoff-analysis)

DECISION CRITERIA (weights, justified)
- <criterion> (w=<n>) — <justification>

COMPARISON MATRIX (1–5)
| Criterion (w) | A | B | C |
|---------------|---|---|---|
|               |   |   |   |

SENSITIVITY
- Flipping <criterion> <would / would not> change the answer.

STEELMANS
- Strongest case for <rejected>: <...> — why it still loses: <...>

PRE-MORTEM (L3)
- Failure story: <...>   Does the plan defend? <...>

REVERSIBILITY
- <...>

RECOMMENDATION
<chosen> — WHY. Confidence: <high/med/low>. What would change this call: <...>

WHAT WE GIVE UP
- <...>

REJECTED ALTERNATIVES
- <candidate> — because <reason>

## 6. Scope Boundary (scope-control)

MUST
- <item> — why now · DoD: <measurable> · effort: S/M/L

SHOULD
- <item> — why · DoD: <measurable> · effort: S/M/L

COULD
- <item> — why · DoD: <measurable> · effort: S/M/L

NOT NOW
- <item> — why deferred · revisit trigger: <...>

SEQUENCING & DEPENDENCIES
- <...>

KILL CRITERIA / STOP CONDITIONS
- <...>

## 7. Verification Plan (verification-planning)

ACCEPTANCE MAP (MUST → measurable check)
| MUST item | Measurable check |
|-----------|------------------|
|           |                  |

VERIFICATION PLAN
| Scenario | Expected result | How | Closes |
|----------|-----------------|-----|--------|
| happy    |                 |     |        |
| error    |                 |     |        |
| edge     |                 |     |        |
| regression |               |     |        |
| concurrency |              |     |        |
| security/abuse |            |     |        |
| migration |                |     |        |

PROPERTY-BASED INVARIANTS
- <...>

OBSERVABILITY TO ADD
- Metrics: <...>   Logs: <...>   Alerts: <...>

REVIEWER CHECKLIST
- <...>

ROLLBACK VERIFICATION
- <...>

## 8. Open Questions
- <...>
