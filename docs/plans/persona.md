# Research & Specification: User Preference Reinforcement Learning (Persona Engine)

**Status:** Proposed & Implementation in Progress (2026-09-25)  
**Package:** `packages/pi-persona` (Integrated with `pi-jev-harness` & `pi-rl-engine`)

---

## 1. Executive Summary

While standard Reinforcement Learning in coding agents (such as `pi-rl-engine`) optimizes for **objective correctness** (passing tests, zero runtime errors), real-world developer satisfaction is equally governed by **subjective alignment** — adherence to the individual developer's unique coding taste, architecture idioms, workflow habits, and communication expectations.

The **Persona Engine (`pi-persona`)** introduces **User Preference Reinforcement Learning (UPRL)**: a self-tuning personal habit engine that learns from every interaction, correction, and git diff to ensure the agent continuously morphs into the user's ideal pair programmer.

---

## 2. Architecture: User Preference Reinforcement Learning (UPRL)

```mermaid
flowchart TD
    User([Developer Feedback & Corrections]) --> Capture[Implicit & Explicit Feedback Extractor]
    
    subgraph "UPRL Engine (packages/pi-persona)"
        Capture --> Learner[Preference Learning & Decay\n(EMA / Q-Weighting)]
        Learner --> PersonaStore[~/.pi/agent/persona.json\n~/.pi/agent/persona.md]
        PersonaStore --> Synthesizer[Contextual Preference Synthesizer]
    end
    
    Synthesizer --> Advisor[Harness Advisor Layer (System 1)]
    Advisor --> MainModel[Main Coding Agent (System 2)]
    
    MainModel --> Outcome[Generated Code / Actions]
    Outcome -.->|User Revision / Acceptance| Capture
```

---

## 3. Preference Taxonomy

| Dimension | Categories | Examples |
| :--- | :--- | :--- |
| **Coding Habits** | `architecture`, `type_safety`, `error_handling`, `code_economy` | Strict typing, TypeBox schema contracts, early-return guard clauses, Result pattern, minimal diff preservation, never use `any`. |
| **Workflow Habits** | `testing`, `git_convention`, `verification` | TDD (verify failing test first), Conventional Commits (`feat:`, `fix:`), always run `npm test` before concluding. |
| **Communication Habits** | `conciseness`, `language`, `artifacts` | Concise direct explanations, no conversational fluff, Vietnamese explanation with technical English terms, clickable file links. |

---

## 4. Learning & Weighting Mechanics

Each preference entry tracks:
```typescript
export interface UserPreference {
  id: string
  category: 'coding' | 'workflow' | 'communication'
  key: string
  rule: string
  weight: number // 0.0 to 1.0 (Q-value / Confidence)
  reinforcements: number // count of positive affirmations
  rejections: number // count of user counter-corrections
  createdAt: number
  lastAppliedAt: number
}
```

- **Positive Reinforcement ($\Delta W > 0$)**: When code following the preference is committed without user alteration, or user explicitly praises/confirms.
- **Negative Correction ($\Delta W < 0$)**: When user corrects a pattern (e.g. *"đừng dùng any"*, *"viết gọn lại"*), the old habit is penalized and the new preference is reinforced.
- **Contextual Injection**: Only the top-3 highest-weighted preferences matching the current task are synthesized (capped at ~60 tokens) to ensure zero context bloat.

---

## 5. Components & Tooling

1. **`~/.pi/agent/persona.md`**: Human-readable and editable profile.
2. **`~/.pi/agent/persona.json`**: Machine-readable preference store with historical weights.
3. **Master Tools**:
   - `get_persona`: Inspect active learned preferences.
   - `update_persona`: Explicitly set or refine a habit.
4. **Slash Command `/persona`**:
   - `/persona`: View dashboard.
   - `/persona list`: List all habits and confidence scores.
   - `/persona learn <rule>`: Explicitly teach a new habit.
   - `/persona reset`: Reset learned weights to default.
