import { existsSync, readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://redmine.vietis.com.vn:93/redmine";
const DEFAULT_KEY_FILE = join(homedir(), ".cursor", "mcp-redmine", "api-key");

const httpsAgent = new Agent({
  rejectUnauthorized: false,
});

export interface RedmineConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyFile?: string;
}

export interface RedmineIssue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  subject: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  done_ratio?: number;
  estimated_hours?: number;
  created_on: string;
  updated_on: string;
  custom_fields?: Array<{ id: number; name: string; value: unknown }>;
  journals?: Array<{
    id: number;
    user: { id: number; name: string };
    notes?: string;
    created_on: string;
  }>;
}

export class RedmineClient {
  private baseUrl: string;
  private apiKeyFile: string;

  constructor(config?: RedmineConfig) {
    this.baseUrl =
      config?.baseUrl || process.env.REDMINE_URL || DEFAULT_BASE_URL;
    this.apiKeyFile =
      config?.apiKeyFile ||
      process.env.REDMINE_API_KEY_FILE ||
      DEFAULT_KEY_FILE;
  }

  public getApiKey(): string {
    if (process.env.REDMINE_API_KEY) {
      return process.env.REDMINE_API_KEY.trim();
    }
    if (existsSync(this.apiKeyFile)) {
      return readFileSync(this.apiKeyFile, "utf8").trim();
    }
    throw new Error(
      `Redmine API key not found. Please set REDMINE_API_KEY env or save your API key to ${this.apiKeyFile}`,
    );
  }

  public async request<T = unknown>(
    path: string,
    method = "GET",
    bodyData?: unknown,
  ): Promise<T> {
    const apiKey = this.getApiKey();
    const url = new URL(`${this.baseUrl}${path}`);

    return new Promise<T>((resolve, reject) => {
      const payload = bodyData ? JSON.stringify(bodyData) : undefined;

      const req = request(
        url,
        {
          method,
          agent: httpsAgent,
          headers: {
            "X-Redmine-API-Key": apiKey,
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode ?? 500;
            if (statusCode >= 200 && statusCode < 300) {
              if (!data.trim()) {
                resolve({} as T);
                return;
              }
              try {
                resolve(JSON.parse(data) as T);
              } catch {
                resolve(data as unknown as T);
              }
            } else {
              reject(
                new Error(
                  `Redmine HTTP ${statusCode} on ${method} ${path}: ${data || res.statusMessage}`,
                ),
              );
            }
          });
        },
      );

      req.on("error", (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  public async getIssue(
    id: number,
    includeNotes = false,
  ): Promise<RedmineIssue> {
    const query = includeNotes ? "?include=journals" : "";
    const res = await this.request<{ issue: RedmineIssue }>(
      `/issues/${id}.json${query}`,
    );
    return res.issue;
  }

  public async listIssues(params?: {
    projectId?: string | number;
    statusId?: string | number;
    limit?: number;
    offset?: number;
  }): Promise<{ issues: RedmineIssue[]; total_count?: number }> {
    const query = new URLSearchParams();
    query.set("project_id", String(params?.projectId ?? "466"));
    query.set("status_id", String(params?.statusId ?? "*"));
    query.set("limit", String(params?.limit ?? 50));
    if (params?.offset) query.set("offset", String(params.offset));
    query.set("sort", "id:desc");

    return this.request<{ issues: RedmineIssue[]; total_count?: number }>(
      `/issues.json?${query.toString()}`,
    );
  }

  public async addComment(id: number, notes: string): Promise<void> {
    await this.request(`/issues/${id}.json`, "PUT", {
      issue: { notes },
    });
  }

  public async logTime(params: {
    issueId: number;
    spentOn: string;
    hours: number;
    comments?: string;
    activityId?: number;
  }): Promise<void> {
    await this.request("/time_entries.json", "POST", {
      time_entry: {
        issue_id: params.issueId,
        spent_on: params.spentOn,
        hours: params.hours,
        comments: params.comments ?? "",
        activity_id: params.activityId ?? 16,
      },
    });
  }
}
