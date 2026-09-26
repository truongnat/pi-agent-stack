import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { extractPreferencesFromPrompt } from "./extractor.ts";
import { PersonaStore } from "./store.ts";
import { synthesizePersonaPrompt } from "./synthesizer.ts";
import { createPersonaTools } from "./tools.ts";
import type { PreferenceCategory } from "./types.ts";

function sendPersonaMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: string,
  details?: Record<string, unknown>,
) {
  if (typeof pi.sendMessage === "function") {
    pi.sendMessage({
      customType: "persona",
      content,
      display: true,
      details,
    } as any);
  } else {
    ctx.ui.notify(content, "info");
  }
}

export function createPersonaExtension(pi: ExtensionAPI) {
  const store = new PersonaStore();

  // Expose bridge for pi-jev-harness and other extensions
  (globalThis as any).piAgentStackPersona = {
    getPersonaPrompt: (task: string) => synthesizePersonaPrompt(store, task),
    getPreferences: (category?: PreferenceCategory) =>
      store.listPreferences(category),
    recordFeedback: (key: string, signal: "positive" | "negative") =>
      signal === "positive"
        ? store.recordPositiveReinforcement(key)
        : store.recordNegativeCorrection(key),
  };

  // Custom message renderer for persona messages
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(
      "persona",
      (message, { expanded, outputPad }, theme) => {
        const raw =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content, null, 2);
        const badge = theme.fg("accent", theme.bold("[ 👤 PERSONA ]"));
        const header = `${badge} ${theme.bold("Developer Persona & Active Habits")}`;

        let displayContent = raw;
        if (!expanded) {
          const lines = raw.split("\n");
          if (lines.length > 8) {
            displayContent =
              lines.slice(0, 8).join("\n") +
              `\n\n*... and ${lines.length - 8} more lines (expand to view)*`;
          }
        }

        const box = new Box(outputPad ?? 1, 0, (t) =>
          theme.bg("customMessageBg", t),
        );
        box.addChild(new Text(header, 0, 0));
        const mdTheme = getMarkdownTheme();
        box.addChild(new Markdown(displayContent, 1, 0, mdTheme));
        return box;
      },
    );
  }

  // 1. Register Tools
  const { getPersonaTool, updatePersonaTool, feedbackPersonaTool } =
    createPersonaTools(store);
  pi.registerTool(getPersonaTool);
  pi.registerTool(updatePersonaTool);
  pi.registerTool(feedbackPersonaTool);

  // 2. Lifecycle Hooks
  pi.on("session_start", () => {
    store.loadProfile();
  });

  pi.on("before_agent_start", (event, _ctx) => {
    if (!store.config.enabled) return undefined;

    // Implicit Learning: Extract preference signals from prompt
    const signals = extractPreferencesFromPrompt(event.prompt);
    for (const sig of signals) {
      store.addOrUpdatePreference(
        sig.category,
        sig.key,
        sig.rule,
        sig.confidence,
      );
    }

    // Synthesize persona guidance as tail message to protect prefix cache
    const personaBlock = synthesizePersonaPrompt(
      store,
      event.prompt,
      store.config.maxInjectedTokens,
    );
    if (!personaBlock) return undefined;

    return {
      message: { customType: "persona", content: personaBlock, display: false },
    };
  });

  // 3. Register Slash Command: /persona
  pi.registerCommand("persona", {
    description:
      "Developer Persona & Habit Engine: /persona [list|learn <text>|reset|status]",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();

      if (input === "status") {
        const prefs = store.listPreferences();
        const text = [
          "### 👤 Developer Persona Engine Status",
          "",
          `- **Status**: ${store.config.enabled ? "🟢 Active" : "⚪ Disabled"}`,
          `- **Total Learned Habits**: \`${prefs.length}\``,
          `- **Storage**: \`~/.pi/agent/persona.json\``,
          `- **Export Profile**: \`~/.pi/agent/persona.md\``,
        ].join("\n");
        sendPersonaMessage(pi, ctx, text, { action: "status" });
        return;
      }

      if (input === "list") {
        const prefs = store.listPreferences();
        if (prefs.length === 0) {
          sendPersonaMessage(
            pi,
            ctx,
            "No custom persona habits recorded yet. Use `/persona learn <text>` to add habits.",
            { action: "list" },
          );
          return;
        }
        const rows = prefs.map(
          (p) =>
            `- **[${p.category.toUpperCase()}] \`${p.key}\`** (\`${Math.round(p.weight * 100)}%\` conf, +${p.reinforcements}/-${p.rejections})\n  > ${p.rule}`,
        );
        sendPersonaMessage(
          pi,
          ctx,
          `### 👤 Active Persona Habits (${prefs.length})\n\n${rows.join("\n\n")}`,
          { action: "list" },
        );
        return;
      }

      if (input.startsWith("learn ")) {
        const text = input.replace("learn ", "").trim();
        const signals = extractPreferencesFromPrompt(text);
        if (signals.length > 0) {
          for (const sig of signals) {
            store.addOrUpdatePreference(
              sig.category,
              sig.key,
              sig.rule,
              sig.confidence,
            );
          }
          sendPersonaMessage(
            pi,
            ctx,
            `✓ Learned ${signals.length} habit(s) from input: "${text}"`,
            { action: "learn" },
          );
        } else {
          // Fallback: generic coding habit
          store.addOrUpdatePreference(
            "coding",
            `custom_${Date.now().toString(36)}`,
            text,
            0.85,
          );
          sendPersonaMessage(pi, ctx, `✓ Added custom habit: "${text}"`, {
            action: "learn",
          });
        }
        return;
      }

      if (input === "reset") {
        store.resetToDefaults();
        sendPersonaMessage(
          pi,
          ctx,
          "✓ Reset Persona profile to default developer habits.",
          { action: "reset" },
        );
        return;
      }

      // Interactive UI menu
      if (!ctx.hasUI) {
        sendPersonaMessage(
          pi,
          ctx,
          "Usage: /persona [status|list|learn <text>|reset]",
          { action: "help" },
        );
        return;
      }

      const prefs = store.listPreferences();
      const menuItems = [
        `📋 List Learned Habits (${prefs.length} total)`,
        "➕ Learn New Habit From Text",
        "🔄 Reset Habits to Defaults",
        "📊 View Persona Status",
        "❌ Close Menu",
      ];

      const picked = await ctx.ui.select(
        "👤 Developer Persona & Style Manager",
        menuItems,
      );
      if (!picked) return;

      if (picked.startsWith("📋 List")) {
        const rows = prefs.map(
          (p) =>
            `- **[${p.category.toUpperCase()}] \`${p.key}\`** (\`${Math.round(p.weight * 100)}%\` conf)\n  > ${p.rule}`,
        );
        sendPersonaMessage(
          pi,
          ctx,
          `### 👤 Persona Habits (${prefs.length})\n\n${rows.join("\n\n")}`,
          { action: "list" },
        );
      } else if (picked.startsWith("➕ Learn")) {
        const text = await ctx.ui.input(
          "Enter habit or coding guideline to learn:",
        );
        if (text && text.trim()) {
          store.addOrUpdatePreference(
            "coding",
            `custom_${Date.now().toString(36)}`,
            text.trim(),
            0.85,
          );
          sendPersonaMessage(pi, ctx, `✓ Learned habit: "${text.trim()}"`, {
            action: "learn",
          });
        }
      } else if (picked.startsWith("🔄 Reset")) {
        store.resetToDefaults();
        sendPersonaMessage(
          pi,
          ctx,
          "✓ Reset Persona profile to default habits.",
          { action: "reset" },
        );
      } else if (picked.startsWith("📊 View")) {
        sendPersonaMessage(
          pi,
          ctx,
          `👤 Persona engine is active with ${prefs.length} learned habits.`,
          { action: "status" },
        );
      }
    },
  });

  return { store };
}
