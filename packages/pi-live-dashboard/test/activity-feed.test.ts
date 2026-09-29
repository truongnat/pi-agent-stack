import assert from "node:assert/strict";
import test from "node:test";
import { activityFeedEvents, providerBadge } from "../src/activity-feed.ts";

const session = {
  events: [{ type: "tool", name: "bash", text: "main command", at: 1 }],
  agents: [
    {
      id: "worker-1",
      role: "coder",
      status: "streaming",
      model: "opencode/model-x",
      currentActivity: "12s\n  read src/app.ts\n  edit src/app.ts",
      previewMarkdown: "worker output",
    },
  ],
  preview: "main output",
  updatedAt: 20,
};

test("supervisor activity contains only the main session feed", () => {
  assert.deepEqual(activityFeedEvents(session, "supervisor"), [
    ...session.events,
    { type: "assistant", text: "main output", at: 20 },
  ]);
});

test("subagent activity excludes supervisor events and preview", () => {
  assert.deepEqual(activityFeedEvents(session, "worker-1"), [
    {
      type: "tool",
      name: "coder",
      text: "read src/app.ts",
      at: 20,
    },
    {
      type: "tool",
      name: "coder",
      text: "edit src/app.ts",
      at: 20,
    },
    {
      type: "assistant",
      name: "Assistant",
      text: "worker output",
      at: 20,
    },
  ]);
});

test("provider badge uses model data or the model suffix in old node names", () => {
  assert.equal(providerBadge("openai-codex/gpt-5.5"), "Codex");
  assert.equal(
    providerBadge(undefined, "Nova - Coder - Senior - (claude-code/sonnet)"),
    "Claude",
  );
  assert.equal(providerBadge(undefined, "Nova - Coder - Senior"), "");
});
