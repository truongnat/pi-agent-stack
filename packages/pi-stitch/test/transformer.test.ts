import assert from "node:assert/strict";
import test from "node:test";
import {
  stripAiSlop,
  transformCallouts,
  transformMarkdown,
} from "../src/transformer.ts";

test("stripAiSlop removes conversational boilerplate and pleasantries", () => {
  const input = `Sure! Here is the solution:
\`\`\`ts
const x = 1;
\`\`\`
I hope this helps! Let me know if you need anything else!`;

  const cleaned = stripAiSlop(input);
  assert.equal(cleaned, "```ts\nconst x = 1;\n```");
});

test("transformCallouts transforms GitHub alert callouts to clean badges", () => {
  const input = `> [!WARNING]
> Do not commit master keys!

> [!NOTE] Additional context here`;

  const output = transformCallouts(input);
  assert.ok(output.includes("> **⚠️ WARNING**"));
  assert.ok(output.includes("> **ℹ NOTE** Additional context here"));
});

test("transformMarkdown runs complete pipeline", () => {
  const input = `Certainly!
> [!TIP]
> Use early returns.
`;
  const result = transformMarkdown(input);
  assert.ok(result.startsWith("> **💡 TIP**"));
});

test("stitch registers a display-only markdown transformer and a generated token sheet", async () => {
  const { registerStitchExtension } = await import("../src/extension.ts");
  const { tokenSheet, EMBER_THEME } = await import("../src/tokens.ts");
  let transformer: ((md: string, ctx: any) => string) | undefined;
  const pi = new Proxy(
    {
      registerMarkdownTransformer: (t: typeof transformer) => (transformer = t),
    },
    { get: (target: any, key) => target[key] ?? (() => undefined) },
  );
  registerStitchExtension(
    pi as never,
    { list: async () => [], saveCache: () => {} } as never,
  );
  assert.ok(transformer, "transformer registered");
  const reply = "Sure! Here is the fix:\n> [!NOTE]\nDone.";
  const done = transformer(reply, {
    messageType: "assistant",
    isStreaming: false,
  });
  assert.ok(!done.startsWith("Sure!"));
  assert.ok(done.includes("ℹ NOTE"));
  const streaming = transformer(reply, {
    messageType: "assistant",
    isStreaming: true,
  });
  assert.ok(
    streaming.startsWith("Sure!"),
    "no preamble stripping while streaming",
  );
  assert.ok(tokenSheet().includes(EMBER_THEME.accents.mauve));
});
