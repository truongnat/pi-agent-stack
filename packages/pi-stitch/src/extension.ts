/**
 * Google Stitch (UI design) tools for Pi, bridged from Stitch's official remote MCP server.
 *
 * Pi has no MCP client, so this extension speaks MCP's JSON-RPC directly and registers each
 * Stitch tool as `stitch_<name>` with its original input schema. To keep 15 schemas out of
 * every prompt, the Stitch tools start inactive; the small `stitch_design` loader (or
 * `/stitch on`) activates them only when design work begins.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  findDesignSkills,
  PROMPT_HINT,
  PROMPT_TOOLS,
  stitchGuide,
} from "./guide.ts";

import {
  callTool,
  listTools,
  readApiKey,
  readToolsCache,
  saveApiKey,
  writeToolsCache,
  type McpCallResult,
  type McpTool,
} from "./client.ts";

const PREFIX = "stitch_";
const LOADER = "stitch_design";
/** Large screen payloads (HTML/code) are cut to keep tool results affordable. */
const MAX_TEXT_CHARS = 30_000;

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** MCP tool result → Pi tool content (text and images pass through; other parts become JSON). */
export function toPiContent(result: McpCallResult): ToolContent[] {
  const out: ToolContent[] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: truncate(part.text) });
    } else if (part.type === "image" && typeof part.data === "string") {
      out.push({
        type: "image",
        data: part.data,
        mimeType: String(part.mimeType ?? "image/png"),
      });
    } else {
      out.push({ type: "text", text: truncate(JSON.stringify(part)) });
    }
  }
  if (out.length === 0 && result.structuredContent !== undefined) {
    out.push({
      type: "text",
      text: truncate(JSON.stringify(result.structuredContent)),
    });
  }
  return out.length ? out : [{ type: "text", text: "(no content)" }];
}

const LONG_STRING = 600;
const LONG_ARRAY = 12;

/** Shorten long strings and arrays in a JSON value, keeping it valid JSON. */
function slim(value: unknown): unknown {
  if (typeof value === "string" && value.length > LONG_STRING) {
    return `${value.slice(0, 200)}… [+${value.length - 200} chars]`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, LONG_ARRAY).map(slim);
    return value.length > LONG_ARRAY
      ? [...head, `… [+${value.length - LONG_ARRAY} items]`]
      : head;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, slim(v)]),
    );
  }
  return value;
}

/**
 * Oversized results (Stitch embeds DESIGN.md, HTML, and screen lists) cost tokens and, if cut
 * mid-JSON, lose later items. Slim JSON first; hard-truncate only what is still too long.
 */
function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  let out = text;
  try {
    out = JSON.stringify(slim(JSON.parse(text)));
  } catch {
    // Not JSON: fall through to plain truncation.
  }
  return out.length > MAX_TEXT_CHARS
    ? `${out.slice(0, MAX_TEXT_CHARS)}\n… [truncated ${out.length - MAX_TEXT_CHARS} chars]`
    : out;
}

const NO_KEY =
  "Stitch API key missing. Create one at https://stitch.withgoogle.com/settings (API Keys), then run `/stitch key` or set STITCH_API_KEY.";

export type StitchDeps = {
  cachedTools?: () => McpTool[];
  list?: () => Promise<McpTool[]>;
  saveCache?: (tools: McpTool[]) => void;
};

