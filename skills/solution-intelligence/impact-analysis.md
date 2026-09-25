# Impact Analysis — Phase 3

Goal: map the blast radius of each candidate change across the system. Know what breaks, who notices first, and what breaks *because* something broke.

## Impact areas to sweep

Security · Architecture · Database · API contract · Frontend · Backward compatibility · Observability · Testing · Operations

## Severity rubric (apply consistently)

| Level | Definition |
|-------|------------|
| Critical | Data loss/corruption, security breach, downtime, money loss. |
| High | Breaks a core flow for many users; manual workaround needed; on-call pages. |
| Medium | Degraded UX, extra support load, accruing tech debt. |
| Low | Cosmetic, contained, easily reversible. |

## For each area, ask

- What changes here? What breaks?
- Who notices **first**? (consumer, user, on-call, another team)
- Direct (caused by the change) or indirect (knock-on)?
- Severity × likelihood.
- Reversible or not?

## Second-order thinking (L2 always, deeper at L3)

For each direct impact, ask **"and then what?"** once or twice, then stop:

```
Direct:  refresh token table grows without bound
Second:  → queries degrade → auth latency rises → login/refresh timeouts at scale
```

Map the **cascade**, not just the first hit. Rule: chase the chain only while it stays *plausible and material*; stop before speculation.

## Coupling analysis

- **Fan-in:** what depends on the touched code? (Who breaks if I change this?)
- **Fan-out:** what does the touched code depend on? (What breaks me if it changes?)
- High fan-in + breaking change = the most dangerous quadrant — flag it.

## Data lineage (when data is touched)

- Who writes this data, who reads it, who transforms it?
- What is downstream of this data (reports, exports, sync jobs, caches)?
- A schema change that breaks a reader you didn't know about is the classic second-order surprise.

## Time dimension

- **Immediate:** deploy-time breakage (migration locks, missing columns, contract mismatch).
- **Delayed:** data drift, cost creep, debt accrual, index bloat, runbook rot. Delayed impacts are the ones that escape review — name them explicitly.

## People & process impacts

- On-call: new pages? new runbook steps?
- Support: new ticket types?
- Docs: what documentation becomes wrong?
- Other teams: whose timeline or contract changes?

## Output

```text
IMPACT MATRIX
| Area | What changes / breaks | Severity | Likelihood | Reversible? |
|------|----------------------|----------|------------|-------------|
| ...  | ...                  | ...      | ...        | yes/no      |

SECOND-ORDER CASCADE
- <direct impact> → <second-order effect> → <third if material>

COUPLING
- Fan-in (who depends on this): <...>
- Fan-out (what this depends on): <...>
- Dangerous quadrant (high fan-in + breaking): <...>

DATA LINEAGE (if applicable)
- Writers / readers / transformations / downstream consumers: <...>

TIME DIMENSION
- Immediate: <...>
- Delayed: <...>

BREAKING CHANGES (consumers will notice)
- <...>

ROLLBACK SURFACE (what must be reversible, and how)
- <...>

CROSS-CUTTING CONCERNS (touch many areas at once)
- <e.g. auth, tenant isolation, time/timezones, money, ids>
```

## Rules

- An impact you cannot name a consumer for is not an impact.
- If backward compatibility breaks, call it out explicitly — never silently.
- Prefer naming the *first observable symptom* (what the user/on-call actually sees), not just the internal mechanism.
- Every Critical/High impact needs a response in scope-control (mitigation, flag, or accepted).
- Do not inflate likelihood to look thorough — that's bias #7 (overconfidence) in reverse. Use the confidence taxonomy where evidence is thin.
