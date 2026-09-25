# Verification Planning — Phase 7

Goal: define how we will know the solution is correct — written with (or before) implementation, never after. Verification defines "done".

## Coverage map

Enumerate checks across:

- **Happy path** — the main flow works end to end.
- **Error paths** — invalid input, failures, missing dependencies.
- **Edge cases** — boundaries, empty, very large, unusual data.
- **Regression** — what used to work must keep working.
- **Concurrency** — wherever shared state, tokens, sessions, money, or counters exist.
- **Security / abuse** — negative cases, not just positive ones.
- **Migration** (L3 / when data changes) — backfill, rollback, double-run safety.
- **Performance/load** (when scale is an escalation signal) — the specific bound to hold.

## Acceptance mapping (mandatory)

Every `MUST` from scope-control maps to a **measurable check**. Every `BLOCKER`, `GAP`, and `RISK` from gap-analysis maps to at least one check — automated, manual, or observable. A RISK with no verification is unmanaged: add a check or write "accepted, not verified".

## Concurrency patterns to enumerate (when shared state exists)

- Read-modify-write (lost update).
- Duplicate submission (idempotency).
- Two actors on the same record (double-spend, double-consume).
- Partial failure mid-transaction.
- Retry storms after timeouts.
- Token/session reuse and replay.
- For each: name the interleaving, the expected outcome, and the test that locks it.

## Test-strategy notes

- Allocate across the pyramid: unit (logic/edge), integration (wiring), e2e (user-visible flows). Say where the riskiest checks live and why.
- **Property-based tests** for invariants (e.g., "revoked tokens never validate", "cleanup removes only expired rows") where the state space is large.
- **Non-determinism sources** (time, randomness, external calls) must be injectable/mocked — name them.
- **Fixtures/seeds** required, named explicitly.

## Observability checks (what we add to *see* it in production)

- Metrics: which counter/gauge/latency would prove it works or reveal failure?
- Logs: what must be logged (and what must never be, e.g., tokens).
- Alerts: which threshold pages on-call?

## Output

```text
ACCEPTANCE MAP (MUST → measurable check)
| MUST item | Measurable check |
|-----------|------------------|
| ...       | ...              |

VERIFICATION PLAN
| Scenario | Expected result | How (unit/integration/e2e/manual) | Closes |
|----------|-----------------|-----------------------------------|--------|
| happy    | ...             | integration                       | MUST-1 |
| error    | ...             | unit                              | RISK-1 |
| edge     | ...             | e2e                               | ...    |
| regression | ...           | e2e                               | ...    |
| concurrency | ...         | integration                       | ...    |
| security/abuse | ...       | integration                       | ...    |
| migration | ...            | integration                       | ...    |

PROPERTY-BASED INVARIANTS
- <invariant that must hold across many inputs>

OBSERVABILITY TO ADD
- Metrics: <...>   Logs: <...>   Alerts: <...>

REVIEWER CHECKLIST (what to look at in the diff)
- <...>

ROLLBACK VERIFICATION
- <how we prove rollback works and that it was exercised>
```

## Rules

- No finding may be left unverified without an explicit "accepted, not verified" statement.
- Concurrency is mandatory to consider wherever shared mutable state exists.
- A scenario with no observable expected result is not a scenario yet.
- Rollback is not "we think it works" — name the exercise that proves it.
