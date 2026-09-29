export type ActivityEvent = {
  type: string;
  text?: string;
  name?: string;
  value?: string;
  at: number;
};

export type ActivityAgent = {
  id: string;
  name?: string;
  role?: string;
  model?: string;
  status: string;
  currentActivity?: string;
  previewMarkdown?: string;
};

export type ActivitySession = {
  events: ActivityEvent[];
  agents: ActivityAgent[];
  preview?: string;
  updatedAt: number;
};

export function providerBadge(model?: string, agentName?: string): string {
  const fullModel = model || agentName?.match(/\(([^()]*)\)\s*$/)?.[1];
  const provider = fullModel?.split("/", 1)[0]?.trim().toLowerCase();
  if (!provider) return "";
  if (provider === "openai-codex") return "Codex";
  if (provider === "claude-code" || provider === "anthropic") return "Claude";
  if (provider === "antigravity") return "Antigravity";
  return provider
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function activityFeedEvents(
  session: ActivitySession | undefined,
  selectedNodeId: string,
): ActivityEvent[] {
  if (!session) return [];
  if (selectedNodeId === "supervisor")
    return [
      ...session.events,
      ...(session.preview
        ? [{ type: "assistant", text: session.preview, at: session.updatedAt }]
        : []),
    ];

  const agent = session.agents.find(({ id }) => id === selectedNodeId);
  if (!agent) return [];
  const items = (agent.currentActivity ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line && !/^\*?\d+s\*?$/.test(line))
    .map((text) => ({
      type: "tool",
      name: agent.role || agent.name || "subagent",
      text,
      at: session.updatedAt,
    }));
  if (agent.previewMarkdown)
    items.push({
      type: "assistant",
      name: "Assistant",
      text: agent.previewMarkdown,
      at: session.updatedAt,
    });
  return items;
}
