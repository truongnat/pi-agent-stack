<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Component,
} from "vue";
import { MotionConfig } from "motion-v";
import DOMPurify from "dompurify";
import {
  Bot,
  Bug,
  Code2,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FlaskConical,
  Folder,
  FolderSearch,
  CircleCheck,
  CircleX,
  LaptopMinimal,
  MessageSquareText,
  PanelLeft,
  PanelLeftClose,
  Scale,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
  X,
} from "lucide-vue-next";
import { marked } from "marked";
import { Background } from "@vue-flow/background";
import { Handle, Position, VueFlow } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";

type Agent = {
  id: string;
  name?: string;
  role?: string;
  model?: string;
  status: string;
  currentActivity?: string;
  previewMarkdown?: string;
  prompt?: string;
};
type Activity = {
  type: string;
  text?: string;
  name?: string;
  value?: string;
  at: number;
};
type Session = {
  id: string;
  title: string;
  cwd: string;
  status: string;
  events: Activity[];
  agents: Agent[];
  edges: { from: string; to: string }[];
  preview?: string;
  currentActivity?: string;
};

const toolIcons: Record<string, Component> = {
  read: FileSearch,
  write: FilePlus2,
  edit: FilePenLine,
  bash: Terminal,
  grep: Search,
  find: FolderSearch,
  ls: Folder,
};

const sessions = ref<Session[]>([]);
const selectedId = ref("");
const selectedNodeId = ref("");
const sidebarOpen = ref(true);
const nodePositions = ref<Record<string, { x: number; y: number }>>({});
const viewportWidth = ref(1280);
const graphColumns = computed(() =>
  viewportWidth.value <= 760 ? 1 : viewportWidth.value >= 1360 ? 3 : 2,
);
const connection = ref<"connecting" | "live" | "offline">("connecting");
const selected = computed(() =>
  sessions.value.find(({ id }) => id === selectedId.value),
);
const selectedAgent = computed(() =>
  selected.value?.agents.find(({ id }) => id === selectedNodeId.value),
);
const selectedIsSupervisor = computed(
  () => selectedNodeId.value === "supervisor",
);
const detailOpen = computed(
  () => selectedIsSupervisor.value || !!selectedAgent.value,
);
const feed = ref<HTMLElement | null>(null);
const nearBottom = ref(true);
const feedEvents = computed(() => {
  const items = [...(selected.value?.events ?? [])];
  const agent = selectedAgent.value;
  if (agent?.currentActivity)
    items.push({
      type: "tool",
      name: agent.role,
      text: agent.currentActivity,
      at: Date.now(),
    });
  if (agent?.previewMarkdown)
    items.push({
      type: "assistant",
      text: agent.previewMarkdown,
      at: Date.now(),
    });
  else if (selected.value?.preview)
    items.push({
      type: "assistant",
      text: selected.value.preview,
      at: Date.now(),
    });
  return items;
});
function nodePosition(id: string, fallback: { x: number; y: number }) {
  return nodePositions.value[id] ?? fallback;
}
const graphNodes = computed(() => {
  const session = selected.value;
  if (!session) return [];
  const cardWidth = 148;
  const gap = 28;
  const step = cardWidth + gap;
  const columns = graphColumns.value;
  const graphWidth = columns * cardWidth + (columns - 1) * gap;
  const supervisorWidth = 132;
  return [
    {
      id: "supervisor",
      type: "supervisor",
      position: nodePosition("supervisor", {
        x: (graphWidth - supervisorWidth) / 2,
        y: 28,
      }),
      style: { width: `${supervisorWidth}px` },
      data: { title: session.title, status: session.status },
      sourcePosition: Position.Bottom,
      draggable: true,
      selectable: true,
    },
    ...session.agents.map((agent, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const itemsInRow = Math.min(
        columns,
        session.agents.length - row * columns,
      );
      const rowWidth = itemsInRow * cardWidth + (itemsInRow - 1) * gap;
      return {
        id: agent.id,
        type: "agent",
        position: nodePosition(agent.id, {
          x: (graphWidth - rowWidth) / 2 + column * step,
          y: 112 + row * 76,
        }),
        style: { width: `${cardWidth}px` },
        data: { agent },
        targetPosition: Position.Top,
        draggable: agentIsActive(agent),
        selectable: true,
      };
    }),
  ];
});
const graphEdges = computed(() =>
  (selected.value?.agents ?? []).map((agent) => ({
    id: `supervisor-${agent.id}`,
    source: "supervisor",
    target: agent.id,
    type: "smoothstep",
    animated: agentIsActive(agent),
    style: {
      stroke: agentIsActive(agent) ? "#c99a58" : "#465a53",
      strokeWidth: 2,
    },
  })),
);
let source: EventSource | undefined;
function updateViewportWidth() {
  viewportWidth.value = window.innerWidth;
}

function renderMarkdown(value: string) {
  return DOMPurify.sanitize(marked.parse(value, { async: false }), {
    USE_PROFILES: { html: true },
  });
}

