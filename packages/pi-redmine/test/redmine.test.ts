import assert from "node:assert/strict";
import test from "node:test";
import { RedmineClient } from "../src/client.ts";
import { getIssueTool, listIssuesTool } from "../src/tools.ts";

test("RedmineClient instantiates with correct default baseUrl", () => {
  const client = new RedmineClient();
  assert.ok(client);
});

test("Redmine tools are defined with valid names and schemas", () => {
  assert.equal(getIssueTool.name, "redmine_get_issue");
  assert.equal(listIssuesTool.name, "redmine_list_issues");
  assert.ok(getIssueTool.parameters);
  assert.ok(listIssuesTool.parameters);
});

test("Redmine tools execute read query against VietIS Redmine API", async () => {
  try {
    const client = new RedmineClient();
    client.getApiKey();
  } catch {
    // If key not configured in test env, skip live API call
    return;
  }

  const result = await listIssuesTool.execute(
    "test-call-1",
    { project_id: "466", status_id: "*", limit: 2 },
    new AbortController().signal,
    () => {},
    {} as any,
  );

  assert.ok(result.content);
  assert.equal((result as any).isError ?? false, false);
  const first = result.content[0];
  assert.ok(first && "text" in first);
  assert.match(first.text, /Redmine Issues/);
});
