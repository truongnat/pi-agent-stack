import assert from "node:assert/strict";
import test from "node:test";

import { callTool, listTools, parseKey, type McpTool } from "../src/client.ts";
import { registerStitchExtension, toPiContent } from "../src/extension.ts";

const TOOLS: McpTool[] = [
  {
    name: "list_projects",
    description: "Lists projects",
    inputSchema: { type: "object" },
  },
  {
    name: "generate_screen_from_text",
    inputSchema: { type: "object", required: ["projectId", "prompt"] },
  },
  { name: "create_design_system", inputSchema: { type: "object" } },
];

function fakeFetch(
  respond: (body: { method: string; params: unknown }) => unknown,
  status = 200,
) {
  const seen: Array<{
    headers: Record<string, string>;
    body: { method: string; params: unknown };
  }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ headers: init.headers as Record<string, string>, body });
    return new Response(JSON.stringify(respond(body)), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("listTools and callTool speak MCP JSON-RPC with the API key header", async () => {
  const { impl, seen } = fakeFetch(({ method }) =>
    method === "tools/list"
      ? { jsonrpc: "2.0", id: 1, result: { tools: TOOLS } }
      : {
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "ok" }] },
        },
  );
  assert.equal((await listTools(impl)).length, TOOLS.length);
  const result = await callTool(
    "list_projects",
    {},
    { apiKey: "k", fetchImpl: impl },
  );
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.equal(seen[1]?.body.method, "tools/call");
  assert.deepEqual(seen[1]?.body.params, {
    name: "list_projects",
    arguments: {},
  });
  assert.equal(seen[1]?.headers["X-Goog-Api-Key"], "k");
  assert.equal(
    seen[0]?.headers["X-Goog-Api-Key"],
    undefined,
    "catalog needs no key",
  );
});

test("JSON-RPC errors and HTTP failures surface as errors", async () => {
  const rpcError = fakeFetch(() => ({
    jsonrpc: "2.0",
    id: 1,
    error: { message: "bad key" },
  }));
  await assert.rejects(
    callTool("x", {}, { apiKey: "k", fetchImpl: rpcError.impl }),
    /bad key/,
  );
  const http = fakeFetch(() => ({}), 403);
  await assert.rejects(listTools(http.impl), /HTTP 403/);
});

test("toPiContent keeps text and images, serializes the rest, truncates huge text", () => {
  const content = toPiContent({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "resource_link", uri: "https://x" },
      { type: "text", text: "y".repeat(40_000) },
    ],
  });
  assert.deepEqual(content[0], { type: "text", text: "hello" });
  assert.deepEqual(content[1], {
    type: "image",
    data: "AAAA",
    mimeType: "image/png",
  });
  assert.match(
    content[2]?.type === "text" ? content[2].text : "",
    /resource_link/,
  );
  assert.match(
    content[3]?.type === "text" ? content[3].text : "",
    /truncated 10000 chars/,
  );
  assert.deepEqual(toPiContent({ structuredContent: { a: 1 } }), [
    { type: "text", text: '{"a":1}' },
  ]);
});

test("Stitch tools register inactive; the loader activates them", async () => {
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >();
  let active = ["read", "bash"];
  const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
  const pi = {
    registerTool: (tool: {
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }) => {
      tools.set(tool.name, tool);
      active = [...active, tool.name];
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers[event] = handler;
    },
    registerCommand: () => {},
  };
  // SAFETY: the extension only uses the members stubbed above.
  registerStitchExtension(pi as never, {
    cachedTools: () => TOOLS,
    list: async () => TOOLS,
    saveCache: () => {},
  });
  assert.ok(
    tools.has("stitch_list_projects") &&
      tools.has("stitch_generate_screen_from_text"),
  );
  handlers.session_start?.({}, {});
  assert.deepEqual(
    active,
    ["read", "bash", "stitch_design"],
    "only the loader stays active",
  );
  await tools.get("stitch_design")?.execute("id", {});
  assert.ok(
    active.includes("stitch_list_projects") &&
      active.includes("stitch_generate_screen_from_text"),
  );
  assert.ok(
    !active.includes("stitch_create_design_system"),
    "design-system schemas stay off by default",
  );
  await tools.get("stitch_design")?.execute("id", { design_system: true });
  assert.ok(active.includes("stitch_create_design_system"));
});

test("parseKey accepts a bare key or an env-style line", () => {
  assert.equal(parseKey("abc123\n"), "abc123");
  assert.equal(parseKey("STITCH_API_KEY=abc123"), "abc123");
  assert.equal(parseKey('export STITCH_API_KEY="abc123"\n'), "abc123");
  assert.equal(parseKey("STITCH_API_KEY="), undefined);
});

test("oversized JSON results are slimmed, not cut mid-document", () => {
  const projects = Array.from({ length: 5 }, (_, i) => ({
    title: `p${i}`,
    designMd: "x".repeat(20_000),
  }));
  const [part] = toPiContent({
    content: [{ type: "text", text: JSON.stringify({ projects }) }],
  });
  const text = part?.type === "text" ? part.text : "";
  const parsed = JSON.parse(text) as {
    projects: Array<{ title: string; designMd: string }>;
  };
  assert.equal(parsed.projects.length, 5, "every project survives");
  assert.match(parsed.projects[4]?.designMd ?? "", /\+19800 chars/);
});
