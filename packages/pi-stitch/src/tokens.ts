/**
 * tokens.ts: Stitch Ember Copper Semantic Design System Tokens & TUI Card Helpers
 *
 * Provides standard surface palettes, Unicode 1px borders, pill badges, and
 * elevated card renderers for all packages in pi-agent-stack.
 */
import { Box, Text, type Component } from "@earendil-works/pi-tui";

export const EMBER_THEME = {
  surfaces: {
    canvas: "#24273a", // Base slate violet
    recessed: "#1e2030", // Recessed code/terminal stream
    elevated: "#181926", // Dialog/popup modal
    borderGlow: "#f5a97f", // Radiant Ember Copper
  },
  accents: {
    ember: "#f5a97f", // Primary Action / Supervisor
    mauve: "#c6a0f6", // JEV Reasoning / Thinking / Advisor
    emerald: "#a6da95", // Verification Pass / Consensus Approved
    amber: "#eed49f", // Warning / Budget Cap / Loop Alert
    hazard: "#ed8796", // Critical Error / Security Block
    sapphire: "#7dc4e4", // Context Diff / Prefetch Excerpt
  },
} as const;

export type PillVariant =
  "active" | "success" | "warning" | "error" | "info" | "dim";

export interface CardOptions {
  title: string;
  badge?: {
    text: string;
    variant?: PillVariant;
  };
  subtitle?: string;
  footer?: string;
  borderStyle?: "single" | "round" | "double" | "bold";
}

/**
 * Format a styled pill badge: e.g. `[ ● ACTIVE ]`, `[ ✓ PASSED ]`, `[ 🗜 4.2k SAVED ]`
 */
export function formatPillBadge(
  text: string,
  variant: PillVariant = "info",
  theme?: any,
): string {
  const iconMap: Record<PillVariant, string> = {
    active: "●",
    success: "✓",
    warning: "⚠",
    error: "✖",
    info: "◆",
    dim: "○",
  };

  const icon = iconMap[variant];
  const label = `[ ${icon} ${text} ]`;

  if (!theme) return label;

  const colorKeyMap: Record<PillVariant, string> = {
    active: "accent",
    success: "success",
    warning: "warning",
    error: "error",
    info: "accent",
    dim: "muted",
  };

  return theme.fg(colorKeyMap[variant] || "accent", theme.bold(label));
}

/**
 * Render a high-density, structured TUI Card with Unicode 1px framing.
 */
export function renderCard(
  contentLines: string[],
  options: CardOptions,
  theme?: any,
): Component {
  const badgeStr = options.badge
    ? ` ${formatPillBadge(options.badge.text, options.badge.variant, theme)}`
    : "";

  const headerText = theme
    ? `${theme.fg("accent", theme.bold(options.title))}${badgeStr}`
    : `${options.title}${badgeStr}`;

  const lines: string[] = [headerText];

  if (options.subtitle) {
    lines.push(theme ? theme.fg("muted", options.subtitle) : options.subtitle);
  }

  lines.push(...contentLines);

  if (options.footer) {
    lines.push(
      theme ? theme.fg("dim", `─ ${options.footer}`) : `─ ${options.footer}`,
    );
  }

  const fullText = lines.join("\n");
  const box = new Box(1, 0);
  box.addChild(new Text(fullText, 0, 0));
  return box;
}

/**
 * Render a Unicode progress bar.
 */
export function renderProgressBar(ratio: number, width: number = 16): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = Math.max(0, width - filled);
  const percent = Math.round(clamped * 100);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`;
}
