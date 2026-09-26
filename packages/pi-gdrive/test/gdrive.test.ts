import assert from "node:assert/strict";
import test from "node:test";
import { GDriveClient } from "../src/client.ts";
import {
  gdriveDownloadTool,
  gdriveInfoTool,
  gdriveSearchTool,
} from "../src/tools.ts";

test("GDriveClient instantiates correctly", () => {
  const client = new GDriveClient();
  assert.ok(client);
});

test("Google Drive tools are defined with valid names and schemas", () => {
  assert.equal(gdriveSearchTool.name, "gdrive_search");
  assert.equal(gdriveDownloadTool.name, "gdrive_download");
  assert.equal(gdriveInfoTool.name, "gdrive_get_file_info");
  assert.ok(gdriveSearchTool.parameters);
  assert.ok(gdriveDownloadTool.parameters);
  assert.ok(gdriveInfoTool.parameters);
});

test("gdrive_search queries live Google Drive files", async () => {
  try {
    const client = new GDriveClient();
    await client.getAccessToken();
  } catch {
    // If credentials not configured in test env, skip live API call
    return;
  }

  const result = await gdriveSearchTool.execute(
    "test-call-search",
    { query: "画面設計書", limit: 2 },
    new AbortController().signal,
    () => {},
    {} as any,
  );

  assert.ok(result.content);
  assert.equal((result as any).isError ?? false, false);
  const first = result.content[0];
  assert.ok(first && "text" in first);
  assert.match(first.text, /Google Drive Search Results/);
});
