# Gap Analysis — Phase 2

Goal: find what is missing, ambiguous, or risky between the request and the system — across eight fixed lenses. This phase finds **bugs, gaps, risks, and opportunities** — not just problems. The deeper the probes, the fewer surprises later.

## The 8 lenses (summary)

| Lens | One-line mandate |
|------|------------------|
| Requirement | Is the requirement missing / ambiguous? |
| Context | How does the system already solve similar things? |
| Architecture | Does the change break a boundary or pattern? |
| Data | Schema / lifecycle / migration / consistency? |
| Security | Auth, permission, exposure, abuse, tenant isolation? |
| UX/API | How are consumers / users affected? |
| Operations | Deploy, logging, monitoring, rollback, cost? |
| Testing | Happy / error / edge / regression / concurrency? |

## Deep probes per lens (ask them all; escalate to L3 depth when a probe bites)

**Requirement**
- Stated as outcome or solution? (Solution-shaped = hidden intent.)
- Acceptance criteria defined and testable?
- What is explicitly out of scope? What is unstated?
- Who is the requester and what's their real goal?
- Non-functional requirements (perf, availability, cost, latency)?
- Any conflicting requirements? (e.g., "instant" vs "audited")

**Context**
- How does the system solve similar things today?
- What conventions/patterns must this follow?
- What does the code around the touchpoint actually do? (Read it.)
- Prior art in adjacent modules?
- What was recently refactored or added nearby?

**Architecture**
- Does the change cross a layer/boundary?
- Does it violate dependency direction?
- Does it duplicate an existing capability?
- Does it introduce a pattern inconsistent with the codebase?
- What would a *future* change to this area look like (does this help or hinder it)?

**Data**
- Schema changes? New entities/fields?
- Migration: reversible? backfill needed? live table?
- Lifecycle: created / updated / deleted / expired — all stages covered?
- Consistency: transactions, partial writes, races?
- Volume & growth: size, indexes, hot paths?
- Retention & cleanup?

**Security**
- AuthN/AuthZ: who can do this, who must not?
- Exposure: does it return more than needed?
- Abuse: how is it misused at scale? (enumeration, scraping, brute force)
- Secrets/tokens in logs, URLs, error messages?
- Tenant isolation: could tenant A see tenant B's data?
- Validation/injection boundaries?

**UX/API**
- Contract change: breaking or additive?
- Versioning strategy?
- Error semantics: what does the consumer see on failure?
- Backward-compatibility window?
- Discoverability/documentation?

**Operations**
- Deploy: migration order, zero-downtime?
- Logging/metrics/alerts to add?
- Rollback path — is it reversible?
- Feature flag needed to decouple deploy from release?
- Cost / latency / throughput impact?
- Runbook and on-call burden?

**Testing**
- Happy / error / edge / regression / concurrency coverage?
- What's hard to test here and why?
- Fixtures/seeds needed?
- Non-determinism sources (time, randomness, external calls)?

## Classification — every finding gets exactly one label

| Label | Meaning | Decision rule |
|-------|---------|---------------|
| **BLOCKER** | Must resolve or implementation is wrong/unsafe | One-sidedly wrong; no defensible alternative to resolving it. |
| **GAP** | Information/context missing | Answerable *now* by asking someone or investigating; unresolved it is a guess. |
| **RISK** | May cause future bug/incident | An uncertainty that *persists* (can't be resolved now); needs severity × likelihood + a mitigation or acceptance. |
| **OPPORTUNITY** | A better way at reasonable cost | Net value now positive; has a concrete near-term consumer; value/cost/risk/relevance all stated. |
| **TRADE-OFF** | No absolute answer | Both sides defensible; a decision is required; record the decision-maker. |
| **OVER-ENGINEERING** | Good idea, not worth doing now | Benefit speculative/future; no near-term consumer; cost now > benefit now. |
| **OUT-OF-SCOPE** | Related but separable | Note for later; explicitly excluded from this change. |

**Boundary rules (the hard distinctions):**

- **GAP vs RISK:** can you resolve it right now by asking/investigating? → GAP (go get it). Does uncertainty persist regardless? → RISK.
- **OPPORTUNITY vs OVER-ENGINEERING:** does a concrete near-term consumer exist and is net value positive *now*? → OPPORTUNITY. Is it "someday maybe"? → OVER-ENGINEERING.
- **BLOCKER vs TRADE-OFF:** is the alternative one-sidedly indefensible (e.g., shipping without revoke when revoke is a hard requirement)? → BLOCKER. Is there a real argument on both sides? → TRADE-OFF.
- **RISK vs OUT-OF-SCOPE:** does it threaten *this* change? → RISK (manage it). Is it a different project wearing a similar hat? → OUT-OF-SCOPE.

## Process

1. For each lens, run the probes against request + context.
2. Record every finding as one line: `[CLASS] <lens> — finding → consequence if ignored` + severity × likelihood for RISKs.
3. Separate `BUG` findings (why it broke) from `FEATURE` findings (what is missing/ambiguous).
4. **Second-order gaps (L3):** for each BLOCKER, ask "what does resolving this expose?" (e.g., adding persistence exposes a cleanup problem).
5. **Negative-space check:** what did the request *not* mention that it arguably should?
6. Sort so BLOCKERs come first — they gate everything.

## Output

```text
GAPS DISCOVERED
- [BLOCKER] Data — <finding> → consequence if ignored
- [GAP] Requirement — <finding> → consequence if ignored
- [RISK] Security — <finding> → consequence · severity=high · likelihood=med · mitigate=<...>
- [OPPORTUNITY] Architecture — <finding> → value/cost/risk/relevance
- [TRADE-OFF] Data — <finding> → decision needed · decision-maker=<...>
- [OUT-OF-SCOPE] Operations — <finding> → why it stays out

SECOND-ORDER GAPS (what resolving a BLOCKER exposes)
- <...>

NEGATIVE SPACE (what the request didn't mention but arguably should)
- <...>

OVER-ENGINEERING WATCHLIST
- <idea to note but NOT do, with one-line reason>
```

## Rules

- Label every finding. No unlabeled observations.
- Prefer `OPPORTUNITY` over silently adding scope — name the upside explicitly.
- A finding is **not** a task. Tasks come later, in scope-control.
- `OVER-ENGINEERING` exists to catch the good-but-premature idea. Use it aggressively when a 30-minute issue starts to look like a 3-day redesign.
- For each RISK, you must write a mitigation **or** an explicit "accepted" — an unmanaged risk is a defect of the analysis.