function receive(event: MessageEvent<string>) {
  const snapshot = JSON.parse(event.data) as { sessions: Session[] };
  sessions.value = snapshot.sessions;
  if (!sessions.value.some(({ id }) => id === selectedId.value)) {
    selectedId.value = sessions.value[0]?.id ?? "";
    selectedNodeId.value = "";
    nodePositions.value = {};
  }
}

function selectSession(id: string) {
  if (selectedId.value === id) return;
  selectedId.value = id;
  selectedNodeId.value = "";
  nodePositions.value = {};
}

function onNodeClick(payload: { node: { id: string } }) {
  selectedNodeId.value =
    selectedNodeId.value === payload.node.id ? "" : payload.node.id;
}

function onNodeDragStop(payload: {
  node: { id: string; position: { x: number; y: number } };
}) {
  nodePositions.value = {
    ...nodePositions.value,
    [payload.node.id]: payload.node.position,
  };
}

function roleIcon(role?: string): Component {
  switch ((role || "").toLowerCase()) {
    case "researcher":
      return Search;
    case "coder":
      return Code2;
    case "tester":
      return FlaskConical;
    case "debugger":
      return Bug;
    case "reviewer":
      return Scale;
    default:
      return Bot;
  }
}

function clip(value: string, n: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1)}…`;
}

function sessionTitle(session?: Session) {
  const user = session?.events?.find((event) => event.type === "user")?.text;
  const fromEvents = user?.split("\n").find((line) => line.trim());
  const raw = (fromEvents || session?.title || "").trim();
  const cleaned = raw.replace(/^Pi(\s*[·.•]\s*|\s*)\d*$/i, "").trim();
  if (cleaned) return clip(cleaned, 56);
  const folder = session?.cwd?.split("/").filter(Boolean).at(-1);
  return folder || "Session";
}

function activityIcon(event: Activity) {
  if (event.type === "user") return MessageSquareText;
  if (event.type === "assistant") return Sparkles;
  if (event.type === "tool_done") return CircleCheck;
  if (event.type === "error") return CircleX;
  if (event.type === "tool") return toolIcons[event.name ?? ""] ?? Wrench;
  return Sparkles;
}

function onFeedScroll() {
  if (!feed.value) return;
  nearBottom.value =
    feed.value.scrollHeight - feed.value.scrollTop - feed.value.clientHeight <
    64;
}

function scrollToLatest() {
  if (!feed.value) return;
  feed.value.scrollTop = feed.value.scrollHeight;
  nearBottom.value = true;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function agentIsActive(agent: Agent) {
  return ["running", "streaming", "working", "starting"].includes(agent.status);
}

function agentStateClass(agent: Agent) {
  const status = agent.status.toLowerCase();
  if (
    ["completed", "complete", "success", "succeeded", "done"].includes(status)
  )
    return "completed";
  if (["failed", "error", "killed", "cancelled", "canceled"].includes(status))
    return "failed";
  return agentIsActive(agent) ? "running" : "pending";
}

function agentLabel(agent: Agent) {
  return agentGivenName(agent);
}

function agentGivenName(agent: Agent) {
  const raw = (agent.name || "").trim();
  if (!raw) return agent.role || "Agent";
  const short = raw.split(" - ")[0]?.trim();
  return short || raw;
}

function roleClass(role?: string) {
  return `role-${(role || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
}

function statusLabel(status: string) {
  const value = status.toLowerCase();
  if (["running", "streaming", "working", "starting"].includes(value))
    return "running";
  if (["completed", "complete", "success", "succeeded", "done"].includes(value))
    return "done";
  if (["failed", "error", "killed", "cancelled", "canceled"].includes(value))
    return "failed";
  return value || "idle";
}

function agentActivity(agent: Agent) {
  if (agent.currentActivity) {
    const lines = agent.currentActivity
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^\*\d+s\*$/.test(line));
    return lines.at(-1)?.replace(/^-\s*/, "") || agent.currentActivity;
  }
  return agent.previewMarkdown || agent.prompt || "Waiting for work";
}

function shortPath(path: string) {
  return path.replace(/^\/home\/[^/]+/, "~");
}

function agentIcon(agent: Agent) {
  return roleIcon(agent.role);
}

watch(
  [selectedNodeId, () => feedEvents.value.length, () => selected.value?.preview],
  async () => {
    await nextTick();
    if (nearBottom.value) scrollToLatest();
  },
);

onMounted(() => {
  updateViewportWidth();
  window.addEventListener("resize", updateViewportWidth);
  source = new EventSource("/events");
  source.addEventListener("open", () => (connection.value = "live"));
  source.addEventListener("error", () => (connection.value = "offline"));
  source.addEventListener("message", (event) =>
    receive(event as MessageEvent<string>),
  );
});

onUnmounted(() => {
  source?.close();
  window.removeEventListener("resize", updateViewportWidth);
});
</script>

