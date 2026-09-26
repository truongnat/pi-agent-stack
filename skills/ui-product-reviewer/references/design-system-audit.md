# Design-system audit
Audit foundations: semantic colors, typography roles, spacing scale, radii, borders, elevation, icons, motion, breakpoints. Audit components: anatomy, variants, sizes, states, composition rules, accessibility, responsive behavior. Audit governance: raw-value escape hatches, duplicate primitives, one-off variants, naming quality, token ownership.

Look for root causes such as: missing semantic tokens causing hard-coded values; overly generic components causing variant explosion; no density model; unclear hierarchy roles; layout primitives that cannot express common screen structures; missing state definitions; product-specific styling leaking into primitives.

Prefer a small stable vocabulary. A system is successful when different screens can be built consistently without designers/developers repeatedly inventing local rules.
