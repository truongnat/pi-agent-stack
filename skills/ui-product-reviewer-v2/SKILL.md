---
name: ui-product-reviewer-v2
description: Deep UI/UX and design-system review for mobile, tablet, web, forms, dashboards, and data-dense interfaces. Use when auditing screenshots or code for spacing, typography, color, radius, component consistency, responsive behavior, accessibility, platform fit, and overall product usability, including comparison against established Material, Apple HIG, Fluent, and WCAG principles without blindly copying any one system.
---
# UI Product Reviewer V2
Perform the V1 product-first review, then benchmark the implementation against mature platform conventions. Treat benchmarks as evidence and guardrails, not as a mandate to clone a brand.

Read `references/foundations.md` for token and platform guidance and `references/screen-patterns.md` for forms/mobile/tablet/data-dense screens when relevant.

## Workflow
1. Infer product intent and platform from supplied evidence.
2. Run UX task-flow and hierarchy review before styling review.
3. Audit design-system primitives: color, typography, spacing, radius, border, elevation, iconography, motion, breakpoints, states.
4. Audit components for API consistency and state completeness.
5. Audit platform ergonomics and accessibility.
6. Identify root causes and propose the smallest coherent set of system changes.
7. Produce a handoff that an AI coding agent can execute without guessing.

## Rules
- Prefer semantic tokens (`surface`, `text-muted`, `border-subtle`, `danger`) over screen-specific values.
- Prefer 4/8-based spacing rhythm but allow optical corrections when justified; consistency and relationships matter more than dogma.
- Avoid excessive cards, borders, shadows, and nested containers. Use hierarchy and whitespace before decoration.
- A compact data product may legitimately be denser than a consumer mobile app. Judge density against task frequency and scan needs.
- Forms must communicate requiredness, constraints, errors, progress, and recovery before decoration.
- Verify dark mode and high-contrast behavior if the system claims to support them.

## Output
Give: `Diagnosis`; `Top problems`; `Detailed audit` by UX, hierarchy, layout/spacing, typography, color/elevation, components/forms, responsive/platform, accessibility; `System-level fixes`; `Screen-level fixes`; `Implementation order`; `Keep`. Every issue must include evidence visible in the input, user consequence, and a concrete fix.
