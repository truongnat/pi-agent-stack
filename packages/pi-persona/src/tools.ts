import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as t from "typebox";
import { PersonaStore } from "./store.ts";
import type { PreferenceCategory } from "./types.ts";

const GetPersonaSchema = t.Object({
  category: t.Optional(
    t.Union(
      [t.Literal("coding"), t.Literal("workflow"), t.Literal("communication")],
      { description: "Optional category filter." },
    ),
  ),
});

const MAX_RULE_CHARS = 200;

const UpdatePersonaSchema = t.Object({
  category: t.Union(
    [t.Literal("coding"), t.Literal("workflow"), t.Literal("communication")],
    { description: "Category of the habit." },
  ),
  key: t.String({
    description: 'Short identifier for the habit (e.g. "early_returns").',
  }),
  rule: t.String({ description: "The exact rule or habit instruction." }),
  initial_weight: t.Optional(
    t.Number({
      description: "Initial confidence weight (0.1 to 1.0, default 0.8).",
    }),
  ),
});

const FeedbackPersonaSchema = t.Object({
  key_or_id: t.String({ description: "Identifier of the habit." }),
  signal: t.Union([t.Literal("positive"), t.Literal("negative")], {
    description: "Whether to reinforce (+0.05) or penalize (-0.15) the habit.",
  }),
  updated_rule: t.Optional(
    t.String({
      description: "Optional revised rule if penalizing/correcting.",
    }),
  ),
});

export function createPersonaTools(store: PersonaStore) {
  const getPersonaTool: ToolDefinition<typeof GetPersonaSchema, any> =
    defineTool({
      name: "get_persona",
      label: "Get Persona Habits",
      description:
        "Retrieve the active developer persona profile, learned coding habits, and reinforcement weights.",
      promptSnippet:
        'get_persona({ category?: "coding" | "workflow" | "communication" })',
      parameters: GetPersonaSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params): Promise<any> {
        const prefs = store.listPreferences(
          params.category as PreferenceCategory | undefined,
        );
        if (prefs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No persona habits found for the specified criteria.",
              },
            ],
            details: { count: 0, preferences: [] },
          };
        }

        const rows = prefs.map(
          (p) =>
            `• **[${p.category.toUpperCase()}] ${p.key}** (Confidence: \`${Math.round(p.weight * 100)}%\`, +${p.reinforcements}/-${p.rejections})\n  > ${p.rule}`,
        );

        return {
          content: [
            {
              type: "text",
              text: `### 👤 Learned Developer Persona (${prefs.length} habits):\n\n${rows.join("\n\n")}`,
            },
          ],
          details: {
            count: prefs.length,
            preferences: prefs,
          },
        };
      },
    });

  const updatePersonaTool: ToolDefinition<typeof UpdatePersonaSchema, any> =
    defineTool({
      name: "update_persona",
      label: "Update Persona Habit",
      description:
        "Explicitly teach or refine a developer habit in the Persona Engine.",
      promptSnippet:
        'update_persona({ category: "coding", key: "early_returns", rule: "Prefer guard clauses" })',
      parameters: UpdatePersonaSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params): Promise<any> {
        // The model calls this, and rules are injected into every later session: keep them
        // short and let only the user's own feedback push a rule to the top.
        if (params.rule.length > MAX_RULE_CHARS) {
          // Pi reports a thrown error to the model as a failed tool call.
          throw new Error(
            `Rule rejected: keep persona rules under ${MAX_RULE_CHARS} characters.`,
          );
        }
        const updated = store.addOrUpdatePreference(
          params.category,
          params.key,
          params.rule,
          params.initial_weight ?? 0.8,
          true,
        );

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated persona habit **${updated.key}** (Confidence: ${Math.round(updated.weight * 100)}%).`,
            },
          ],
          details: updated,
        };
      },
    });

  const feedbackPersonaTool: ToolDefinition<typeof FeedbackPersonaSchema, any> =
    defineTool({
      name: "feedback_persona",
      label: "Feedback Persona Habit",
      description:
        "Provide reinforcement or penalty feedback to a learned habit to adjust its confidence weight.",
      promptSnippet:
        'feedback_persona({ key_or_id: "direct_no_fluff", signal: "positive" })',
      parameters: FeedbackPersonaSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params): Promise<any> {
        const ok =
          params.signal === "positive"
            ? store.recordPositiveReinforcement(params.key_or_id, true)
            : store.recordNegativeCorrection(
                params.key_or_id,
                params.updated_rule,
              );

        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Recorded ${params.signal} feedback for habit "${params.key_or_id}".`
                : `Could not find habit "${params.key_or_id}".`,
            },
          ],
          isError: !ok,
          details: { success: ok },
        };
      },
    });

  return {
    getPersonaTool,
    updatePersonaTool,
    feedbackPersonaTool,
  };
}
