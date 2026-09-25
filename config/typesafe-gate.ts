/**
 * Harness-layer Jev gate. Reuses ~/.agents/typesafe-harness (same as Claude/Grok/Codex).
 * Jev never appears as a model-callable tool.
 */
import { spawn } from "node:child_process";

const PRE_TOOL = "/home/vietis/.agents/typesafe-harness/pre-tool.sh";
const PROMPT = "/home/vietis/.agents/typesafe-harness/prompt.sh";
const TOOL_TIMEOUT_MS = 8000;
const PROMPT_TIMEOUT_MS = 12000;

type GateOut = {
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
			finish({});
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish({});
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				finish(JSON.parse(out || "{}") as GateOut);
			} catch {
				finish({});
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

export default function typesafeGate(pi: {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
}) {
	pi.on("tool_call", async (event: unknown, ctx: unknown) => {
		const call = event as { toolName?: string; input?: Record<string, unknown> };
		const ui = ctx as {
			hasUI?: boolean;
			ui?: { confirm?: (q: string) => Promise<boolean>; notify?: (m: string, k?: string) => void };
		};
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
