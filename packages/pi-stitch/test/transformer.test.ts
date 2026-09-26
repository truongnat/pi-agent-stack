import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHazardousBash,
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

test("checkHazardousBash flags destructive commands", () => {
  const dangerous1 = checkHazardousBash("rm -rf /");
  assert.equal(dangerous1.isHazard, true);

  const dangerous2 = checkHazardousBash("git push origin main --force");
  assert.equal(dangerous2.isHazard, true);

  const safe = checkHazardousBash("bun run test");
  assert.equal(safe.isHazard, false);
});

test("transformMarkdown runs complete pipeline", () => {
  const input = `Certainly!
> [!TIP]
> Use early returns.
`;
  const result = transformMarkdown(input);
  assert.ok(result.startsWith("> **💡 TIP**"));
});