<template>
  <MotionConfig reducedMotion="user">
    <div class="app-shell" :class="{ 'sidebar-collapsed': !sidebarOpen }">
      <aside class="sidebar" aria-label="Sessions">
        <div class="sidebar-top">
          <button
            class="sidebar-toggle"
            type="button"
            :aria-expanded="sidebarOpen"
            :aria-label="sidebarOpen ? 'Collapse sessions' : 'Expand sessions'"
            @click="sidebarOpen = !sidebarOpen"
          >
            <PanelLeftClose v-if="sidebarOpen" :size="16" :stroke-width="2" />
            <PanelLeft v-else :size="16" :stroke-width="2" />
          </button>
          <div v-if="sidebarOpen" class="sidebar-title">
            <strong>{{ sessionTitle(selected) }}</strong>
            <small>{{ sessions.length }} sessions</small>
          </div>
        </div>
        <nav class="session-list" aria-label="Active sessions">
          <button
            v-for="session in sessions"
            :key="session.id"
            class="session-button"
            :class="{ selected: session.id === selectedId }"
            :aria-pressed="session.id === selectedId"
            :title="sessionTitle(session)"
            @click="selectSession(session.id)"
          >
            <span class="session-icon" aria-hidden="true"
              ><Folder :size="16" :stroke-width="2"
            /></span>
            <span v-if="sidebarOpen" class="session-copy"
              ><strong>{{ sessionTitle(session) }}</strong
              ><small>{{ shortPath(session.cwd) }}</small></span
            >
            <span
              v-if="sidebarOpen"
              class="status-dot"
              :class="session.status === 'working' ? 'busy' : 'ready'"
              :aria-label="session.status"
            />
          </button>
          <div v-if="!sessions.length && sidebarOpen" class="sidebar-empty">
            No sessions connected
          </div>
        </nav>
        <div class="sidebar-bottom">
          <span class="connection-indicator" :class="connection"
            ><i /><template v-if="sidebarOpen">{{
              connection === "live"
                ? "Live"
                : connection === "offline"
                  ? "Reconnecting"
                  : "Connecting"
            }}</template></span
          >
        </div>
      </aside>

      <main class="main-area">
        <header class="topbar">
          <div class="breadcrumb">
            <strong>{{ sessionTitle(selected) }}</strong>
          </div>
          <div class="topbar-right">
            <span class="live-label"
              ><i />{{
                connection === "live"
                  ? "REALTIME"
                  : connection === "offline"
                    ? "RECONNECTING"
                    : "CONNECTING"
              }}</span
            ><span class="topbar-separator" /><span class="local-label"
              ><LaptopMinimal
                :size="15"
                :stroke-width="2"
                aria-hidden="true"
              />LOCAL</span
            >
          </div>
        </header>

        <div class="workspace" :key="selectedId">
          <section
            class="canvas-panel panel"
            aria-label="Live agent canvas"
          >
            <div
              class="canvas"
              :class="{ 'has-agents': selected?.agents.length }"
              role="application"
              :aria-label="`Agent tree for ${selected?.title ?? 'no selected session'}`"
            >
              <template v-if="selected">
                <VueFlow
                  :key="selected.id + ':' + graphColumns"
                  :nodes="graphNodes"
                  :edges="graphEdges"
                  :fit-view-on-init="true"
                  :fit-view-options="{ padding: 0.18, maxZoom: 1 }"
                  :min-zoom="0.35"
                  :max-zoom="1.15"
                  :nodes-draggable="true"
                  :pan-on-drag="false"
                  :nodes-connectable="false"
                  :elements-selectable="true"
                  :zoom-on-double-click="false"
                  class="agent-flow"
                  @node-click="onNodeClick"
                  @node-drag-stop="onNodeDragStop"
                >
                  <Background pattern-color="#30394a" :gap="24" :size="1" />
                  <template #node-supervisor="{ data }">
                    <div
                      class="agent-node supervisor"
                      :class="{
                        selected: selectedIsSupervisor,
                        running: data.status === 'working',
                      }"
                      :title="sessionTitle(selected)"
                      :aria-label="`Pi, supervisor, ${statusLabel(data.status)}`"
                    >
                      <Handle
                        type="source"
                        :position="Position.Bottom"
                        :connectable="false"
                      />
                      <span class="agent-node-mark" aria-hidden="true"
                        ><Workflow :size="16" :stroke-width="1.75" /><i
                          class="status-pip"
                      /></span>
                      <strong class="agent-node-title">Pi</strong>
                    </div>
                  </template>
                  <template #node-agent="{ data }">
                    <div
                      class="agent-node"
                      :class="[
                        roleClass(data.agent.role),
                        agentStateClass(data.agent),
                        { selected: selectedNodeId === data.agent.id },
                      ]"
                      :title="data.agent.name || agentGivenName(data.agent)"
                      :aria-label="`${agentGivenName(data.agent)}, ${data.agent.role || 'subagent'}, ${statusLabel(data.agent.status)}`"
                    >
                      <Handle
                        type="target"
                        :position="Position.Top"
                        :connectable="false"
                      />
                      <span class="agent-node-mark" aria-hidden="true"
                        ><component
                          :is="agentIcon(data.agent)"
                          :size="15"
                          :stroke-width="1.75"
                        /><i class="status-pip"
                      /></span>
                      <strong class="agent-node-title">{{
                        agentGivenName(data.agent)
                      }}</strong>
                    </div>
                  </template>
                </VueFlow>
              </template>
              <div v-else class="canvas-empty">
                <div class="orbit-preview">
                  <i /><i /><i /><span
                    ><svg viewBox="0 0 24 24">
                      <path d="M5 18V6h7a5 5 0 0 1 0 10H9m8-10v12" /></svg
                  ></span>
                </div>
                <strong>{{
                  selected ? "Ready for the next task" : "Select a session"
                }}</strong>
                <p>
                  {{
                    selected
                      ? "Delegated agents will appear here as Pi starts working."
                      : "Choose a Pi workspace from the sidebar to view its live activity."
                  }}
                </p>
              </div>
            </div>
            <div class="canvas-footer">
              <span
                ><span class="footer-key">{{
                  selected?.agents.length ?? 0
                }}</span>
                agents</span
              ><span class="graph-signal"><i /> synced</span>
            </div>
            <aside
              v-if="detailOpen"
              class="detail-panel"
              :aria-label="
                selectedAgent ? agentLabel(selectedAgent) : 'Activity'
              "
            >
              <header class="detail-head">
                <span class="graph-icon"
                  ><component
                    :is="selectedAgent ? agentIcon(selectedAgent) : Workflow"
                    :size="16"
                    :stroke-width="1.8"
                /></span>
                <div class="detail-copy">
                  <strong>{{
                    selectedAgent
                      ? agentLabel(selectedAgent)
                      : sessionTitle(selected)
                  }}</strong>
                  <small>{{
                    selectedAgent
                      ? selectedAgent.role || "subagent"
                      : "activity"
                  }}</small>
                </div>
                <span
                  class="graph-state"
                  :class="
                    selectedAgent
                      ? agentStateClass(selectedAgent)
                      : selected?.status === 'working'
                        ? 'running'
                        : 'idle'
                  "
                  ><i />{{
                    selectedAgent?.status || selected?.status || "idle"
                  }}</span
                >
                <button
                  class="detail-close"
                  type="button"
                  aria-label="Close details"
                  @click="selectedNodeId = ''"
                >
                  <X :size="14" :stroke-width="2" />
                </button>
              </header>
              <div
                class="activity-feed"
                ref="feed"
                @scroll="onFeedScroll"
                aria-live="polite"
              >
                <article
                  v-for="(event, index) in feedEvents"
                  :key="`${event.type}-${event.at}-${index}`"
                  class="activity-item"
                  :class="`event-${event.type}`"
                >
                  <span class="event-marker" aria-hidden="true">
                    <component
                      :is="activityIcon(event)"
                      :size="15"
                      :stroke-width="2"
                    />
                  </span>
                  <div class="event-content">
                    <div class="event-meta">
                      <strong>{{
                        event.type === "user"
                          ? "You"
                          : event.name ||
                            (event.type === "assistant"
                              ? "Assistant"
                              : event.type.replace("_", " "))
                      }}</strong
                      ><time>{{ formatTime(event.at) }}</time>
                    </div>
                    <div
                      class="markdown-body"
                      v-html="
                        renderMarkdown(
                          event.text ||
                            event.value ||
                            event.name ||
                            event.type,
                        )
                      "
                    />
                  </div>
                </article>
                <div v-if="!feedEvents.length" class="feed-empty">
                  <strong>No activity yet</strong>
                </div>
              </div>
            </aside>
          </section>
        </div>
      </main>
    </div>
  </MotionConfig>
