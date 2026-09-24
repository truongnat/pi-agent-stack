import * as t from "typebox";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RedmineClient, type RedmineIssue } from "./client.ts";

const client = new RedmineClient();

function formatIssueMarkdown(issue: RedmineIssue): string {
  const lines: string[] = [
    `# Redmine Issue #${issue.id}: ${issue.subject}`,
    `- **Project**: ${issue.project.name} (#${issue.project.id})`,
    `- **Tracker**: ${issue.tracker.name}`,
    `- **Status**: ${issue.status.name}`,
    `- **Priority**: ${issue.priority.name}`,
    `- **Author**: ${issue.author.name}`,
    `- **Assigned To**: ${issue.assigned_to?.name ?? "(Unassigned)"}`,
    `- **Start Date**: ${issue.start_date ?? "N/A"} | **Due Date**: ${issue.due_date ?? "N/A"}`,
    `- **Done**: ${issue.done_ratio ?? 0}% | **Estimated Hours**: ${issue.estimated_hours ?? "N/A"}`,
    `- **Updated On**: ${issue.updated_on}`,
    "",
    "## Description",
    issue.description || "(No description provided)",
    "",
  ];

  if (issue.custom_fields && issue.custom_fields.length > 0) {
    const activeFields = issue.custom_fields.filter(
      (f) => f.value !== null && f.value !== "" && f.value !== undefined,
    );
    if (activeFields.length > 0) {
      lines.push("## Custom Fields");
      for (const f of activeFields) {
        lines.push(
          `- **${f.name}**: ${Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}`,
        );
      }
      lines.push("");
    }
  }

  if (issue.journals && issue.journals.length > 0) {
    lines.push("## Notes & History");
    const notesOnly = issue.journals.filter(
      (j) => j.notes && j.notes.trim().length > 0,
    );
    if (notesOnly.length === 0) {
      lines.push("(No comment notes recorded)");
    } else {
      for (const j of notesOnly) {
        lines.push(`### Note from ${j.user.name} on ${j.created_on}`);
        lines.push(j.notes!);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// 1. Tool: redmine_get_issue
const GetIssueSchema = t.Object({
  issue_id: t.Integer({
    description: "The Redmine issue / ticket ID number (e.g. 240598).",
  }),
  include_notes: t.Optional(
    t.Boolean({
      description:
        "Whether to include journals / discussion notes history. Defaults to true.",
      default: true,
    }),
  ),
});

export const getIssueTool: ToolDefinition<typeof GetIssueSchema> = defineTool({
  name: "redmine_get_issue",
  label: "Redmine Get Issue",
  description:
    "Fetch complete details of a VietIS Redmine issue/ticket by ID, including subject, status, description, assignees, and comment notes.",
  promptSnippet:
    "redmine_get_issue(issue_id, include_notes) — fetch issue details and notes from Redmine",
  parameters: GetIssueSchema,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      const issue = await client.getIssue(
        params.issue_id,
        params.include_notes ?? true,
      );
      return {
        content: [{ type: "text", text: formatIssueMarkdown(issue) }],
        details: {
          issue_id: issue.id,
          status: issue.status.name,
          subject: issue.subject,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching Redmine ticket #${params.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
});

// 2. Tool: redmine_list_issues
const ListIssuesSchema = t.Object({
  project_id: t.Optional(
    t.Union([t.String(), t.Integer()], {
      description:
        "Project ID or identifier (default: 466 for BSN.IPalet.Geni).",
      default: "466",
    }),
  ),
  status_id: t.Optional(
    t.String({
      description:
        'Status ID filter: "open", "closed", or "*" for all (default: "open").',
      default: "open",
    }),
  ),
  limit: t.Optional(
    t.Integer({
      description:
        "Maximum number of tickets to return (default: 25, max: 100).",
      default: 25,
    }),
  ),
});

export const listIssuesTool: ToolDefinition<typeof ListIssuesSchema> =
  defineTool({
    name: "redmine_list_issues",
    label: "Redmine List Issues",
    description:
      "List or search issues from VietIS Redmine for a project and status.",
    promptSnippet:
      "redmine_list_issues(project_id, status_id, limit) — list tickets from Redmine",
    parameters: ListIssuesSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      try {
        const res = await client.listIssues({
          projectId: params.project_id ?? "466",
          statusId: params.status_id ?? "open",
          limit: params.limit ?? 25,
        });

        if (!res.issues || res.issues.length === 0) {
          return {
            content: [
              { type: "text", text: "No tickets found matching criteria." },
            ],
            details: { count: 0 },
          };
        }

        const tableRows = res.issues.map(
          (i) =>
            `| #${i.id} | ${i.tracker?.name ?? "-"} | ${i.status?.name ?? "-"} | ${i.assigned_to?.name ?? "-"} | ${i.subject} |`,
        );

        const text = [
          `### Redmine Issues (Total: ${res.total_count ?? res.issues.length})`,
          "| ID | Tracker | Status | Assignee | Subject |",
          "| --- | --- | --- | --- | --- |",
          ...tableRows,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { count: res.issues.length, total: res.total_count },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing Redmine issues: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

// 3. Tool: redmine_add_comment
const AddCommentSchema = t.Object({
  issue_id: t.Integer({
    description: "The target Redmine ticket ID.",
  }),
  notes: t.String({
    description: "Comment / note text to post to the issue.",
  }),
});

export const addCommentTool: ToolDefinition<typeof AddCommentSchema> =
  defineTool({
    name: "redmine_add_comment",
    label: "Redmine Add Comment",
    description: "Add a discussion comment / note to a VietIS Redmine ticket.",
    promptSnippet:
      "redmine_add_comment(issue_id, notes) — post note to Redmine ticket",
    parameters: AddCommentSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      try {
        await client.addComment(params.issue_id, params.notes);
        return {
          content: [
            {
              type: "text",
              text: `Successfully posted comment to Redmine issue #${params.issue_id}.`,
            },
          ],
          details: { issue_id: params.issue_id, success: true },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error commenting on Redmine issue #${params.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

// 4. Tool: redmine_log_time
const LogTimeSchema = t.Object({
  issue_id: t.Integer({
    description: "The Redmine ticket ID.",
  }),
  date: t.String({
    description: "Spent date in YYYY-MM-DD format.",
  }),
  hours: t.Number({
    description: "Number of hours spent (e.g. 1.5, 2.0).",
  }),
  comment: t.Optional(
    t.String({
      description: "Description of the work performed.",
    }),
  ),
  activity_id: t.Optional(
    t.Integer({
      description: "Activity ID (default 16 = Coding / Development).",
      default: 16,
    }),
  ),
});

export const logTimeTool: ToolDefinition<typeof LogTimeSchema> = defineTool({
  name: "redmine_log_time",
  label: "Redmine Log Time",
  description: "Log spent time hours for a VietIS Redmine ticket.",
  promptSnippet:
    "redmine_log_time(issue_id, date, hours, comment, activity_id) — log time entry in Redmine",
  parameters: LogTimeSchema,
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    try {
      await client.logTime({
        issueId: params.issue_id,
        spentOn: params.date,
        hours: params.hours,
        comments: params.comment,
        activityId: params.activity_id ?? 16,
      });
      return {
        content: [
          {
            type: "text",
            text: `Successfully logged ${params.hours}h on ${params.date} for Redmine issue #${params.issue_id}.`,
          },
        ],
        details: {
          issue_id: params.issue_id,
          hours: params.hours,
          date: params.date,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error logging time on Redmine issue #${params.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
});
