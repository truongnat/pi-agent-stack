import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Xlsx2MdRunner } from "../src/cli.ts";
import { convertTool, diffTool } from "../src/tools.ts";

test("Xlsx2MdRunner instantiates correctly", () => {
  const runner = new Xlsx2MdRunner();
  assert.ok(runner);
});

test("Xlsx2Md tools are defined with valid names and schemas", () => {
  assert.equal(convertTool.name, "xlsx2md_convert");
  assert.equal(diffTool.name, "xlsx2md_diff");
  assert.ok(convertTool.parameters);
  assert.ok(diffTool.parameters);
});

test("xlsx2md_convert converts existing excel workbook if available", async () => {
  const testFile = join(
    homedir(),
    ".agents",
    "bsn-specs-excel",
    "画面設計書_FBD08001_外注発注書印刷.xlsx",
  );
  if (!existsSync(testFile)) {
    return; // skip if file not present
  }

  const result = await convertTool.execute(
    "test-call-convert",
    { file_path: testFile, sheet: "変更履歴" },
    new AbortController().signal,
    () => {},
    {} as any,
  );

  assert.ok(result.content);
  const firstText =
    result.content[0] && "text" in result.content[0]
      ? result.content[0].text
      : "";
  assert.match(firstText, /画面設計書_FBD08001_外注発注書印刷/);
});