export function registerStitchExtension(
  pi: ExtensionAPI,
  deps: StitchDeps = {},
): void {
  const list = deps.list ?? (() => listTools());
  const saveCache =
    deps.saveCache ?? ((tools: McpTool[]) => writeToolsCache(tools));
  const registered = new Map<string, McpTool>();

  const stitchNames = () => [...registered.keys()].map((name) => PREFIX + name);
  const activeStitch = () =>
    pi.getActiveTools().filter((n) => n.startsWith(PREFIX) && n !== LOADER);

  /** Activate Stitch tools; design-system tools (~30k chars of schema) only when asked. */
  const setStitchActive = (on: boolean, designSystem = true) => {
    const others = pi
      .getActiveTools()
      .filter((name) => !name.startsWith(PREFIX) || name === LOADER);
    const wanted = stitchNames().filter(
      (name) => designSystem || !name.includes("design_"),
    );
    pi.setActiveTools(on ? [...others, ...wanted] : others);
  };

  const register = (tools: McpTool[]): number => {
    let added = 0;
    for (const tool of tools) {
      if (registered.has(tool.name) || !/^[a-z0-9_]+$/.test(tool.name))
        continue;
      registered.set(tool.name, tool);
      added += 1;
      pi.registerTool({
        name: PREFIX + tool.name,
        label: `Stitch ${tool.name.replaceAll("_", " ")}`,
        description: [
          PROMPT_TOOLS.has(tool.name) ? PROMPT_HINT : "",
          tool.description ?? `Google Stitch ${tool.name}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        // SAFETY: Stitch publishes JSON Schema; TypeBox Unsafe passes it through unchanged.
        parameters: Type.Unsafe<Record<string, unknown>>(
          tool.inputSchema ?? { type: "object" },
        ),
        async execute(_toolCallId, params, signal) {
          const apiKey = readApiKey();
          if (!apiKey) throw new Error(NO_KEY);
          const result = await callTool(tool.name, params, { apiKey, signal });
          const content = toPiContent(result);
          if (result.isError) {
            throw new Error(
              content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
            );
          }
          return { content, details: { tool: tool.name } };
        },
      });
    }
    return added;
  };

  // Cache-first: tools exist before the first prompt without a network round trip.
  register((deps.cachedTools ?? (() => readToolsCache()))());

  pi.registerTool({
    name: LOADER,
    label: "Stitch design tools",
    description:
      "Enable Google Stitch UI design tools (projects, screens from text, edits, variants). Call once before any Stitch design work; pass design_system=true only to create, update, list, or apply design systems.",
    parameters: Type.Object({
      design_system: Type.Optional(
        Type.Boolean({
          description: "Also enable design-system tools (large schemas).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (registered.size === 0) register(await list());
      setStitchActive(true, params.design_system === true);
      const key = readApiKey() ? "" : `\n\n${NO_KEY}`;
      return {
        content: [
          {
            type: "text",
            text: `Enabled: ${activeStitch().join(", ")}\n\n${stitchGuide(findDesignSkills())}${key}`,
          },
        ],
        details: { tools: activeStitch() },
      };
    },
  });

  pi.on("session_start", (_event, _ctx) => {
    setStitchActive(false);
    // Refresh the catalog in the background; new tools register now, the cache serves next start.
    void list()
      .then((tools) => {
        saveCache(tools);
        if (register(tools) > 0) setStitchActive(false);
      })
      .catch(() => {
        // Offline start must not break Pi; the cached catalog still works.
      });
  });

  pi.registerCommand("stitch", {
    description: "Google Stitch: status | key | on | off",
    handler: async (args, ctx: ExtensionContext) => {
      const cmd = (args ?? "").trim();
      if (cmd === "key") {
        const key = await ctx.ui.input(
          "Stitch API key (stitch.withgoogle.com/settings)",
          "",
        );
        if (!key?.trim()) return;
        saveApiKey(key);
        ctx.ui.notify("Stitch API key saved to ~/.keys/stitch.env", "info");
        return;
      }
      if (cmd === "on" || cmd === "off") {
        if (cmd === "on" && registered.size === 0) register(await list());
        setStitchActive(cmd === "on");
      }
      const active = activeStitch();
      ctx.ui.notify(
        [
          `Stitch: ${registered.size} tools, ${active.length ? "active" : "inactive (call stitch_design or /stitch on)"}`,
          readApiKey() ? "API key: configured" : NO_KEY,
        ].join("\n"),
        "info",
      );
    },
  });
}
