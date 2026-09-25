---
name: remake
description: >
  Remake a vague or partial user request into a sharp, context-rich executable prompt
  using session, project, and codebase context; show it for approval, then run it.
  Use when the user runs /remake, says "remake this", "rewrite the prompt",
  "làm lại prompt", or wants the agent to turn rough intent into a better prompt
  before executing.
argument-hint: "[rough request to remake]"
---

# Remake

Turn the user's rough request into one sharp, executable prompt grounded in this session and the project. **Show it. Wait for OK. Then execute it.**

## 1. Gather

Collect only what the remade prompt needs:

| Source | Pull |
|--------|------|
| **User input** | Slash args, the triggering message, or the request they point at |
| **Session** | Decisions already made, constraints, failed attempts, open questions |
| **Project** | `AGENTS.md` / `CLAUDE.md`, `CONTEXT.md` / `CONTEXT-MAP.md`, relevant ADRs, specs, tickets |
| **Code** | Relevant files, symbols, and `git status` / diff when the work touches the tree |
| **Surroundings** | Open paths, errors, linked issues, prior prompts in this thread |

Read what is missing. Do not invent project facts. Prefer the project's ubiquitous language.

**Completion:** enough concrete context to write an executable prompt without guessing.

## 2. Compose

Write **one** remade prompt the agent can run as-is. Structure:

1. **Goal** — one-sentence outcome
2. **Context** — only facts needed to act (paths, names, constraints, prior decisions)
3. **Scope** — in / out
4. **Steps** — ordered actions
5. **Done when** — checkable completion criteria
6. **Constraints** — non-negotiables from session or project

Concrete paths and identifiers beat vague nouns. No fluff. No alternate plans unless the user asked for options.

**Completion:** a single prompt block ready to show.

## 3. Gate

Show the remade prompt in a fenced code block. Ask the user to **approve**, **edit**, or **reject**.

| Reply | Action |
|-------|--------|
| **Approve** / OK | Execute the remade prompt immediately in this session (treat it as the new user request) |
| **Edit** | Apply their edits (or remake from feedback), then return to this gate |
| **Reject** | Stop. Do not execute |

Do not start the work before approval.

**Completion:** user decision received; on approve, the remade prompt is being executed.
