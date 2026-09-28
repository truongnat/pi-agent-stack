import assert from "node:assert/strict";
import test from "node:test";
import { loadRedmineConfig } from "../src/config.ts";
import { RedmineClient } from "../src/client.ts";
import { redmineGetIssueTool, redmineSearchIssuesTool } from "../src/tools.ts";

test("loadRedmineConfig throws a clear error when unconfigured", () => {
  const savedUrl = process.env.REDMINE_URL;
  const savedKey = process.env.REDMINE_API_KEY;
  const savedEnvFile = process.env.REDMINE_ENV_FILE;
  delete process.env.REDMINE_URL;
  delete process.env.REDMINE_API_KEY;
  // A real ~/.keys/redmine.env may exist on this machine; point at a path that can't.
  process.env.REDMINE_ENV_FILE = "/nonexistent/redmine.env";
  try {
    assert.throws(() => loadRedmineConfig(), /REDMINE_URL/);
  } finally {
    if (savedUrl !== undefined) process.env.REDMINE_URL = savedUrl;
    if (savedKey !== undefined) process.env.REDMINE_API_KEY = savedKey;
    if (savedEnvFile === undefined) delete process.env.REDMINE_ENV_FILE;
    else process.env.REDMINE_ENV_FILE = savedEnvFile;
  }
});

test("loadRedmineConfig reads process env and trims trailing slashes", () => {
  const savedUrl = process.env.REDMINE_URL;
  const savedKey = process.env.REDMINE_API_KEY;
  process.env.REDMINE_URL = "https://example.test/redmine/";
  process.env.REDMINE_API_KEY = "test-key";
  try {
    const config = loadRedmineConfig();
    assert.equal(config.baseUrl, "https://example.test/redmine");
    assert.equal(config.apiKey, "test-key");
  } finally {
    if (savedUrl === undefined) delete process.env.REDMINE_URL;
    else process.env.REDMINE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.REDMINE_API_KEY;
    else process.env.REDMINE_API_KEY = savedKey;
  }
});

test("Redmine tools are defined with valid names and schemas", () => {
  assert.equal(redmineGetIssueTool.name, "redmine_get_issue");
  assert.equal(redmineSearchIssuesTool.name, "redmine_search_issues");
  assert.ok(redmineGetIssueTool.parameters);
  assert.ok(redmineSearchIssuesTool.parameters);
});

test("redmine_get_issue fetches a live ticket when configured", async () => {
  if (!process.env.REDMINE_URL || !process.env.REDMINE_API_KEY) return;
  if (!process.env.REDMINE_TEST_ISSUE_ID) return;

  const result = await redmineGetIssueTool.execute(
    "test-call-get-issue",
    { issue_id: Number(process.env.REDMINE_TEST_ISSUE_ID) },
    new AbortController().signal,
    () => {},
    {} as any,
  );

  assert.ok(result.content);
  assert.equal((result as any).isError ?? false, false);
});

test("RedmineClient instantiates when explicit config is passed", () => {
  const client = new RedmineClient({
    baseUrl: "https://example.test",
    apiKey: "unused",
  });
  assert.ok(client);
});
