import * as t from "typebox";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RedmineClient, type RedmineIssue } from "./client.ts";

const client = new RedmineClient();

function formatIssue(issue: RedmineIssue): string {
  const lines: string[] = [
    `### Redmine #${issue.id}: ${issue.subject}`,
    `- **Project**: ${issue.project?.name ?? "N/A"}`,
    `- **Tracker**: ${issue.tracker?.name ?? "N/A"}`,
    `- **Status**: ${issue.status?.name ?? "N/A"}`,
  ];
  if (issue.priority) lines.push(`- **Priority**: ${issue.priority.name}`);
  if (issue.author) lines.push(`- **Author**: ${issue.author.name}`);
  if (issue.assigned_to)
    lines.push(`- **Assigned to**: ${issue.assigned_to.name}`);
  lines.push(`- **Created**: ${issue.created_on}`);
  lines.push(`- **Updated**: ${issue.updated_on}`);

  if (issue.custom_fields?.length) {
    lines.push("", "**Custom fields**:");
    for (const f of issue.custom_fields) {
      const value = Array.isArray(f.value) ? f.value.join(", ") : f.value;
      if (value !== undefined && value !== null && value !== "") {
        lines.push(`- ${f.name}: ${value}`);
      }
    }
  }

  lines.push("", "**Description**:", "", issue.description || "(empty)");

  if (issue.journals?.length) {
    const withNotes = issue.journals.filter((j) => j.notes?.trim());
    if (withNotes.length) {
      lines.push("", "**Comments (journals)**:");
      for (const j of withNotes) {
        lines.push(
          `- [${j.created_on}] ${j.user?.name ?? "unknown"}: ${j.notes}`,
        );
      }
    }
  }

  if (issue.attachments?.length) {
    lines.push("", "**Attachments**:");
    for (const a of issue.attachments) {
      lines.push(`- \`${a.filename}\` (${a.filesize} bytes): ${a.content_url}`);
    }
  }

  return lines.join("\n");
}

// 1. Tool: redmine_get_issue
const RedmineGetIssueSchema = t.Object({
  issue_id: t.Integer({
    description: "Numeric Redmine issue/ticket id (e.g. 240466).",
  }),
  include_journals: t.Optional(
    t.Boolean({
      description: "Include comments/history (journals). Default: true.",
      default: true,
    }),
  ),
  include_attachments: t.Optional(
    t.Boolean({
      description: "Include the attachment list. Default: true.",
      default: true,
    }),
  ),
});

export const redmineGetIssueTool: ToolDefinition<
  typeof RedmineGetIssueSchema,
  any
> = defineTool({
  name: "redmine_get_issue",
  label: "Redmine Get Issue",
  description:
    "Fetch a Redmine issue/ticket by its numeric id: subject, description, status, custom fields, comments, and attachments. Use this to read the actual ticket content instead of guessing it from the prompt.",
  promptSnippet:
    "redmine_get_issue(issue_id, include_journals, include_attachments) — fetch a Redmine ticket",
  parameters: RedmineGetIssueSchema,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const issue = await client.getIssue(params.issue_id, {
        includeJournals: params.include_journals,
        includeAttachments: params.include_attachments,
      });
      return {
        content: [{ type: "text", text: formatIssue(issue) }],
        details: issue,
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching Redmine issue #${params.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
        details: undefined,
      };
    }
  },
});

// 2. Tool: redmine_search_issues
const RedmineSearchSchema = t.Object({
  query: t.String({
    description:
      'Search keyword (subject, description, or comment text), e.g. "AE08001" or "Function ID mapping".',
  }),
  limit: t.Optional(
    t.Integer({
      description: "Maximum number of results (default: 15, max: 50).",
      default: 15,
    }),
  ),
});

export const redmineSearchIssuesTool: ToolDefinition<
  typeof RedmineSearchSchema,
  any
> = defineTool({
  name: "redmine_search_issues",
  label: "Redmine Search Issues",
  description:
    "Full-text search Redmine issues by keyword, returning id, title, and a short excerpt for each match.",
  promptSnippet:
    "redmine_search_issues(query, limit) — search Redmine issues by keyword",
  parameters: RedmineSearchSchema,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const results = await client.searchIssues({
        query: params.query,
        limit: params.limit ?? 15,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No Redmine issues found matching: "${params.query}"`,
            },
          ],
          details: { count: 0, results: [] },
        };
      }

      const rows = results.map(
        (r) => `| ${r.id} | ${r.title} | ${r.type} | ${r.url} |`,
      );
      const text = [
        `### Redmine Search Results for: "${params.query}" (Found: ${results.length})`,
        "| Id | Title | Type | URL |",
        "| --- | --- | --- | --- |",
        ...rows,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { count: results.length, results },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching Redmine: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
        details: undefined,
      };
    }
  },
});