</template>

<style>
:root {
  font-family:
    "Fira Sans",
    ui-sans-serif,
    system-ui,
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-size: 15px;
  color: #e7ecf4;
  background: #0b0d12;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  color-scheme: dark;
  font-optical-sizing: auto;
  --bg: #0b0d12;
  --surface: #10131b;
  --surface-raised: #151a24;
  --line: #202633;
  --muted: #778194;
  --subtle: #a1aabb;
  --text: #e7ecf4;
  --mint: #63dfc1;
  --amber: #edbd73;
  --red: #eb8383;
  --radius: 14px;
}
* {
  box-sizing: border-box;
}
html,
body {
  min-width: 360px;
  min-height: 100vh;
  margin: 0;
  font-size: 15px;
}
button,
a {
  font: inherit;
}
.app-shell {
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
  transition: grid-template-columns 0.18s ease;
}
.app-shell.sidebar-collapsed {
  grid-template-columns: 52px minmax(0, 1fr);
}
.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
  padding: 14px 10px 14px;
  background: #0e1118;
  border-right: 1px solid var(--line);
}
.sidebar-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 16px;
}
.sidebar-toggle {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border: 1px solid #2a3140;
  border-radius: 8px;
  color: #9aa5b7;
  background: #151a23;
  cursor: pointer;
}
.sidebar-toggle:hover,
.detail-close:hover {
  color: var(--text);
  border-color: #3a4454;
}
.sidebar-title {
  min-width: 0;
  flex: 1;
}
.sidebar-title strong {
  display: block;
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-title small {
  display: block;
  margin-top: 2px;
  color: #768195;
  font-size: 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 8px 35px;
  color: inherit;
  text-decoration: none;
}
.brand-mark {
  display: grid;
  width: 37px;
  height: 37px;
  place-items: center;
  border: 1px solid #31574f;
  border-radius: 12px;
  background: #12221f;
  color: var(--mint);
}
.brand-mark svg,
.session-icon svg,
.supervisor-icon svg,
.agent-glyph svg,
.local-label svg,
.empty-glyph svg,
.orbit-preview svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.65;
}
.session-icon svg {
  width: 18px;
  height: 18px;
  stroke-width: 2;
}
.brand strong {
  display: block;
  font-size: 16px;
  letter-spacing: -0.04em;
}
.brand-accent {
  color: var(--mint);
}
.brand small {
  display: block;
  margin-top: 3px;
  color: #768195;
  font-size: 12px;
  letter-spacing: 0.16em;
}
.sidebar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 9px 12px;
  color: #758094;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.count {
  display: grid;
  min-width: 20px;
  height: 20px;
  place-items: center;
  border: 1px solid #282e3b;
  border-radius: 7px;
  color: #a0a9b8;
  font-size: 12px;
  letter-spacing: 0;
}
.session-list {
  display: grid;
  gap: 5px;
}
.session-button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 10px 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.18s,
    border-color 0.18s,
    transform 0.18s;
}
.session-button:hover {
  background: #151a23;
}
.session-button:active {
  transform: scale(0.985);
}
.session-button:focus-visible,
.brand:focus-visible {
  outline: 2px solid var(--mint);
  outline-offset: 2px;
}
.session-button.selected {
  border-color: #273c3a;
  background: #15201f;
}
.session-icon {
  display: grid;
  width: 31px;
  height: 31px;
  flex: none;
  place-items: center;
  border: 1px solid #303644;
  border-radius: 9px;
  color: #a4aec0;
  background: #171b25;
}
.selected .session-icon {
  border-color: #31584e;
  color: var(--mint);
  background: #14221f;
}
.session-icon svg {
  width: 17px;
  height: 17px;
}
.session-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 4px;
}
.session-copy strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-copy small {
  overflow: hidden;
  color: #778194;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #718093;
}
.status-dot.busy {
  background: var(--amber);
  box-shadow:
    0 0 0 3px #edbd731a,
    0 0 12px #edbd7366;
  animation: dot-pulse 1.5s ease-in-out infinite;
}
.status-dot.ready {
  background: var(--mint);
}
.sidebar-empty {
  padding: 17px 9px;
  color: var(--muted);
  font-size: 13px;
}
.sidebar-bottom {
  display: grid;
  gap: 8px;
  margin-top: auto;
  padding: 17px 9px 0;
  border-top: 1px solid var(--line);
}
.sidebar-bottom > small {
  color: #697487;
  font-size: 12px;
}
.connection-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a4adbd;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
}
.connection-indicator i,
.live-label i,
.feed-footer .pulse,
.graph-signal i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mint);
  box-shadow: 0 0 9px #63dfc177;
}
.connection-indicator.offline i {
  background: var(--amber);
  box-shadow: 0 0 9px #edbd7366;
}
.connection-indicator.connecting i {
  background: #8994a6;
  animation: dot-pulse 1s infinite;
}
.main-area {
  display: grid;
  min-width: 0;
  min-height: 0;
  height: 100%;
  grid-template-rows: 62px minmax(0, 1fr);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 29px;
  border-bottom: 1px solid var(--line);
  background: #0d1016;
}
.breadcrumb,
.topbar-right {
  display: flex;
  align-items: center;
  gap: 11px;
}
.breadcrumb {
  min-width: 0;
  color: #7f899a;
  font-size: 12px;
}
.breadcrumb svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: #566174;
  stroke-width: 1.5;
}
.breadcrumb strong {
  overflow: hidden;
  color: #dce3ed;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-right {
  gap: 13px;
}
.live-label,
.local-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #9aa5b7;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
}
.live-label {
  color: var(--mint);
}
.topbar-separator {
  height: 16px;
  border-left: 1px solid #303644;
}
.local-label svg {
  width: 15px;
  height: 15px;
  color: #8490a3;
}
.workspace {
  display: grid;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 16px;
}
.canvas-panel.panel {
  position: relative;
}
.now-line {
  margin: 4px 0 0;
  max-width: 72ch;
  overflow: hidden;
  color: #9aa5b5;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.now-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 19px;
  border-bottom: 1px solid var(--line);
  background: #121820;
  color: #dce3ed;
  font-size: 13px;
}
.now-banner strong {
  flex: none;
  color: var(--mint);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.now-banner > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) 39px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 19px;
  border-bottom: 1px solid var(--line);
}
.eyebrow {
  color: #778397;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.panel-heading h1,
.panel-heading h2 {
  margin: 4px 0 0;
  color: #e8edf4;
  font-size: 16px;
  font-weight: 620;
  letter-spacing: -0.025em;
}
.event-count {
  color: #8993a4;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.1em;
}
.activity-panel.panel {
  grid-template-rows: 76px auto minmax(0, 1fr) 39px;
}
.activity-feed {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 9px 14px 17px;
  overscroll-behavior: contain;
}
.activity-item {
  position: relative;
  display: grid;
  min-width: 0;
  max-width: 100%;
  grid-template-columns: 25px minmax(0, 1fr);
  gap: 10px;
  padding: 15px 0;
}
.activity-item + .activity-item:before {
  position: absolute;
  top: -10px;
  bottom: calc(100% - 14px);
  left: 12px;
  width: 1px;
  background: #29303c;
  content: "";
}
.event-marker {
  z-index: 1;
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border: 1px solid #303744;
  border-radius: 8px;
  color: #9aa6b8;
  background: #151922;
}
.event-marker svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.event-user .event-marker {
  border-color: #3c5d55;
  color: var(--mint);
  background: #15221f;
}
.event-tool .event-marker,
.event-tool_done .event-marker,
.event-assistant .event-marker {
  color: #b5a3eb;
  background: #1d1928;
  border-color: #413652;
}
.event-tool_done .event-marker {
  color: #81c8b2;
  background: #15221f;
  border-color: #31584e;
}
.event-error .event-marker {
  color: #f09292;
  background: #29191d;
  border-color: #57353a;
}
.event-content {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.event-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.event-meta strong {
  overflow: hidden;
  color: #d9e0ea;
  font-size: 14px;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-meta time {
  flex: none;
  color: #6f7a8c;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.markdown-body {
  margin-top: 6px;
  max-width: 100%;
  color: #9aa5b5;
  font-size: 15px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.markdown-body p,
.markdown-body li,
.markdown-body code {
  overflow-wrap: anywhere;
  word-break: break-word;
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  margin: 0.5em 0 0.35em;
  color: #dce3ed;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.35;
}
.markdown-body :first-child {
  margin-top: 0;
}
.markdown-body :last-child {
  margin-bottom: 0;
}
.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body table {
  margin: 0.55em 0;
}
.markdown-body ul,
.markdown-body ol {
  padding-left: 1.5em;
}
.markdown-body blockquote {
  padding-left: 0.8em;
  border-left: 2px solid #414a59;
  color: #7f8b9e;
}
.markdown-body a {
  color: #a8c8ff;
}
.markdown-body :not(pre) > code {
  padding: 0.12em 0.35em;
  border: 1px solid #303744;
  border-radius: 4px;
  color: #dfc4ff;
  background: #171b24;
}
.markdown-body pre {
  max-width: 100%;
  margin: 0.65em 0;
  overflow: auto;
  border: 1px solid #303744;
  border-radius: 7px;
  background: #10141c;
}
.markdown-body pre code.hljs {
  padding: 10px 12px;
  background: transparent;
  font-size: 13px;
  line-height: 1.5;
}
.markdown-body table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.markdown-body th,
.markdown-body td {
  padding: 4px 7px;
  border: 1px solid #303744;
}
.markdown-body th {
  color: #d4dce8;
}
.feed-empty,
.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 25px;
  text-align: center;
}
.empty-glyph {
  display: grid;
  width: 45px;
  height: 45px;
  margin-bottom: 5px;
  place-items: center;
  border: 1px solid #2a3440;
  border-radius: 14px;
  color: #9aabbb;
  background: #151b24;
}
.empty-glyph svg {
  width: 21px;
  height: 21px;
}
.feed-empty strong,
.canvas-empty strong {
  color: #d5dde8;
  font-size: 14px;
  font-weight: 600;
}
.feed-empty > span:last-child,
.canvas-empty p {
  max-width: 245px;
  margin: 0;
  color: #778294;
  font-size: 13px;
  line-height: 1.55;
}
.feed-footer,
.canvas-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 17px;
  border-top: 1px solid var(--line);
  color: #788497;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.1em;
}
.feed-footer {
  justify-content: flex-start;
  gap: 8px;
}
.detail-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 51px;
  z-index: 6;
  display: grid;
  width: min(400px, 44%);
  min-width: 0;
  max-width: calc(100% - 24px);
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #10131bf2;
  box-shadow: 0 16px 40px #0008;
  backdrop-filter: blur(10px);
}
.detail-panel .activity-feed {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}
.detail-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
}
.detail-head .graph-icon,
.detail-head .graph-state,
.detail-head .detail-close {
  flex: none;
}
.detail-head .graph-state {
  max-width: 7.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-copy {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
}
.detail-copy strong,
.detail-copy small {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.detail-copy strong {
  font-size: 14px;
  line-height: 1.35;
}
.detail-copy small {
  margin-top: 2px;
  color: #8f9caf;
  font-size: 12px;
  -webkit-line-clamp: 1;
  text-transform: capitalize;
}
.detail-close {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 1px solid #2a3140;
  border-radius: 8px;
  color: #9aa5b7;
  background: transparent;
  cursor: pointer;
}
.detail-empty {
  color: var(--muted);
  font-size: 14px;
}
.latest-button {
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid #35463f;
  border-radius: 5px;
  color: var(--mint);
  background: #17211e;
  font: inherit;
  letter-spacing: normal;
  cursor: pointer;
}
.feed-footer .pulse,
.graph-signal i {
  width: 5px;
  height: 5px;
}
.canvas-heading {
  gap: 10px;
}
.canvas-legend {
  display: flex;
  gap: 13px;
}
.canvas-legend span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #929caf;
  font-size: 12px;
}
.canvas-legend i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.legend-active {
  background: var(--amber);
  box-shadow: 0 0 8px #edbd7366;
}
.legend-done {
  background: var(--mint);
}
.canvas {
  position: relative;
  min-height: 300px;
  overflow: hidden;
  background-color: #10131b;
}
.canvas-empty {
  z-index: 1;
}
.orbit-preview {
  position: relative;
  display: grid;
  width: 94px;
  height: 94px;
  margin-bottom: 4px;
  place-items: center;
  border: 1px solid #29313d;
  border-radius: 50%;
  animation: orbit-breathe 4s ease-in-out infinite;
}
.orbit-preview:before,
.orbit-preview:after {
  position: absolute;
  inset: 11px;
  border: 1px dashed #303b47;
  border-radius: 50%;
  content: "";
}
.orbit-preview:after {
  inset: 23px;
  border-style: solid;
  border-color: #34423f;
}
.orbit-preview > span {
  z-index: 1;
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid #385950;
  border-radius: 12px;
  color: var(--mint);
  background: #15231f;
  box-shadow: 0 0 27px #63dfc11a;
}
.orbit-preview > i {
  position: absolute;
  top: 8px;
  left: 21px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--mint);
  box-shadow: 0 0 8px #63dfc1;
}
.orbit-preview > i:nth-child(2) {
  top: auto;
  right: 11px;
  bottom: 23px;
  left: auto;
  background: #ad99eb;
}
.orbit-preview > i:nth-child(3) {
  top: 25px;
  right: 12px;
  left: auto;
  width: 4px;
  height: 4px;
  background: #e9bb73;
}
.agent-flow {
  width: 100%;
  height: 100%;
  min-height: 340px;
  background: transparent;
  --vf-node-bg: transparent;
  --vf-node-color: var(--text);
  --vf-handle: transparent;
  --vf-box-shadow: none;
}
.vue-flow__background {
  opacity: 0.55;
}
.vue-flow__edge-path {
  stroke-linecap: round;
}
.vue-flow__edge.animated path {
  stroke-dasharray: 6 5;
  animation: flow-dash 1.2s linear infinite;
}
.vue-flow__node {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
}
.vue-flow__handle {
  width: 7px;
  height: 7px;
  border: 2px solid #8f9aa8;
  border-radius: 50%;
  background: #12151c;
}
.agent-node {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 7px 7px;
  border: 1px solid #2c3340;
  border-radius: 10px;
  background: #141821;
  color: var(--text);
  cursor: pointer;
  transition-property: border-color, background-color, transform;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}
