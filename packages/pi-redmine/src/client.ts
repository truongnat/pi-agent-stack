import { loadRedmineConfig, type RedmineConfig } from "./config.ts";

export interface RedmineNamedRef {
  id: number;
  name: string;
}

export interface RedmineCustomField {
  id: number;
  name: string;
  value: unknown;
}

export interface RedmineJournal {
  id: number;
  user?: RedmineNamedRef;
  notes: string;
  created_on: string;
}

export interface RedmineAttachment {
  id: number;
  filename: string;
  filesize: number;
  content_type?: string;
  content_url: string;
  created_on: string;
}

export interface RedmineIssue {
  id: number;
  subject: string;
  description?: string;
  status: RedmineNamedRef;
  tracker: RedmineNamedRef;
  project: RedmineNamedRef;
  priority?: RedmineNamedRef;
  author?: RedmineNamedRef;
  assigned_to?: RedmineNamedRef;
  created_on: string;
  updated_on: string;
  custom_fields?: RedmineCustomField[];
  journals?: RedmineJournal[];
  attachments?: RedmineAttachment[];
}

export interface RedmineSearchResult {
  id: number;
  title: string;
  type: string;
  url: string;
  description?: string;
  datetime?: string;
}

/**
 * Thin wrapper over the Redmine REST API. Points at whatever instance `config`
 * resolves to. Config is resolved lazily (on first request), not at construction:
 * merely importing/instantiating this class must never throw for an unconfigured
 * deployment — only actually calling it should.
 */
export class RedmineClient {
  private config?: RedmineConfig;

  constructor(config?: RedmineConfig) {
    this.config = config;
  }

  private resolveConfig(): RedmineConfig {
    this.config ??= loadRedmineConfig();
    return this.config;
  }

  private async request<T>(
    path: string,
    searchParams?: Record<string, string>,
  ): Promise<T> {
    const config = this.resolveConfig();
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(key, value);
    }
    const res = await fetch(url, {
      headers: {
        "X-Redmine-API-Key": config.apiKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(
        `Redmine API error (${res.status}) at ${path}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Fetches one issue by numeric id (e.g. the ticket number from a Redmine URL). */
  async getIssue(
    issueId: number,
    opts: { includeJournals?: boolean; includeAttachments?: boolean } = {},
  ): Promise<RedmineIssue> {
    const include = [
      opts.includeJournals !== false ? "journals" : undefined,
      opts.includeAttachments !== false ? "attachments" : undefined,
    ]
      .filter(Boolean)
      .join(",");
    const data = await this.request<{ issue: RedmineIssue }>(
      `/issues/${issueId}.json`,
      include ? { include } : undefined,
    );
    return data.issue;
  }

  /** Global full-text search, scoped to issues (title/description/notes). */
  async searchIssues(params: {
    query: string;
    limit?: number;
  }): Promise<RedmineSearchResult[]> {
    const data = await this.request<{ results?: RedmineSearchResult[] }>(
      "/search.json",
      {
        q: params.query,
        issues: "1",
        limit: String(params.limit ?? 15),
      },
    );
    return data.results ?? [];
  }
}
