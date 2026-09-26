/**
 * Ember Chrome: Ember Copper model rail above the editor, breathing spinner, and window title.
 * Follows the DESIGN.md Ember Copper Terminal specifications.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COPPER = "\x1b[38;2;245;169;127m";
const BOLD_COPPER = "\x1b[1;38;2;245;169;127m";
const MAUVE = "\x1b[38;2;198;160;246m";
const EMERALD = "\x1b[38;2;166;218;149m";
const AMBER = "\x1b[38;2;238;212;159m";
const TEXT = "\x1b[38;2;202;211;245m";
const BOLD_TEXT = "\x1b[1;38;2;202;211;245m";
const RESET = "\x1b[0m";
const MUTE = "\x1b[38;2;110;115;141m";
const SEP = ` ${MUTE}│${RESET} `;

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

const BG_RECESSED = "\x1b[48;2;30;32;48m";
const BG_ROUTER = "\x1b[48;2;36;39;58m";

let currentActiveRole: string | undefined;

function getSubscriptionChip(): string {
	try {
		const statusFile = join(homedir(), ".pi", "agent", "subscription-providers-status.json");
		if (existsSync(statusFile)) {
			const snap = JSON.parse(readFileSync(statusFile, "utf8"));
			const chips: string[] = [];
			if (snap.cursor?.ready) chips.push(`${MUTE}cur:${RESET}${EMERALD}ok${RESET}`);
			if (snap.antigravity?.ready) chips.push(`${MUTE}agy:${RESET}${EMERALD}ok${RESET}`);
			if (snap["claude-code"]?.ready) chips.push(`${MUTE}cld:${RESET}${EMERALD}ok${RESET}`);
			if (chips.length > 0) return chips.join(" ");
		}
	} catch {
		// Ignore
	}
	return `${MUTE}routes:ready${RESET}`;
}

function getOrchestratorChip(): string {
	try {
		const bridge = (globalThis as any).piAgentStackOrchestrator;
		if (bridge) {
			const subagents = bridge.listSubagents ? bridge.listSubagents() : [];
			const running = subagents.filter((s: any) => s.status === 'running');
			if (running.length > 0) {
				return `${MAUVE}🤖 orc:${running.length} act${RESET}`;
			}
			const ready = bridge.isReady ? bridge.isReady() : false;
			const providers = bridge.getProviders ? bridge.getProviders() : [];
			if (ready && providers.length >= 2) {
				return `${EMERALD}🤖 orc:${providers.length}p${RESET}`;
			}
		}
	} catch {
		// Ignore
	}
	return `${MUTE}🤖 orc:1p${RESET}`;
}

function getRoleBadge(): string {
	if (!currentActiveRole) {
		return `${MUTE}[${RESET}${MAUVE}🏛 Supervisor${RESET}${MUTE}]${RESET}`;
	}
	switch (currentActiveRole.toLowerCase()) {
		case 'coder':
		case 'edit':
		case 'write':
			return `${MUTE}[${RESET}${BOLD_COPPER}🧑‍💻 Coder${RESET}${MUTE}]${RESET}`;
		case 'tester':
		case 'test':
			return `${MUTE}[${RESET}${EMERALD}🧪 Tester${RESET}${MUTE}]${RESET}`;
		case 'reviewer':
		case 'audit':
			return `${MUTE}[${RESET}${AMBER}🔍 Reviewer${RESET}${MUTE}]${RESET}`;
		case 'researcher':
		case 'read':
		case 'search':
			return `${MUTE}[${RESET}${MAUVE}📚 Researcher${RESET}${MUTE}]${RESET}`;
		case 'plan':
		case 'advisor':
		case 'goal':
			return `${MUTE}[${RESET}${AMBER}📋 Planner${RESET}${MUTE}]${RESET}`;
		case 'consensus':
			return `${MUTE}[${RESET}${BOLD_COPPER}🏛 Consensus${RESET}${MUTE}]${RESET}`;
		default:
			return `${MUTE}[${RESET}${BOLD_TEXT}${currentActiveRole}${RESET}${MUTE}]${RESET}`;
	}
}

function rail(ctx: {
	model?: { id?: string; provider?: string };
	sessionManager?: { getModel?: () => { id?: string } };
	thinkingLevel?: string;
	getThinkingLevel?: () => string;
}): string[] {
	const model =
		ctx.model?.id ||
		ctx.sessionManager?.getModel?.()?.id ||
		"default";
	const provider = ctx.model?.provider || "custom";
	const providerBadge = `${MUTE}[${RESET}${BOLD_COPPER}${provider}${RESET}${MUTE}]${RESET}`;
	const modelLabel = `${BOLD_TEXT}${model}${RESET}`;

	const thinking =
		ctx.thinkingLevel ||
		ctx.getThinkingLevel?.() ||
		"high";
	const thinkBadge = `${MAUVE}⚡ ${thinking}${RESET}`;

	const jevActive = hasJevKey();
	const jevBadge = jevActive
		? `${EMERALD}🛡️ jev${RESET}`
		: `${AMBER}🛡️ off${RESET}`;

	const subChip = getSubscriptionChip();
	const orcChip = getOrchestratorChip();
	const roleBadge = getRoleBadge();
	const brand = `${BOLD_COPPER}● EMBER${RESET}`;

	const line1 = ` ┌─[ ${brand} ]──[ ${providerBadge} ${modelLabel} ]──[ ${roleBadge} ]──[ ${thinkBadge} ]──[ ${jevBadge} ]──[ ${orcChip} ]──[ ${subChip} ]`;
	return [line1];
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
				setWidget?: (key: string, content: string[] | undefined, opts?: { placement?: string }) => void;
				setWorkingIndicator?: (opts?: { frames?: string[]; intervalMs?: number }) => void;
				setHiddenThinkingLabel?: (label?: string) => void;
				setTitle?: (title: string) => void;
			};
		};
		if (!ui.hasUI || ui.mode === "json" || ui.mode === "print") return;
		lastCtx = ui;

		const thinkingLevel = ui.thinkingLevel || pi.getThinkingLevel?.();
		ui.ui?.setWidget?.("ember-rail", rail({ ...ui, thinkingLevel, getThinkingLevel: pi.getThinkingLevel }), {
			placement: "aboveEditor",
		});

		ui.ui?.setWorkingIndicator?.({
			frames: [
				`${COPPER}·${RESET}`,
				`${COPPER}:${RESET}`,
				`${COPPER}•${RESET}`,
				`${COPPER}●${RESET}`,
				`${COPPER}•${RESET}`,
				`${COPPER}:${RESET}`,
			],
			intervalMs: 85,
		});

		ui.ui?.setHiddenThinkingLabel?.(`${MAUVE}thinking${RESET}`);

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
