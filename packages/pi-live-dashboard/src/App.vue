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
import { AnimatePresence, MotionConfig, motion } from "motion-v";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import {
  Activity,
  Bot,
  CircleCheck,
  CircleX,
  FilePenLine,
  FilePlus2,
  FileSearch,
  Folder,
  FolderSearch,
  ChevronRight,
  LaptopMinimal,
  MessageSquareText,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
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
const viewportWidth = ref(1280);
const graphColumns = computed(() =>
  viewportWidth.value <= 760 ? 1 : viewportWidth.value >= 1360 ? 3 : 2,
);
const feed = ref<HTMLElement | null>(null);
const nearBottom = ref(true);
const connection = ref<"connecting" | "live" | "offline">("connecting");
const selected = computed(() =>
  sessions.value.find(({ id }) => id === selectedId.value),
);
const graphNodes = computed(() => {
  const session = selected.value;
  if (!session) return [];
  const cardWidth = graphColumns.value === 3 ? 196 : 248;
  const gap = graphColumns.value === 3 ? 20 : 34;
  const step = cardWidth + gap;
  const columns = graphColumns.value;
  const graphWidth = columns * cardWidth + (columns - 1) * gap;
  const supervisorWidth =
    graphColumns.value === 1 ? 280 : graphColumns.value === 3 ? 300 : 348;
  return [
    {
      id: "supervisor",
      type: "supervisor",
      position: { x: (graphWidth - supervisorWidth) / 2, y: 48 },
      style: { width: `${supervisorWidth}px` },
      data: { title: session.title, status: session.status },
      sourcePosition: Position.Bottom,
      draggable: false,
      selectable: false,
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
        position: {
          x: (graphWidth - rowWidth) / 2 + column * step,
          y: 236 + row * 198,
        },
        style: { width: `${cardWidth}px` },
        data: { agent },
        targetPosition: Position.Top,
        draggable: false,
        selectable: false,
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
const events = computed(() => {
  const items = [...(selected.value?.events ?? [])];
  if (selected.value?.preview)
    items.push({
      type: "assistant",
      text: selected.value.preview,
      at: Date.now(),
    });
  return items;
});
const latestActivity = computed(() => {
  const session = selected.value;
  const last = session?.events.at(-1);
  return [session?.id, last?.at, last?.text, last?.value, session?.preview];
});
let source: EventSource | undefined;
function updateViewportWidth() {
  viewportWidth.value = window.innerWidth;
}

function renderMarkdown(value: string) {
  return DOMPurify.sanitize(marked.parse(value, { async: false }), {
    USE_PROFILES: { html: true },
  });
}

function highlightCode() {
  feed.value
    ?.querySelectorAll("pre code:not([data-highlighted])")
    .forEach((block) => hljs.highlightElement(block as HTMLElement));
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

watch(
  [selectedId, latestActivity],
  async ([id], [previousId]) => {
    const follow = id !== previousId || nearBottom.value;
    await nextTick();
    if (follow) scrollToLatest();
    highlightCode();
  },
  { flush: "post", immediate: true },
);

function receive(event: MessageEvent<string>) {
  const snapshot = JSON.parse(event.data) as { sessions: Session[] };
  sessions.value = snapshot.sessions;
  if (!sessions.value.some(({ id }) => id === selectedId.value))
    selectedId.value = sessions.value[0]?.id ?? "";
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
  return agent.name || agent.role || "Agent";
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

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function activityIcon(event: Activity) {
  if (event.type === "user") return MessageSquareText;
  if (event.type === "assistant") return Sparkles;
  if (event.type === "tool_done") return CircleCheck;
  if (event.type === "error") return CircleX;
  if (event.type === "tool") return toolIcons[event.name ?? ""] ?? Wrench;
  return Activity;
}

function agentIcon(agent: Agent) {
  const action = agentActivity(agent).match(
    /^(Read|Write|Edit|Run|Search|Find|List)\b/,
  )?.[1];
  const tool = {
    Read: "read",
    Write: "write",
    Edit: "edit",
    Run: "bash",
    Search: "grep",
    Find: "find",
    List: "ls",
  }[action ?? ""];
  return (tool && toolIcons[tool]) || Bot;
}

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
    <div class="app-shell">
      <aside class="sidebar" aria-label="Pi sessions">
        <a
          class="brand"
          href="#"
          aria-label="Pi Live Sessions home"
          @click.prevent="selectedId = sessions[0]?.id ?? ''"
        >
          <span class="brand-mark" aria-hidden="true"
            ><svg viewBox="0 0 24 24">
              <path d="M5 18V6h7a5 5 0 0 1 0 10H9" />
              <path d="M17 6v12" /></svg
          ></span>
          <span
            ><strong>Pi<span class="brand-accent">.</span></strong
            ><small>LIVE SESSIONS</small></span
          >
        </a>

        <div class="sidebar-heading">
          <span>WORKSPACES</span
          ><span class="count">{{ sessions.length }}</span>
        </div>
        <nav class="session-list" aria-label="Active workspaces">
          <button
            v-for="session in sessions"
            :key="session.id"
            class="session-button"
            :class="{ selected: session.id === selectedId }"
            :aria-pressed="session.id === selectedId"
            :title="session.cwd"
            @click="selectedId = session.id"
          >
            <span class="session-icon" aria-hidden="true"
              ><Folder :size="18" :stroke-width="2"
            /></span>
            <span class="session-copy"
              ><strong>{{ session.title }}</strong
              ><small>{{ shortPath(session.cwd) }}</small></span
            >
            <span
              class="status-dot"
              :class="session.status === 'working' ? 'busy' : 'ready'"
              :aria-label="session.status"
            />
          </button>
          <div v-if="!sessions.length" class="sidebar-empty">
            No Pi sessions connected
          </div>
        </nav>

        <div class="sidebar-bottom">
          <span class="connection-indicator" :class="connection"
            ><i />{{
              connection === "live"
                ? "LIVE CONNECTION"
                : connection === "offline"
                  ? "RECONNECTING"
                  : "CONNECTING"
            }}</span
          >
          <small>Local agent activity</small>
        </div>
      </aside>

      <main class="main-area">
        <header class="topbar">
          <div class="breadcrumb">
            <span>Sessions</span><ChevronRight :size="14" aria-hidden="true" />
            <strong>{{ selected?.title ?? "Waiting for Pi" }}</strong>
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
            class="activity-panel panel"
            aria-labelledby="activity-heading"
          >
            <div class="panel-heading">
              <div>
                <span class="eyebrow">SESSION STREAM</span>
                <h1 id="activity-heading">Activity</h1>
              </div>
              <span class="event-count">{{ events.length }} EVENTS</span>
            </div>
            <div
              class="activity-feed"
              ref="feed"
              @scroll="onFeedScroll"
              aria-live="polite"
              aria-relevant="additions text"
            >
              <article
                v-for="(event, index) in events"
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
                            ? "Pi assistant"
                            : event.type.replace("_", " "))
                    }}</strong
                    ><time>{{ formatTime(event.at) }}</time>
                  </div>
                  <div
                    class="markdown-body"
                    v-html="
                      renderMarkdown(
                        event.text || event.value || event.name || event.type,
                      )
                    "
                  />
                </div>
              </article>
              <div v-if="!events.length" class="feed-empty">
                <span class="empty-glyph"
                  ><MessageSquareText :size="21" :stroke-width="1.8" /></span
                ><strong>No conversation yet</strong
                ><span>New prompts and tool activity will appear here.</span>
              </div>
            </div>
            <div class="feed-footer">
              <span class="pulse" />Following session activity
              <button
                v-if="!nearBottom"
                class="latest-button"
                type="button"
                @click="scrollToLatest"
              >
                ↓ Latest
              </button>
            </div>
          </section>

          <section class="canvas-panel panel" aria-labelledby="canvas-heading">
            <div class="panel-heading canvas-heading">
              <div>
                <span class="eyebrow">AGENT TOPOLOGY</span>
                <h2 id="canvas-heading">Live canvas</h2>
              </div>
              <div class="canvas-legend">
                <span><i class="legend-active" />Running</span
                ><span><i class="legend-done" />Completed</span>
              </div>
            </div>
            <div
              class="canvas"
              :class="{ 'has-agents': selected?.agents.length }"
              role="application"
              :aria-label="`Agent tree for ${selected?.title ?? 'no selected session'}`"
            >
              <template v-if="selected">
                <VueFlow
                  :key="
                    selected.id +
                    ':' +
                    selected.agents.length +
                    ':' +
                    graphColumns
                  "
                  :nodes="graphNodes"
                  :edges="graphEdges"
                  :fit-view-on-init="true"
                  :fit-view-options="{ padding: 0.2, maxZoom: 1 }"
                  :min-zoom="0.35"
                  :max-zoom="1.15"
                  :nodes-draggable="false"
                  :nodes-connectable="false"
                  :elements-selectable="false"
                  :zoom-on-double-click="false"
                  class="agent-flow"
                >
                  <Background pattern-color="#30394a" :gap="24" :size="1" />
                  <template #node-supervisor="{ data }">
                    <div class="graph-card graph-supervisor">
                      <Handle
                        type="source"
                        :position="Position.Bottom"
                        :connectable="false"
                      />
                      <span class="graph-icon"
                        ><Workflow :size="20" :stroke-width="1.8"
                      /></span>
                      <span class="graph-copy"
                        ><small>PI SUPERVISOR</small
                        ><strong>{{ data.title }}</strong></span
                      >
                      <span
                        class="graph-state"
                        :class="{ busy: data.status === 'working' }"
                        >{{ data.status }}</span
                      >
                    </div>
                  </template>
                  <template #node-agent="{ data }">
                    <div
                      class="graph-card graph-agent"
                      :class="agentStateClass(data.agent)"
                    >
                      <Handle
                        type="target"
                        :position="Position.Top"
                        :connectable="false"
                      />
                      <div class="graph-agent-head">
                        <span class="graph-icon"
                          ><component
                            :is="agentIcon(data.agent)"
                            :size="18"
                            :stroke-width="1.8"
                        /></span>
                        <span class="graph-state"
                          ><i />{{ data.agent.status }}</span
                        >
                      </div>
                      <strong class="graph-agent-name">{{
                        agentLabel(data.agent)
                      }}</strong>
                      <span class="graph-agent-role"
                        >{{ data.agent.role || "Subagent"
                        }}<template v-if="data.agent.model">
                          · {{ data.agent.model }}</template
                        ></span
                      >
                      <div
                        class="graph-agent-activity"
                        v-html="renderMarkdown(agentActivity(data.agent))"
                      />
                      <div
                        v-if="agentIsActive(data.agent)"
                        class="graph-progress"
                      >
                        <i />
                      </div>
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
                AGENTS</span
              ><span class="graph-signal"><i /> GRAPH SYNCED</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  </MotionConfig>
</template>

<style>
:root {
  font-family:
    Lato,
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
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
body {
  min-width: 360px;
  min-height: 100vh;
  margin: 0;
}
button,
a {
  font: inherit;
}
.app-shell {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
}
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 25px 15px 18px;
  background: #0e1118;
  border-right: 1px solid var(--line);
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
  font-size: 17px;
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
  grid-template-columns: minmax(280px, 0.82fr) minmax(410px, 1.18fr);
  gap: 16px;
  padding: 20px;
}
.panel {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 76px minmax(0, 1fr) 39px;
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
  margin: 5px 0 0;
  color: #e8edf4;
  font-size: 18px;
  font-weight: 620;
  letter-spacing: -0.025em;
}
.event-count {
  color: #8993a4;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.1em;
}
.activity-feed {
  position: relative;
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 0;
  overflow: auto;
  padding: 9px 18px 17px;
  overscroll-behavior: contain;
}
.activity-item {
  position: relative;
  display: grid;
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
  font-size: 13px;
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
  color: #9aa5b5;
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
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
  font-size: 12px;
  line-height: 1.55;
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
.vue-flow__handle {
  width: 8px;
  height: 8px;
  border: 2px solid #9ac5b5;
  border-radius: 50%;
  background: #17241f;
}
.graph-card {
  position: relative;
  display: flex;
  width: 100%;
  flex-direction: column;
  border: 1px solid #303846;
  border-radius: 14px;
  background: linear-gradient(145deg, #1b222d, #11161e 90%);
  box-shadow: 0 12px 30px #0007;
  color: var(--text);
  font-family: inherit;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    opacity 180ms ease;
}
.graph-supervisor {
  min-height: 80px;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-color: #42675e;
  background: linear-gradient(130deg, #192720, #141922 80%);
  box-shadow:
    0 12px 32px #0007,
    0 0 34px #63dfc11a;
}
.graph-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  border: 1px solid #3b675b;
  border-radius: 11px;
  background: #152620;
  color: var(--mint);
}
.graph-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 4px;
}
.graph-copy small {
  color: #93a69e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.13em;
}
.graph-copy strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.graph-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #9ca7b8;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.graph-state.busy {
  padding: 6px 9px;
  border: 1px solid #705a36;
  border-radius: 999px;
  background: #2b251b;
  color: #edbd73;
}
.graph-agent {
  min-height: 154px;
  padding: 14px;
}
.graph-agent.running {
  border-color: #77603b;
  box-shadow:
    0 0 0 3px #edbd7312,
    0 12px 30px #0007;
}
.graph-agent.completed {
  border-color: #33443f;
  opacity: 0.78;
}
.graph-agent.failed {
  border-color: #744b50;
  box-shadow: 0 0 20px #e1767618;
}
.graph-agent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.graph-agent .graph-icon {
  width: 32px;
  height: 32px;
  border-color: #394252;
  background: #202632;
  color: #c0cad8;
}
.graph-agent.running .graph-icon {
  border-color: #635439;
  background: #282319;
  color: var(--amber);
}
.graph-agent.running .graph-state {
  color: var(--amber);
}
.graph-agent.failed .graph-icon,
.graph-agent.failed .graph-state {
  color: #ee9292;
}
.graph-agent.completed .graph-icon,
.graph-agent.completed .graph-state {
  color: #81c8b2;
}
.graph-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.graph-agent.running .graph-state i {
  animation: dot-pulse 1.3s infinite;
}
.graph-agent-name {
  overflow: hidden;
  margin-top: 12px;
  color: #edf1f7;
  font-size: 15px;
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
  font-size: 12px;
  line-height: 1.5;
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
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .workspace {
    grid-template-columns: minmax(250px, 0.75fr) minmax(360px, 1.25fr);
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
    grid-template-rows: minmax(230px, 0.8fr) minmax(340px, 1.2fr);
    overflow: auto;
    padding: 12px;
  }
}
@media (max-width: 760px) {
  .app-shell {
    grid-template-columns: 64px minmax(0, 1fr);
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
    grid-template-rows: minmax(230px, 0.8fr) minmax(340px, 1.2fr);
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
    grid-template-rows: minmax(205px, 0.75fr) minmax(320px, 1.25fr);
    padding: 8px;
    gap: 9px;
  }
  .panel-heading {
    height: 66px;
  }
  .panel {
    grid-template-rows: 66px minmax(0, 1fr) 35px;
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
