import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Same convention as config/typesafe.env.example and config/jev.env.example.
 * Overridable via REDMINE_ENV_FILE (e.g. to point tests at a path that can't exist).
 */
function keyFilePath(): string {
  return (
    process.env.REDMINE_ENV_FILE || join(homedir(), ".keys", "redmine.env")
  );
}

/** Parses `export NAME=value` / `NAME=value` lines; ignores blanks and `#` comments. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const name = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (name) out[name] = value;
  }
  return out;
}

export interface RedmineConfig {
  /** e.g. "https://redmine.example.com" — no trailing slash. */
  baseUrl: string;
  apiKey: string;
}

/**
 * Every deployment points at its own Redmine instance: no URL or API key is ever
 * hardcoded here. Resolution order: process env (REDMINE_URL / REDMINE_API_KEY),
 * then ~/.keys/redmine.env (see config/redmine.env.example in the repo root) —
 * never a value committed to this repo.
 */
export function loadRedmineConfig(): RedmineConfig {
  const fileEnv = readEnvFile(keyFilePath());
  const baseUrl = process.env.REDMINE_URL || fileEnv.REDMINE_URL;
  const apiKey = process.env.REDMINE_API_KEY || fileEnv.REDMINE_API_KEY;

  if (!baseUrl || !apiKey) {
    const missing = [
      !baseUrl ? "REDMINE_URL" : undefined,
      !apiKey ? "REDMINE_API_KEY" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Redmine chưa được cấu hình: thiếu ${missing}. Đặt biến môi trường hoặc copy ` +
        `config/redmine.env.example sang ~/.keys/redmine.env rồi điền URL/API key thật.`,
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
