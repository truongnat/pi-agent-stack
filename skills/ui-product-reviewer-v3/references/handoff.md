# AI coding handoff
Write edits in dependency order: foundations/tokens -> primitives -> shared components -> page composition -> states/content -> responsive/accessibility verification. State what must not change. Give acceptance criteria observable in the UI.

Example format:
- Change: consolidate section spacing to semantic `section-gap` token.
- Scope: shared page/section primitives and affected screens.
- Preserve: table density and existing information architecture.
- Acceptance: sibling sections use one consistent relationship; nested field spacing remains tighter; no raw replacement values introduced.

When code is supplied, reference real component/file/token names only. When code is absent, never invent repository paths.
