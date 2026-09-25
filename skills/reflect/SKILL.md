---
name: reflect
description: >
  Reconstructs full context and scans for related/surrounding issues before acting
  on a short, low-context follow-up message ("fix it", "do it", "ok", "go ahead",
  "fix đi", "làm đi", "sửa đi", "tiếp tục", a single emoji, a one-line confirmation).
  Runs silently as a reflex, not a gate — it does not block on approval the way
  /remake does. Use proactively, every turn, whenever the next user message is short
  and depends on prior conversation for its meaning, especially mid-debugging or
  mid-fix, to stop scope from narrowing to only the literal words typed and prevent
  incomplete fixes, missed callers, missed sibling bugs, and unverified assumptions
  that get built on for a long time before failing.
argument-hint: "[nothing — this runs automatically on the next terse message]"
---

# Reflect

A terse message ("fix it", "do it", "ok") is not the task. It is a pointer into
everything already said. The literal words are the smallest part of what the
user means; the rest is in the conversation, the codebase, and what a careful
engineer would check around the edges of the literal ask. Losing that context
is not a comprehension failure — it is a **framing** failure: the terse message
gets treated as if it were the whole spec, and the agent optimizes for "did the
literal words happen" instead of "is the actual problem gone, everywhere it
lives."

This skill is the reflex that catches the framing failure before it produces
five hours of confident work on the wrong-sized scope.

## When this fires

Every turn, silently check: is the message short (roughly under ~8 words), and
does its meaning depend on something said earlier (a bug, a finding, a plan, a
"should I") rather than standing alone? If yes, run the protocol below *before*
taking any action — before the first tool call, not after.

Do **not** fire on:
- A message that is short but self-contained ("what's 2+2", "list the files here")
- A message that already restates the target explicitly ("fix the null check in `auth.ts:42`")
- Pure social filler with no pending task ("thanks", "lol", "nice") when nothing is queued

The line: if you'd have to scroll up to know what "it" refers to, this fires.

## Protocol

### 1. Name the referent

State, to yourself, in one line: what specifically does "it" / "this" / the
implied task refer to? Anchor it — file, function, error message, or decision
— not a paraphrase of the vague word. If two different things in the recent
conversation could plausibly be "it," that's a real ambiguity: ask, don't guess
(one short question, not a list of options nobody asked for).

### 2. Separate what's known from what's assumed

Everything the plan is about to depend on falls into exactly one of two piles:
- **Verified**: you read the file, ran the command, saw the output.
- **Assumed**: inferred, remembered from earlier, or "probably works like the
  similar thing over there."

Anything in the assumed pile that the fix's correctness actually depends on
gets verified now, cheaply, before it's built on — not discovered three steps
later after a wrong turn. (Concrete failure mode this closes: assuming a header
value, a file path, or a config key matches convention instead of grep-ing the
one place that defines it.)

### 3. Blast-radius scan, before narrowing

Before writing the narrow fix, spend one grep/search pass on the surrounding
territory the literal request doesn't mention:
- Other callers of the function/pattern being touched — does the same bug live
  in siblings? (This is ponytail's root-cause rule, generalized past code: it
  applies to config, templates, infra, docs the same way.)
- Anything the fix could shift sideways — layout, pagination, a shared style,
  a cache, a default — that isn't the thing being fixed but sits next to it.
- Whether "fix it" plausibly means "fix this one instance" or "fix the class of
  thing" — when unclear, say which one you're doing before doing it, in one
  line, not a paragraph.

Skip this scan only when the referent from step 1 is already known to be fully
isolated (a one-line typo, a copy edit) — don't run a five-minute search ritual
on trivial asks.

### 4. State the expanded scope in one line, then act

Before the first tool call, say what you're about to do in a form that shows
the reconstructed scope, not just the literal words — one line, not a plan
document, not a gate to wait on:

> "Fixing X in `file.ts`; also checking Y and Z since they share the pattern."

If the scope you just stated is wrong, the user corrects it *before* the work
happens, not after. This is the cheapest point in the whole loop to catch a
wrong assumption about size.

### 5. Before declaring done, check the scan actually closed

Don't report done on "the literal words are satisfied." Report done on: the
referent from step 1 is fixed, the blast-radius items from step 3 were each
either fixed or explicitly named as out-of-scope (not silently dropped), and
anything left assumed-not-verified from step 2 is flagged, not buried.

## Boundaries

- This is a framing reflex, not a stall tactic. Steps 1-3 together should cost
  seconds to low minutes for most terse asks, not a research project. The goal
  is to not skip them, not to maximize time spent on them.
- Real ambiguity still gets one short question (per the harness's own guidance)
  — this skill does not replace asking, it reduces how often asking is needed
  by doing the cheap reconstruction work first.
- Pairs with [[ponytail]] (root cause vs. symptom, once scope is known) and
  [[remake]] (when the user wants the rewritten prompt shown and approved
  before anything runs — remake is the heavier, explicit version of step 1+4).
