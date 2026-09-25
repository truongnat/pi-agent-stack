import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Design skills referred to before a prompt goes to Stitch, in reading order. They are
 * installed globally by scripts/install.sh; only the ones present are mentioned.
 */
export const DESIGN_SKILLS = [
  {
    name: "stitch-design-taste",
    use: "draft the project's DESIGN.md (design system) for Stitch",
  },
  {
    name: "ui-ux-pro-max",
    use: "pick style, palette, font pairing, and UX rules for the product type",
  },
  {
    name: "design-taste-frontend",
    use: "anti-slop rules: layout variation, type hierarchy, no template look",
  },
  {
    name: "impeccable",
    use: "critique/audit a generated screen, then fix it with edit_screens",
  },
] as const;

export type FoundSkill = { name: string; use: string; path: string };

/** Locate installed design skills by their SKILL.md `name:` under the shared skill roots. */
export function findDesignSkills(
  roots = [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
  ],
): FoundSkill[] {
  const byName = new Map<string, string>();
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const path = join(root, dir, "SKILL.md");
      try {
        const name = /^name:\s*(.+)$/m
          .exec(readFileSync(path, "utf8").slice(0, 2000))?.[1]
          ?.trim();
        if (name && !byName.has(name)) byName.set(name, path);
      } catch {
        // Not a skill directory.
      }
    }
  }
  return DESIGN_SKILLS.flatMap((s) => {
    const path = byName.get(s.name);
    return path ? [{ ...s, path }] : [];
  });
}

/** Tools whose prompt text decides the design quality. */
export const PROMPT_TOOLS = new Set([
  "generate_screen_from_text",
  "edit_screens",
  "generate_variants",
]);

export const PROMPT_HINT =
  "Before calling: follow the stitch_design workflow — read the design skills it lists, make sure the project has a design system, and send a structured prompt (purpose, device, sections top→bottom, components with states, real copy, tokens from DESIGN.md, banned patterns). One screen per call.";

/** Workflow returned by the stitch_design loader; costs tokens only when design work starts. */
export function stitchGuide(skills: FoundSkill[]): string {
  const read = skills.length
    ? skills.map((s) => `- ${s.name} (${s.path}): ${s.use}`).join("\n")
    : "- (no design skills installed; run scripts/install.sh)";
  return [
    "Stitch workflow (build the prompt before sending):",
    "1. Refer first. Read only the skills needed for this task:",
    read,
    "2. Design system. get_project → designTheme.designMd. If missing or off-brief, draft DESIGN.md with stitch-design-taste and apply it (stitch_design design_system=true enables those tools).",
    "3. Build the prompt, then send it. Fill every line:",
    "   Screen: <name + user goal> | Device: <MOBILE|DESKTOP>",
    "   Layout: <sections top→bottom, hierarchy, density>",
    "   Components: <each with states: default, empty, loading, error, disabled>",
    "   Content: <real labels and data in the product language; no lorem ipsum>",
    "   Style: <tokens from DESIGN.md: colors, type scale, radius, spacing>",
    "   Avoid: <banned patterns from the skills, e.g. generic gradients, centered-everything, emoji icons>",
    "4. One screen per generate call; reuse the same design system for every screen.",
    "5. Review each result against impeccable's audit and fix with edit_screens (selected screen ids + one focused change per prompt).",
  ].join("\n");
}
