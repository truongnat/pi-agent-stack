/**
 * transformer.ts: Markdown Transformer & Anti-Slop Engine
 *
 * Implements high-density markdown transformation:
 * - Anti-slop: strips repetitive AI preamble and pleasantries
 * - Callout styling: converts GitHub-style alert callouts ([!NOTE], [!WARNING], etc.) to clean glyph banners
 */

const SLOP_PREAMBLE_PATTERNS = [
  /^(?:Sure!?|Certainly!?|Of course!?|Absolutely!?|I'd be happy to help with that\.?)\s*/i,
  /^(?:Here is the (?:solution|fix|code|diff|updated file|implementation|patch):?)\s*\n*/i,
  /^(?:As an AI language model,?\s*)/i,
  /^(?:As requested, here (?:is|are) the (?:changes|details|files):?)\s*\n*/i,
];

const SLOP_POSTAMBLE_PATTERNS = [
  /(?:\s*\n*|^)(?:I hope this helps!?)\s*$/i,
  /(?:\s*\n*|^)(?:Let me know if (?:you need|there is) anything (?:else|further)!?)\s*$/i,
  /(?:\s*\n*|^)(?:Feel free to ask if you have (?:any|more) questions!?)\s*$/i,
  /(?:\s*\n*|^)(?:Please let me know if you encounter any (?:issues|errors)\.?)\s*$/i,
];

const CALLOUT_GLYPH_MAP: Record<string, string> = {
  NOTE: "ℹ NOTE",
  TIP: "💡 TIP",
  IMPORTANT: "📌 IMPORTANT",
  WARNING: "⚠️ WARNING",
  CAUTION: "🛑 CAUTION",
  HAZARD: "✖ HAZARD",
};

/**
 * Remove conversational AI filler and boilerplate from markdown.
 */
export function stripAiSlop(text: string): string {
  let cleaned = text.trim();
  let changed = true;

  while (changed) {
    const prev = cleaned;
    for (const pattern of SLOP_PREAMBLE_PATTERNS) {
      cleaned = cleaned.replace(pattern, "").trim();
    }
    for (const pattern of SLOP_POSTAMBLE_PATTERNS) {
      cleaned = cleaned.replace(pattern, "").trim();
    }
    changed = cleaned !== prev;
  }

  return cleaned;
}

/**
 * Convert GitHub-style markdown alert blocks into stylized callouts.
 * e.g. `> [!WARNING]` -> `> ⚠️ **WARNING**:`
 */
export function transformCallouts(markdown: string): string {
  return markdown.replace(
    /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|HAZARD)\]\s*(.*)$/gim,
    (_match, type, rest) => {
      const glyph = CALLOUT_GLYPH_MAP[type.toUpperCase()] || `ℹ ${type}`;
      const suffix = rest ? ` ${rest}` : "";
      return `> **${glyph}**${suffix}`;
    },
  );
}

export interface MarkdownTransformOptions {
  antiSlop?: boolean;
  callouts?: boolean;
}

/**
 * High-density Markdown Transformer for Pi Stack assistant messages.
 */
export function transformMarkdown(
  markdown: string,
  options: MarkdownTransformOptions = { antiSlop: true, callouts: true },
): string {
  let result = markdown;

  if (options.antiSlop) {
    result = stripAiSlop(result);
  }

  if (options.callouts) {
    result = transformCallouts(result);
  }

  return result;
}
