import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBER_THEME,
  formatPillBadge,
  renderCard,
  renderProgressBar,
} from "../src/tokens.ts";

test("EMBER_THEME exports semantic surface and accent tokens", () => {
  assert.ok(EMBER_THEME.surfaces.canvas);
  assert.ok(EMBER_THEME.accents.ember);
  assert.ok(EMBER_THEME.accents.mauve);
  assert.ok(EMBER_THEME.accents.emerald);
  assert.ok(EMBER_THEME.accents.amber);
  assert.ok(EMBER_THEME.accents.hazard);
});

test("formatPillBadge renders clean glyph tags", () => {
  const activeBadge = formatPillBadge("RUNNING", "active");
  assert.equal(activeBadge, "[ ● RUNNING ]");

  const passBadge = formatPillBadge("PASSED", "success");
  assert.equal(passBadge, "[ ✓ PASSED ]");

  const warnBadge = formatPillBadge("RATE LIMIT", "warning");
  assert.equal(warnBadge, "[ ⚠ RATE LIMIT ]");

  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const themedBadge = formatPillBadge("ACTIVE", "active", mockTheme);
  assert.equal(themedBadge, "[ ● ACTIVE ]");
});

test("renderCard creates high-density Box component", () => {
  const lines = ["• Metric: 100%", "• Status: Nominal"];
  const card = renderCard(lines, {
    title: "System Health",
    badge: { text: "HEALTHY", variant: "success" },
    subtitle: "Core Diagnostics",
    footer: "Session #102",
  });

  assert.ok(card);
});

test("renderProgressBar formats progress bar correctly", () => {
  const half = renderProgressBar(0.5, 10);
  assert.equal(half, "[█████░░░░░] 50%");
  const full = renderProgressBar(1.0, 10);
  assert.equal(full, "[██████████] 100%");
});