.agent-node:hover {
  border-color: #3d4656;
  background: #181d27;
}
.agent-node:focus-visible {
  outline: 2px solid #d7dee8;
  outline-offset: 2px;
}
.agent-node.selected {
  border-color: #5d8f7e;
  background: #161d1c;
}
.agent-node.running {
  cursor: grab;
  border-color: #8a7348;
}
.agent-node.running:active {
  cursor: grabbing;
}
.agent-node.completed {
  opacity: 0.72;
}
.agent-node.failed {
  border-color: #8a4e54;
  background: #1b1518;
}
.agent-node.supervisor {
  cursor: grab;
  border-color: #3a534c;
  background: #131c1a;
}
.agent-node.supervisor:active {
  cursor: grabbing;
}
.agent-node-mark {
  display: grid;
  position: relative;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: #222833;
  color: #c5ceda;
}
.agent-node-mark .status-pip {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  border: 2px solid #141821;
  border-radius: 50%;
  background: #6b7380;
}
.agent-node.running .status-pip {
  background: #edbd73;
  animation: dot-pulse 1.3s infinite;
}
.agent-node.completed .status-pip,
.agent-node.supervisor:not(.running) .status-pip {
  background: #81c8b2;
}
.agent-node.failed .status-pip {
  background: #ee9292;
}
.agent-node-title {
  overflow: hidden;
  min-width: 0;
  color: #e8edf4;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-node.supervisor .agent-node-mark {
  background: #1a2c27;
  color: #7dcfb6;
}
.agent-node.role-researcher .agent-node-mark {
  background: #1b2740;
  color: #8fb4e8;
}
.agent-node.role-coder .agent-node-mark {
  background: #2a2318;
  color: #e0b56a;
}
.agent-node.role-tester .agent-node-mark {
  background: #1a2a22;
  color: #7dba96;
}
.agent-node.role-reviewer .agent-node-mark {
  background: #261d33;
  color: #c4a6e0;
}
.agent-node.role-debugger .agent-node-mark {
  background: #2b1c1c;
  color: #e08a8a;
}

