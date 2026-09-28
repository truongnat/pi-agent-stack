/**
 * Ember Chrome: Ember Copper model rail above the editor, breathing spinner, and window title.
 * Follows the DESIGN.md Ember Copper Terminal specifications.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Text } from "@earendil-works/pi-tui";

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	getThinkingBorderColor?(level: string): (text: string) => string;
};

// Semantic roles only: the active theme (ember / ember-light, or any user theme) decides the actual colors.
const paletteFor = (t: ThemeLike) => ({
	copper: (s: string) => t.fg("accent", s),
	boldCopper: (s: string) => t.bold(t.fg("accent", s)),
	mauve: (s: string) => t.fg("mdLink", s),
	emerald: (s: string) => t.fg("success", s),
	amber: (s: string) => t.fg("warning", s),
	boldText: (s: string) => t.bold(t.fg("text", s)),
	mute: (s: string) => t.fg("dim", s),
	thinking: (level: string, s: string) => (t.getThinkingBorderColor ? t.getThinkingBorderColor(level)(s) : t.fg("accent", s)),
});
type Palette = ReturnType<typeof paletteFor>;

function hasJevKey(): boolean {
	if (process.env.JEV_API_KEY && process.env.JEV_API_KEY !== "replace-me") return true;
	try {
		const keyPath = join(homedir(), ".keys", "jev.env");
		if (existsSync(keyPath)) {
			const content = readFileSync(keyPath, "utf8");
			return content.includes("JEV_API_KEY") && !content.includes("replace-me");
		}
	} catch {
		// Ignore filesystem errors
	}
	return false;
}

let currentActiveRole: string | undefined;

function getSubscriptionChip(c: Palette): string {
	try {
		const statusFile = join(homedir(), ".pi", "agent", "subscription-providers-status.json");
		if (existsSync(statusFile)) {
			const snap = JSON.parse(readFileSync(statusFile, "utf8"));
			const chips: string[] = [];
			if (snap.cursor?.ready) chips.push(`${c.mute("cur:")}${c.emerald("ok")}`);
			if (snap.antigravity?.ready) chips.push(`${c.mute("agy:")}${c.emerald("ok")}`);
			if (snap["claude-code"]?.ready) chips.push(`${c.mute("cld:")}${c.emerald("ok")}`);
			if (chips.length > 0) return chips.join(" ");
		}
	} catch {
		// Ignore
	}
	return c.mute("routes:ready");
}

function getOrchestratorChip(c: Palette): string {
	try {
		const bridge = (globalThis as any).piAgentStackOrchestrator;
		if (bridge) {
			const subagents = bridge.listSubagents ? bridge.listSubagents() : [];
			const running = subagents.filter((s: any) => s.status === 'running');
			if (running.length > 0) {
				return c.mauve(`🤖 orc:${running.length} act`);
			}
			const ready = bridge.isReady ? bridge.isReady() : false;
			const providers = bridge.getProviders ? bridge.getProviders() : [];
			if (ready && providers.length >= 2) {
				return c.emerald(`🤖 orc:${providers.length}p`);
			}
		}
	} catch {
		// Ignore
	}
	return c.mute("🤖 orc:1p");
}

function getRoleBadge(c: Palette): string {
	const wrap = (label: string) => `${c.mute("[")}${label}${c.mute("]")}`;
	if (!currentActiveRole) return wrap(c.mauve("🏛 Supervisor"));
	switch (currentActiveRole.toLowerCase()) {
		case 'coder':
		case 'edit':
		case 'write':
			return wrap(c.boldCopper("🧑‍💻 Coder"));
		case 'tester':
		case 'test':
			return wrap(c.emerald("🧪 Tester"));
		case 'reviewer':
		case 'audit':
			return wrap(c.amber("🔍 Reviewer"));
		case 'researcher':
		case 'read':
		case 'search':
			return wrap(c.mauve("📚 Researcher"));
		case 'plan':
		case 'planner':
		case 'advisor':
		case 'goal':
			return wrap(c.amber("📋 Planner"));
		case 'consensus':
			return wrap(c.boldCopper("🏛 Consensus"));
		default:
			return wrap(c.boldText(currentActiveRole));
	}
}

type RailState = { model: string; provider: string; thinking: string };

function rail(t: ThemeLike, state: RailState): string {
	const c = paletteFor(t);
	const providerBadge = `${c.mute("[")}${c.boldCopper(state.provider)}${c.mute("]")}`;
	const modelLabel = c.boldText(state.model);
	const thinkBadge = c.thinking(state.thinking, `⚡ ${state.thinking}`);
	const jevBadge = hasJevKey() ? c.emerald("🛡️ jev") : c.amber("🛡️ off");
	const brand = c.boldCopper("● EMBER");
	return ` ┌─[ ${brand} ]──[ ${providerBadge} ${modelLabel} ]──[ ${getRoleBadge(c)} ]──[ ${thinkBadge} ]──[ ${jevBadge} ]──[ ${getOrchestratorChip(c)} ]──[ ${getSubscriptionChip(c)} ]`;
}

// Rebuilds the line from the live theme on every render, so a light/dark switch recolors it without a new event.
function railWidget(state: RailState) {
	return (_tui: unknown, theme: ThemeLike) => {
		const text = new Text("", 1, 0);
		return {
			render(width: number) {
				text.setText(rail(theme, state));
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	};
}

export default function emberUi(pi: {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	getThinkingLevel?: () => string;
}) {
	let lastCtx: any = null;

	const paint = (_event: unknown, ctx: unknown) => {
		const ui = ctx as {
			hasUI?: boolean;
			mode?: string;
			model?: { id?: string; provider?: string };
			sessionManager?: { getModel?: () => { id?: string } };
			thinkingLevel?: string;
			ui?: {
				theme?: ThemeLike;
				setWidget?: (key: string, content: ReturnType<typeof railWidget> | undefined, opts?: { placement?: string }) => void;
				setWorkingIndicator?: (opts?: { frames?: string[]; intervalMs?: number }) => void;
				setHiddenThinkingLabel?: (label?: string) => void;
				setTitle?: (title: string) => void;
			};
		};
		if (!ui.hasUI || ui.mode === "json" || ui.mode === "print") return;
		lastCtx = ui;

		ui.ui?.setWidget?.(
			"ember-rail",
			railWidget({
				model: ui.model?.id || ui.sessionManager?.getModel?.()?.id || "default",
				provider: ui.model?.provider || "custom",
				thinking: ui.thinkingLevel || pi.getThinkingLevel?.() || "high",
			}),
			{ placement: "aboveEditor" },
		);

		// ponytail: indicator/label take pre-colored strings, so a theme switch recolors them on the next paint (next turn or tool call), not instantly.
		const theme = ui.ui?.theme;
		if (theme) {
			const c = paletteFor(theme);
			ui.ui?.setWorkingIndicator?.({
				frames: ["·", ":", "•", "●", "•", ":"].map(c.copper),
				intervalMs: 85,
			});
			ui.ui?.setHiddenThinkingLabel?.(c.mauve("thinking"));
		}

		const modelId = ui.model?.id || ui.sessionManager?.getModel?.()?.id || "ember";
		ui.ui?.setTitle?.(`pi ember | ${modelId} | ${currentActiveRole || 'supervisor'}`);
	};

	pi.on("session_start", paint);
	pi.on("session_before_tree", paint);
	pi.on("model_select", (event: unknown, ctx: unknown) =>
		paint(event, {
			...(ctx as object),
			model: (event as { model?: { id?: string; provider?: string } }).model,
		}),
	);
	pi.on("thinking_level_select", (event: unknown, ctx: unknown) =>
		paint(event, {
			...(ctx as object),
			thinkingLevel: (event as { level?: string }).level,
		}),
	);

	// Track active role based on tool invocations and lifecycle
	pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
		currentActiveRole = "Plan";
		paint(event, ctx);
	});

	pi.on("tool_call", (event: unknown, ctx: unknown) => {
		const ev = event as { toolName?: string; input?: any };
		const tool = ev.toolName || "";
		if (tool === "invoke_subagent") {
			const sub = ev.input?.subagents?.[0]?.role;
			currentActiveRole = ev.input?.require_consensus ? "Consensus" : (sub ? `Subagent: ${sub}` : "Orchestrator");
		} else if (tool === "edit" || tool === "write" || tool === "replace_file_content") {
			currentActiveRole = "Coder";
		} else if (tool === "read" || tool === "view_file" || tool === "grep" || tool === "find") {
			currentActiveRole = "Researcher";
		} else if (tool === "bash" || tool === "exec") {
			const cmd = String(ev.input?.command || "").toLowerCase();
			if (cmd.includes("test") || cmd.includes("check") || cmd.includes("lint")) {
				currentActiveRole = "Tester";
			} else {
				currentActiveRole = "Coder";
			}
		} else if (tool.includes("goal") || tool.includes("advisor") || tool.includes("plan")) {
			currentActiveRole = "Planner";
		} else {
			currentActiveRole = tool;
		}
		if (lastCtx) paint(event, lastCtx);
	});

	pi.on("tool_result", (event: unknown, ctx: unknown) => {
		// Switch back to supervisor after tool execution
		currentActiveRole = undefined;
		if (lastCtx) paint(event, lastCtx);
	});

	pi.on("agent_end", (event: unknown, ctx: unknown) => {
		currentActiveRole = undefined;
		if (lastCtx) paint(event, lastCtx);
	});
}
