import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Google's official remote MCP server for Stitch (stateless, plain JSON responses). */
export const STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";
export const DEFAULT_KEY_FILE = join(homedir(), ".keys", "stitch.env");
export const KEY_FILES = [
  join(homedir(), ".keys", "stitch.env"),
  join(homedir(), ".keys", "stitch.key"),
  join(homedir(), ".keys", "stitch-api-key"),
  join(homedir(), ".stitch", "api-key"),
];
export const DEFAULT_TOOLS_CACHE = join(
  homedir(),
  ".pi",
  "agent",
  "stitch-tools.json",
);

/** Generation calls can take minutes on Stitch's side. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 15_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type Fetch = typeof fetch;

/** `STITCH_API_KEY`, else candidate key files in ~/.keys/ (stitch.env, stitch.key, stitch-api-key). */
export function readApiKey(file?: string): string | undefined {
  const fromEnv = process.env.STITCH_API_KEY?.trim();
  if (fromEnv) return parseKey(fromEnv);

  const filesToTry = file ? [file] : KEY_FILES;
  for (const f of filesToTry) {
    try {
      if (existsSync(f)) {
        const parsed = parseKey(readFileSync(f, "utf8"));
        if (parsed) return parsed;
      }
    } catch {
      // Continue to next key file candidate
    }
  }
  return undefined;
}

/** Accept a bare key or an env-style line: `[export] STITCH_API_KEY="…"`. */
export function parseKey(raw: string): string | undefined {
  const line = raw.trim();
  const m = /^(?:export\s+)?STITCH_API_KEY\s*=\s*(.*)$/m.exec(line);
  const value = (m ? (m[1] ?? "") : line)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  return value || undefined;
}

export function saveApiKey(key: string, file = DEFAULT_KEY_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `export STITCH_API_KEY="${key.trim()}"\n`, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}

let nextId = 1;

async function rpc<T>(
  method: string,
  params: unknown,
  options: {
    apiKey?: string | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    fetchImpl?: Fetch;
  },
): Promise<T> {
  const signals = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const res = await (options.fetchImpl ?? fetch)(STITCH_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(options.apiKey ? { "X-Goog-Api-Key": options.apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    redirect: "error",
    signal: AbortSignal.any(signals),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Stitch MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Stateless JSON today; accept an SSE frame too in case the server switches transports.
  const json = text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");
  const body = JSON.parse(json) as { result?: T; error?: { message?: string } };
  if (body.error)
    throw new Error(`Stitch MCP ${method}: ${body.error.message ?? "error"}`);
  return body.result as T;
}

/** Tool catalog; works without an API key. */
export async function listTools(fetchImpl?: Fetch): Promise<McpTool[]> {
  const result = await rpc<{ tools?: McpTool[] }>(
    "tools/list",
    {},
    {
      timeoutMs: LIST_TIMEOUT_MS,
      ...(fetchImpl ? { fetchImpl } : {}),
    },
  );
  return result.tools ?? [];
}

export async function callTool(
  name: string,
  args: unknown,
  options: {
    apiKey: string;
    signal?: AbortSignal | undefined;
    fetchImpl?: Fetch;
  },
): Promise<McpCallResult> {
  return rpc<McpCallResult>(
    "tools/call",
    { name, arguments: args ?? {} },
    {
      ...options,
      timeoutMs: CALL_TIMEOUT_MS,
    },
  );
}

export function readToolsCache(file = DEFAULT_TOOLS_CACHE): McpTool[] {
  try {
    const tools = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(tools) ? (tools as McpTool[]) : [];
  } catch {
    return [];
  }
}

export function writeToolsCache(
  tools: McpTool[],
  file = DEFAULT_TOOLS_CACHE,
): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  // Only what Pi sends to the model; Stitch's output schemas are ~15x larger.
  const slim = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  writeFileSync(file, `${JSON.stringify(slim)}\n`);
}
