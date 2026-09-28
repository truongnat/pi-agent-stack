/**
 * Harness-layer Jev gate. Reuses ~/.agents/typesafe-harness (same as Claude/Grok/Codex).
 * Jev never appears as a model-callable tool.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HARNESS_DIR = process.env.TYPESAFE_HARNESS_DIR || join(homedir(), ".agents", "typesafe-harness");
const PRE_TOOL = join(HARNESS_DIR, "pre-tool.sh");
const PROMPT = join(HARNESS_DIR, "prompt.sh");
const TOOL_TIMEOUT_MS = 8000;
const PROMPT_TIMEOUT_MS = 12000;

type GateOut = {
	/** Set by runScript when the gate itself did not answer (timeout, spawn error, bad JSON). */
	failed?: boolean;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
		additionalContext?: string;
	};
};

function runScript(script: string, payload: unknown, timeoutMs: number): Promise<GateOut> {
	return new Promise((resolve) => {
		const child = spawn(script, [], {
			env: { ...process.env, TYPESAFE_HARNESS: "pi" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let settled = false;
		const finish = (value: GateOut) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish({ failed: true });
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish({ failed: true });
		});
		child.stdin.on("error", () => undefined);
		child.on("close", () => {
			clearTimeout(timer);
			try {
				finish(JSON.parse(out || "{}") as GateOut);
			} catch {
				finish({ failed: true });
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

function decisionOf(result: GateOut): string {
	return result.decision || result.hookSpecificOutput?.permissionDecision || "none";
}

function reasonOf(result: GateOut): string {
	return result.reason || result.hookSpecificOutput?.permissionDecisionReason || "";
}

type Ui = {
	hasUI?: boolean;
	ui?: {
		confirm?: (title: string, message: string) => Promise<boolean>;
		notify?: (m: string, k?: string) => void;
	};
};

/** Shared with pi-jev-harness so one session asks "JEV unavailable, regex only?" once. */
const shared = globalThis as { piJevRegexOnly?: boolean | undefined };

async function consentRegexOnly(ctx: Ui, why: string): Promise<boolean> {
	if (shared.piJevRegexOnly === undefined && process.env.PI_JEV_REGEX_ONLY === "1") {
		shared.piJevRegexOnly = true;
	}
	if (shared.piJevRegexOnly === undefined && ctx.hasUI && ctx.ui?.confirm) {
		shared.piJevRegexOnly = await ctx.ui.confirm(
			"typesafe gate: JEV unavailable",
			`${why}\n\nContinue with the local regex guard only?`,
		);
	}
	return shared.piJevRegexOnly === true;
}

const jevUnavailable = (result: GateOut, reason: string): boolean =>
	result.failed === true || /jev unavailable|typesafe gate failed/i.test(reason);

export default function typesafeGate(pi: {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
}) {
	pi.on("session_start", () => {
		shared.piJevRegexOnly = undefined;
	});

	pi.on("tool_call", async (event: unknown, ctx: unknown) => {
		const call = event as { toolName?: string; input?: Record<string, unknown> };
		const ui = ctx as Ui;
		const toolName = String(call.toolName || "unknown");
		const input = call.input && typeof call.input === "object" ? call.input : {};
		const result = await runScript(
			PRE_TOOL,
			{ toolName, tool_name: toolName, toolInput: input, tool_input: input },
			TOOL_TIMEOUT_MS,
		);
		const decision = decisionOf(result);
		const reason = reasonOf(result);
		if (decision === "deny") {
			ui.ui?.notify?.(`Jev deny: ${reason}`, "error");
			return { block: true, reason: reason || "jev deny", terminate: true };
		}
		const why = `Jev did not answer (${reason || "gate failed"}).`;
		if (jevUnavailable(result, reason) && !(await consentRegexOnly(ui, why))) {
			const who = ui.hasUI
				? "the user declined regex-only mode."
				: "no one is here to confirm; set JEV_API_KEY or PI_JEV_REGEX_ONLY=1.";
			return { block: true, terminate: true, reason: `typesafe gate stopped: Jev unavailable and ${who}` };
		}
		if (decision === "ask") {
			const ok =
				ui.hasUI && ui.ui?.confirm
					? await ui.ui.confirm(`typesafe gate: ${toolName}`, `${reason}\n\nRun it?`)
					: false;
			if (!ok) {
				const who = ui.hasUI ? "The user declined." : "No one is here to confirm.";
				return { block: true, reason: `typesafe gate: ${reason || "needs confirmation"}. ${who}` };
			}
		}
		return undefined;
	});

	pi.on("user_bash", async (event: unknown, ctx: unknown) => {
		const bash = event as { command?: string };
		const ui = ctx as {
			hasUI?: boolean;
			ui?: { confirm?: (q: string) => Promise<boolean>; notify?: (m: string, k?: string) => void };
		};
		const command = String(bash.command || "");
		const result = await runScript(
			PRE_TOOL,
			{ toolName: "bash", toolInput: { command } },
			TOOL_TIMEOUT_MS,
		);
		const decision = decisionOf(result);
		const reason = reasonOf(result);
		if (decision === "deny") {
			ui.ui?.notify?.(`Jev deny: ${reason}`, "error");
			return {
				result: { output: reason || "jev deny", exitCode: 1, cancelled: false, truncated: false },
			};
		}
		return undefined;
	});

	pi.on("before_agent_start", async (event: unknown) => {
		const evt = event as { prompt?: string; systemPrompt?: string };
		const text = String(evt.prompt || "");
		if (!text.trim()) return undefined;
		const result = await runScript(PROMPT, { prompt: text, invocationNum: 1 }, PROMPT_TIMEOUT_MS);
		const hint = result.hookSpecificOutput?.additionalContext;
		if (!hint) return undefined;
		const basePrompt = evt.systemPrompt || "";
		return { systemPrompt: basePrompt ? `${basePrompt}\n\n${hint}` : hint };
	});
}