.graph-icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  background: #1a2c27;
  color: #7dcfb6;
}
.graph-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  overflow: hidden;
  padding: 3px 7px;
  border-radius: 999px;
  color: #9ca7b8;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: #1c222c;
}
.graph-state.running {
  background: #2b251b;
  color: #edbd73;
}
.graph-state.completed,
.graph-state.idle {
  background: #17241f;
  color: #81c8b2;
}
.graph-state.failed {
  background: #2a1c1e;
  color: #ee9292;
}
.graph-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.graph-agent-name {
  overflow: hidden;
  margin-top: 12px;
  color: #edf1f7;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.graph-agent-role {
  overflow: hidden;
  margin-top: 3px;
  color: #8f9caf;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.graph-agent-activity {
  display: -webkit-box;
  overflow: hidden;
  min-height: 36px;
  margin-top: 10px;
  color: #b1bac8;
  font-size: 14px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.graph-agent-activity :first-child {
  margin-top: 0;
}
.graph-agent-activity :last-child {
  margin-bottom: 0;
}
.graph-progress {
  height: 2px;
  margin-top: auto;
  overflow: hidden;
  border-radius: 2px;
  background: #2b323d;
}
.graph-progress i {
  display: block;
  width: 42%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #c99750, #f0ca7d);
  animation: progress-scan 1.8s ease-in-out infinite;
}
@keyframes flow-dash {
  to {
    stroke-dashoffset: -22;
  }
}
.canvas-footer .footer-key {
  color: #c4cedc;
  font-variant-numeric: tabular-nums;
}
.graph-signal {
  display: flex;
  align-items: center;
  gap: 7px;
}
.graph-signal i {
  background: #a58be4;
  box-shadow: 0 0 8px #a58be477;
}
.connection-indicator.live i,
.graph-signal i {
  animation: signal-glow 2s ease-in-out infinite;
}
@keyframes dot-pulse {
  50% {
    opacity: 0.55;
    box-shadow: none;
  }
}
@keyframes progress-scan {
  0% {
    transform: translateX(-110%);
  }
  50% {
    transform: translateX(65%);
  }
  100% {
    transform: translateX(240%);
  }
}
@keyframes orbit-breathe {
  50% {
    transform: scale(1.04);
    opacity: 0.8;
  }
}
@keyframes complete-glow {
  0% {
    box-shadow:
      0 0 0 0 #63dfc133,
      0 10px 26px #0005;
  }
  100% {
    box-shadow:
      0 0 0 0 transparent,
      0 10px 26px #0005;
  }
}
@keyframes signal-glow {
  50% {
    opacity: 0.55;
  }
}
@media (max-width: 1050px) {
  .app-shell {
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .app-shell.sidebar-collapsed {
    grid-template-columns: 52px minmax(0, 1fr);
  }
  .detail-panel {
    width: min(340px, 48%);
  }
  .workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 13px;
  }
  .panel-heading {
    padding-inline: 14px;
  }
  .canvas-legend {
    gap: 8px;
  }
}
@media (max-width: 900px) {
  .workspace {
    grid-template-columns: 1fr;
    overflow: auto;
    padding: 12px;
  }
  .detail-panel {
    width: calc(100% - 24px);
    min-width: 0;
  }
}
@media (max-width: 760px) {
  .app-shell,
  .app-shell.sidebar-collapsed {
    grid-template-columns: 52px minmax(0, 1fr);
  }
  .sidebar {
    align-items: center;
    padding: 17px 7px 13px;
  }
  .brand {
    padding: 0 0 28px;
  }
  .brand > span:last-child,
  .sidebar-heading,
  .session-copy,
  .status-dot,
  .sidebar-bottom > small,
  .connection-indicator:not(i) {
    display: none;
  }
  .session-list {
    width: 100%;
  }
  .session-button {
    justify-content: center;
    padding: 8px 4px;
  }
  .session-button .session-icon {
    width: 37px;
    height: 37px;
  }
  .sidebar-bottom {
    width: 100%;
    justify-items: center;
    padding-inline: 0;
  }
  .connection-indicator {
    font-size: 0;
  }
  .connection-indicator i {
    width: 8px;
    height: 8px;
  }
  .main-area {
    grid-template-rows: 55px minmax(0, 1fr);
  }
  .topbar {
    padding-inline: 14px;
  }
  .workspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr);
    overflow: auto;
    padding: 10px;
  }
  .panel {
    min-height: 230px;
  }
  .canvas-panel {
    min-height: 340px;
  }
  .topbar-right {
    gap: 8px;
  }
  .local-label {
    font-size: 0;
  }
  .local-label svg {
    width: 16px;
    height: 16px;
  }
}
@media (max-width: 480px) {
  .workspace {
    grid-template-rows: minmax(0, 1fr);
    padding: 8px;
    gap: 9px;
  }
  .panel-heading {
    height: 66px;
  }
  .panel {
    grid-template-rows: minmax(0, 1fr) 35px;
  }
  .canvas-legend span {
    font-size: 12px;
  }
  .eyebrow {
    font-size: 12px;
  }
  .breadcrumb {
    gap: 7px;
    font-size: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
