# Trade-off Analysis — Phase 5

Goal: compare candidates against **stated criteria** and make one recommendation with reasons — and with a falsifiable confidence. No vibes — criteria first.

## Steps

### 1. Fix the decision criteria *before* comparing

Pick 3–7 criteria that matter for *this* change and weight each 1–5. Typical candidates:
correctness · security · revocability · time-to-ship · maintainability · observability · migration cost · team familiarity · performance.

Justify the weights in one line each — a weight you can't justify is a bias hiding in the rubric.

### 2. Score each candidate

Score 1–5 per criterion with anchors (e.g., correctness: 5 = provably correct, 1 = known gaps). Keep the anchors consistent across candidates.

### 3. Sensitivity analysis (mandatory at L3, encouraged at L2)

For each high-weight criterion, ask: **"if this score flipped, would the recommendation change?"**
- If yes → that criterion is decisive; verify its score and its weight carefully.
- If no → the recommendation is robust to that input; say so.
- Output the list of flips that *would* change the answer. If nothing would change it, the analysis is unfalsifiable (see depth-and-calibration §3).

### 4. Steelman each rejected alternative

State the strongest case for each rejected candidate before rejecting it. If you can't state it convincingly, you don't understand it well enough to reject it.

### 5. Pre-mortem (L3)

Write: *"It's 6 months later, and this choice failed. Why?"* Then check whether the recommended plan defends against that story. If not, either strengthen the plan or change the recommendation.

### 6. Reversibility

How expensive is it to undo each candidate later? A reversible choice tolerates a faster decision; an irreversible one (migration, contract, data shape) earns more scrutiny. On a near-tie, prefer the more reversible option.

### 7. Recommend + confidence

Pick the recommendation and state:
- **WHY** in terms of the criteria (not vibes).
- **Confidence** (high/medium/low) with the basis for it.
- **What would change the recommendation** — the specific new information that would flip it. If you cannot name it, you have not actually decided; you have rationalized.

If any decisive criterion is the user's to own (business rule, risk appetite, budget, scope priority), **do not decide it** — route it to a DECISION question via `question-escalation.md` and mark the recommendation as *pending input*.

### 8. Name the sacrifice

Every recommendation gives something up. Name it explicitly — a recommendation without a named sacrifice is marketing, not analysis.

## Output

```text
DECISION CRITERIA (weights, justified)
- <criterion> (w=<n>) — <one-line justification>
...

COMPARISON MATRIX (1–5, anchors stated)
| Criterion (w) | A | B | C |
|---------------|---|---|---|
| correctness (5) | ... | ... | ... |
...

SENSITIVITY
- Flipping <criterion> <would / would not> change the answer.
- The changes that WOULD flip it: <...>

STEELMANS
- Strongest case for <rejected B>: <...> — and why it still loses: <...>

PRE-MORTEM (L3)
- Failure story: <...>
- Does the plan defend? <...>

REVERSIBILITY
- <per-candidate undo cost>

RECOMMENDATION
<chosen> — WHY (tied to criteria). Confidence: <high/med/low>.
What would change this call: <specific new info>.

WHAT WE GIVE UP
- <named sacrifice>

REJECTED ALTERNATIVES
- <candidate> — rejected because <reason>
```

## Rules

- No recommendation without criteria.
- No recommendation without a named sacrifice.
- No recommendation without a stated falsifier ("what would change this call").
- Near-ties default to the simpler option (Occam) and the more reversible option.
- A comparison matrix whose scores don't vary is either degenerate (you didn't explore) or wrong (you found the same solution twice) — go back to phase 4.
