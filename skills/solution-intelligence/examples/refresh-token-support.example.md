# Solution Analysis — Add refresh token support

> Worked example (feature pipeline). Shows the full report filled in.

## 1. Request (context-discovery)

REQUEST (restated)
Extend authentication so clients can obtain new access tokens without re-entering credentials, while keeping sessions revocable and tenant-safe.

TYPE: feature

CURRENT CONTEXT
- NestJS backend, JWT authentication via existing auth plugin.
- Multi-tenant architecture (tenant isolation is a first-class concern).
- Current access token lifetime = X (short-lived).
- No refresh token persistence, rotation, or revoke strategy exists today.

CONSUMERS AFFECTED
- Mobile/web clients using the auth API.
- On-call + security team (revoke / breach response).
- Each tenant's session behavior.

ASSUMPTIONS (unverified)
- Clients can store a token securely (not confirmed for web).
- One access token per user per device is acceptable (not confirmed).

UNKNOWNS / QUESTIONS TO RESOLVE
1. Should refresh tokens be per-device or per-user?
2. What happens to sessions when the password changes?
3. What happens to sessions when a user switches tenant?
4. Expired-token cleanup strategy (job vs lazy)?

## 2. Gaps & Hidden Impacts (gap-analysis)

| Class | Lens | Finding | Consequence if ignored |
|-------|------|---------|------------------------|
| BLOCKER | Data | No persistence strategy for refresh tokens | Cannot revoke or inspect sessions |
| BLOCKER | Security | No revoke strategy defined | Compromised tokens live forever |
| GAP | Requirement | Token rotation policy undefined | Reuse attacks undetected |
| GAP | Requirement | Multi-device session semantics undefined | Ambiguous UX + session count |
| GAP | Requirement | Behavior on password change undefined | Stolen-token window after reset |
| GAP | Requirement | Tenant-switch behavior undefined | Cross-tenant session leakage risk |
| RISK | Operations | No cleanup for expired tokens | Unbounded table growth |
| OPPORTUNITY | Architecture | A small `TokenStore` interface keeps auth plugin swap-friendly | Cheap now, avoids lock-in |
| TRADE-OFF | Security | Stateless vs stored refresh tokens | Revocability vs simplicity |
| OUT-OF-SCOPE | Operations | Full session-management dashboard | Belongs to a later ops milestone |

OVER-ENGINEERING WATCHLIST
- Generic "session federation" framework — no consumer today, defer.

## 3. Impact (impact-analysis)

| Area | What changes / breaks | Severity | Likelihood |
|------|----------------------|----------|------------|
| Security | Token lifecycle now persisted; revoke path added | high | med |
| Database | New refresh_token table + index | med | high |
| API contract | New `/refresh`, `/logout` (breaking: clients must add calls) | med | high |
| Frontend | Token-refresh loop in clients | med | high |
| Backward compat | Old access tokens still valid until expiry | low | high |
| Observability | Add metrics: refresh rate, reuse detection | med | low |
| Testing | Auth test matrix grows | med | high |
| Operations | Cleanup job + rollback plan for auth | med | med |

BREAKING CHANGES
- Clients must implement the refresh flow; purely JWT-only clients will keep working until tokens expire.

ROLLBACK SURFACE
- Refresh endpoint can be disabled by flag; table can be truncated (forces re-login, acceptable).

CROSS-CUTTING CONCERNS
- Tenant isolation (every token row keyed by tenant).
- Time (expiry math across TZ).

## 4. Alternatives (solution-exploration)

A. Stateless refresh JWT
   + simple, no DB access   − hard revoke, weak session management
   cost: low   fit: partial (revoke requirement fails)
   over-engineering verdict: n/a — under-solves the revoke BLOCKER.

B. Stored opaque refresh token
   + good revoke, good device/session management   − adds persistence
   cost: med   fit: good
   over-engineering verdict: ok.

C. Rotating refresh token (B + rotation)
   + best security, detects reuse   − more complex implementation
   cost: med-high   fit: good
   over-engineering verdict: watch — rotation is justified only because reuse-detection is a real requirement; skip device-naming UI.

OPPORTUNITIES FOUND
- `TokenStore` interface behind the auth plugin — value: swap/upgrade later; cost: tiny; risk: none; relevance: direct.

EXPLICITLY NOT DOING (for now)
- Device naming UI — no requirement yet.
- Geo/IP session tracking — no requirement, privacy cost.

## 5. Trade-offs (tradeoff-analysis)

DECISION CRITERIA (weights)
- Revocability (high), security/reuse-detection (high), implementation cost (med), DB load (low).

COMPARISON MATRIX
| Criterion | A | B | C |
|-----------|---|---|---|
| revocability | low | high | high |
| reuse detection | none | none | yes |
| implementation cost | low | med | med-high |
| DB load | none | med | med |

REVERSIBILITY
- A→C is additive; C→A requires migration. C is a superset of B, so starting at C is safe.

RECOMMENDATION
B + rotation (C), implemented through a `TokenStore` interface. WHY: it satisfies both BLOCKERs (revoke + reuse detection), fits the existing multi-tenant auth plugin, and the abstraction cost is minimal.

WHAT WE GIVE UP
- The absolute simplicity of stateless tokens (accepting a DB write per refresh).

REJECTED ALTERNATIVES
- A — fails the revoke BLOCKER.

## 6. Scope Boundary (scope-control)

MUST
- Refresh token persistence + revoke + expiration + tests.

SHOULD
- Rotation (reuse detection) + logout-all-devices.

COULD
- Device naming UI.

NOT NOW
- Complete session management dashboard; geo/IP session tracking.

## 7. Verification Plan (verification-planning)

| Scenario | Expected result | How | Closes |
|----------|-----------------|-----|--------|
| happy path: refresh | new access token issued | integration | GAP-rotation |
| revoke | token rejected on next use | integration | BLOCKER-revoke |
| reuse detection | old token reuse flags + revokes family | integration | GAP-rotation |
| password change | all refresh tokens invalidated | unit | GAP-password |
| tenant switch | sessions scoped per tenant | integration | GAP-tenant |
| concurrency: parallel refresh | exactly one family survives | integration | RISK-cleanup |
| cleanup | expired rows removed | unit | RISK-cleanup |
| regression | old JWT-only clients unaffected | e2e | — |

REVIEWER CHECKLIST
- Token table keyed by tenant; expiry indexed; no plaintext tokens in logs.

ROLLBACK VERIFICATION
- Disable `/refresh` via flag → clients fall back to re-login; truncate table → no crash.

## 8. Open Questions
- Password-change invalidation: revoke all vs revoke-others? (pending product call)
