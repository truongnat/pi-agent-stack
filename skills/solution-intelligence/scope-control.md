# Scope Control — Phase 6

Goal: convert the analysis into a **bounded** plan. The agent must see wide while implementing narrow. This is where over-engineering is finally killed.

## Output — Scope Boundary (mandatory)

```text
MUST
- <item> — why now · Definition of Done: <measurable> · effort: S/M/L

SHOULD
- <item> — why desirable · DoD: <measurable> · effort: S/M/L

COULD
- <item> — why nice · DoD: <measurable> · effort: S/M/L

NOT NOW
- <item> — why deferred · revisit trigger: <what would make us do it>
```

## Definition of Done per item

Every MUST gets a **measurable** DoD. "Implement refresh tokens" is not a DoD; "refresh endpoint issues a token; revoked token is rejected; expired rows are cleaned by a tested job" is. If you cannot write a measurable DoD, the item is still a wish, not a task.

## Sequencing & dependencies

- Order MUSTs so each step's DoD is verifiable before the next begins.
- Name dependencies between items ("revoke depends on persistence").
- Flag items that can be parallelized.

## Kill criteria / stop conditions

Define what would make you **halt or downscope mid-implementation**:
- A BLOCKER that turns out unsolvable within the change (e.g., migration can't be made reversible) → stop, re-scope, or escalate.
- A discovered risk that exceeds the accepted threshold → stop and re-analyze.
- Cost growing past a stated bound (e.g., "if this exceeds 2 days, drop the rotation feature").
- Scope creep observed (new "small" additions appearing) → freeze and re-run the boundary.

## Over-engineering gate

Re-apply the two hard rules to every item:

1. Any suggested improvement must justify its **value, cost, risk, and relevance** to the current goal.
2. Anything failing that justification moves to `NOT NOW` — or is dropped.

## Signals to cut (see them → move to NOT NOW)

- "We might need it someday."
- "While we're in here…"
- A framework/abstraction with no second concrete consumer.
- Gold-plating: more config, more options, more tables than the requirement asks for.
- An item whose DoD can't be stated measurably.

## Rules

- Every `MUST` traces to a `BLOCKER` or an explicit requirement — if it doesn't, it's a SHOULD at best.
- `NOT NOW` must not be empty for any non-trivial change. If you cannot name what you are leaving out, you have not bounded the scope.
- Every deferred item carries a **revisit trigger**, so "not now" is a decision, not a dodge.
- If the user explicitly asks for something the analysis flagged `OVER-ENGINEERING`, present the flag, then follow the user's call — the skill advises, the user decides.
- Ownership follows `question-escalation.md`: the agent decides correctness/structure/conventions; the user decides business rules, risk appetite, scope priorities, and irreversible commitments. When a MUST/COULD placement is a business call, ask rather than assume.
