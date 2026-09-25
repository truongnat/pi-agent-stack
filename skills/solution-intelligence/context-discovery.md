# Context Discovery — Phase 1

Goal: understand the problem and the surrounding system **before** proposing anything. No solutions here — only description and question. Depth of this phase sets the ceiling for everything after it.

## Trigger
Run first, always. Depth level: L1 for trivial, L2 default, L3 when escalation signals are present.

## Steps

### 1. Restate the request
Rewrite in your own words (one paragraph). Then check:
- Is it stated as an **outcome** or as a **solution**? Solution-shaped requests hide the real intent — dig for the outcome behind it.
- What is the requester's **actual goal**? (Ask "what problem does this solve for you?" if unclear.)
- Flag every ambiguity explicitly. If the design would differ wildly depending on the answer, route it to a **BLOCKING question** (see `question-escalation.md`) — do not guess.

### 2. Classify the request
- `BUG` — behavior diverges from intent (used to work / was supposed to work).
- `FEATURE` — a new capability.
- `REFACTOR` — same behavior, new shape.
- `IDEA` — an unproven direction (question the premise first).

### 3. Inventory current context (be exhaustive; each line is a lead)

- **Stack & runtime:** language, framework, libraries, versions, hosting.
- **Architecture:** boundaries, layering, monolith vs services, multi-tenancy, plugin systems, message flows.
- **Touchpoints:** exact modules / files / endpoints / tables / jobs this touches. *Read the relevant code* — do not reason from memory.
- **Conventions & contracts:** style guides, ADRs, coding standards, API conventions, error conventions.
- **Specs & tests as documentation:** existing tests describe expected behavior better than comments. Read them.
- **Prior art:** how does the system already solve similar problems? (Reuse beats invention; deviation needs a stated reason.)
- **Recent changes:** git history, changelog, recently merged work in the same area.
- **Failure history:** has this area broken before? What were the root causes? (Regression-prone areas deserve L3.)

### 4. Discover constraints — hard vs soft

- **Hard constraints** (cannot violate): legal/compliance, performance SLOs, security policy, backward-compatibility promises, resource limits.
- **Soft constraints** (preferred): conventions, team preferences, roadmap priorities.
- **Implicit constraints** (unstated but real): team skill set, deadline pressure, operational capacity.
- For each constraint: is it *explicit* (written down) or *implicit* (assumed)? Implicit constraints are a source of surprises — surface them.

### 5. Map consumers & stakeholders

For each affected party, record **what they care about** (not just who they are):
- End users (which flows, which roles/tenants/devices).
- Callers of this API/UI (internal services, integrations, SDK clients).
- Operators: on-call, support, SRE (what new burden lands on them).
- Other teams whose timelines or contracts this touches.

### 6. Audit assumptions

List every assumption. Give each a **confidence tag** (`verified / inferred / assumed / unknown`). An assumption that is load-bearing *and* unverified is an Open Question, not an assumption.

### 7. List unknowns — prioritized

Concrete questions whose answers would change the design. Order by **leverage**: a question that changes the whole shape ranks above one that changes a detail. For each, note who or what can answer it (user, code, docs, experiment).

### 8. Trace the fences (L3)

For anything existing that a candidate might remove or change, ask **why it exists** before touching it. Do not remove what you don't understand.

### 9. Route the unknowns — stop & ask

Split the unknowns (see `question-escalation.md`):
- **Self-serve** → answer from code/docs/tests now (never ask the user for these).
- **BLOCKING / DECISION / VERIFICATION** → batch into one question message and ask *now*.
- **Deferred** → record as an `[assumed]` default with a revisit trigger.

Ask early (end of this phase), batched (≤5), and only what passes the leverage test.

## Output

```text
REQUEST (restated)
<one paragraph — with outcome vs solution noted>

TYPE
bug | feature | refactor | idea

CURRENT CONTEXT
- Stack/runtime: <...>
- Architecture: <...>
- Touchpoints (modules/files/tables): <...>
- Conventions/ADRs: <...>
- Prior art: <how similar problems are solved today>
- Recent changes in this area: <...>
- Failure history: <has it broken before? root causes?>

CONSTRAINTS
- Hard: <...>   Soft: <...>   Implicit: <...>

CONSUMERS & STAKEHOLDERS
| Party | What they care about |
|-------|----------------------|
| ...   | ...                  |

ASSUMPTIONS (with confidence tag)
- [assumed] <...>
- [inferred] <...>

UNKNOWNS / QUESTIONS (ordered by leverage)
1. <question> — answerable by <who/what>
2. ...
```

## Rules

- **Do not propose solutions** in this phase. Description and questions only.
- Always separate `verified` from `assumed`; tag confidence.
- Load-bearing unknowns are routed to a **BLOCKING question** (stop & ask) — never silently guessed. See `question-escalation.md`.
- No "reading" of code from memory — if it matters, open the file.
- Depth is earned: if no escalation signal is present, don't inflate this phase (that's L3 ceremony applied to an L1 task).
