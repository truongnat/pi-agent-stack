# Question Escalation — Stop & Ask

Purpose: define **exactly when the agent must pause and ask the user**, and how — so it neither guesses on load-bearing decisions nor pesters with trivia. This is the guard against the second failure mode: *confident wrongness from silent assumptions*.

## When this fires

- Primarily at the **end of context-discovery** (phase 1), once unknowns are listed.
- Again on any **loop-back** that invalidates an earlier answer (re-ask, never re-interpret).
- Any phase that hits a **user-owned decision** it cannot safely default (see ownership matrix) stops and asks.

## The Leverage Test — the only gate for asking

Before asking, every candidate question must pass **ALL** four gates:

1. **Outcome-changing** — the answer changes the design, the scope, or the recommendation. (If not → decide and note the assumption.)
2. **Not self-serveable** — the answer is NOT in code, docs, tests, git history, or a quick experiment. (Never ask the user what the code already tells you.)
3. **Not one-sided** — there is no clearly better option. (If there is → recommend it; don't ask "what do you prefer".)
4. **User-owned or genuinely ambiguous** — the call belongs to the user (business, posture, budget) or is a true coin-flip with real consequences.

Fail any single gate → **don't ask**. Decide or default.

## Question classes

| Class | Definition | Must ask? | Example |
|-------|-----------|-----------|---------|
| **BLOCKING** | Design diverges wildly by answer; wrong guess = large rework | Yes — never guess | "Is backward compatibility a hard promise?" |
| **DECISION** | A genuine TRADE-OFF the user owns (business / security posture) | Yes — with options + recommendation | "Rotation on/off? revoke-all vs revoke-others?" |
| **VERIFICATION** | Confirm a fact you cannot verify yourself | Yes — one-liner | "Does this report include tenant B's data by design?" |
| **PREFERENCE** | Style/scope taste, low stakes | No — default + note (batch only if under the cap) | "Naming, log level, API-first vs UI-first" |

## Ownership matrix — who decides what

**Agent decides** (don't ask unless genuinely pivotal):
- Correctness, code structure, test coverage, conventions.
- Bug-vs-feature classification.
- Anything the code/docs/tests already answer.

**User decides** (ask, or state an explicit reversible default):
- Business rules and acceptance criteria.
- Security posture / risk appetite ("is this risk acceptable?").
- Scope priorities — which SHOULDs are worth their cost.
- Irreversible commitments (destructive migration, breaking contract, data deletion).
- Budgets and deadlines ("this adds 2 days — OK?").

**Either** (state who decided): naming, tooling among equivalent options.

## Ask early, batched, capped

- **Ask at the first moment you know you need it** — end of context-discovery, *before* gap/impact/solution work. Asking after three phases wastes both sides.
- **Batch everything into one message.** Never drip-feed across turns.
- **Cap at ~5 questions.** Prioritize by leverage (outcome-changing × cost-of-wrong). The rest become deferred defaults.

## Deferred defaults — the anti-guessing rule

For every question you choose **not** to ask, record:
- the default you are assuming,
- why it is likely safe (reversible, convention, prior art),
- the **revisit trigger** (what would make you re-confirm).

A deferred question must appear in the report as an `[assumed]` default or an open question. **Silent guessing is forbidden** — the assumption must be visible and revisitable.

## Cost-of-wrong framing

Each BLOCKING/DECISION question is framed with the cost of a wrong answer, so the user can weigh answering vs deferring:

- "If wrong: <rework size / reverted decision>."

If the cost of a wrong answer is tiny and the default is reversible → it is a PREFERENCE; don't ask.

## Re-ask on discovery

A later phase can invalidate an earlier answer (e.g., impact analysis shows a "minor" choice is actually high-blast-radius). When that happens:

- Re-ask the specific question **with the new information**.
- Never silently reinterpret the user's earlier answer.

## If the user doesn't answer (or defers)

- Apply the deferred default, tag it `[assumed]`, and **proceed** — but state clearly that the analysis is conditional on that default.
- For BLOCKING questions with no answer: **do not fabricate.** Stop the analysis with the question outstanding and list exactly what is blocked.

## Anti-patterns (don't do these)

1. Asking what code/docs/tests already answer.
2. Asking "which do you prefer" when one option is clearly better.
3. Asking the user to do the design — bring options, not blank sheets.
4. Drip-feeding questions over many turns.
5. Asking yes/no on the agent's own job ("should I add tests?").
6. Re-asking something already answered.
7. Asking questions that fail the leverage test (answer won't change anything).

## Output format

```text
NEED INPUT (blocking / decision / preference / verification)
Q1. <question>
    Context: <one line>
    Options: a) ... b) ... c) ...
    My recommendation: <...> — because <one line>
    If wrong: <cost>

DEFERRED DEFAULTS (won't ask; assumed)
- <question> → default <X> [assumed] · revisit if <trigger>

DECISION LOG (kept in the report; never re-decided silently)
| Q# | Answer / default | Used in |
```

## Good vs bad ask (mini-example)

Bad (blank sheet, vague, no stakes):
> "How should I implement refresh tokens?"

Good (scoped, options, recommendation, cost):
> NEED INPUT (decision)
> Q1. On password change, should we revoke all sessions or all-but-current?
>     Context: determines invalidation scope in the token store.
>     Options: a) revoke-all  b) revoke-others
>     My recommendation: a) revoke-all — simpler and safer default for breach response.
>     If wrong: small (one-line change in the invalidation query).
