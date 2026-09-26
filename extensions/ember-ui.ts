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
const MUTE = "\x1b[38;2;110;115;141m";
const SEP = ` ${MUTE}│${RESET} `;
const RESET = "\x1b[0m";

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
	const provider = ctx.model?.provider || "";
	const modelLabel = provider
		? `${MUTE}${provider}/${RESET}${BOLD_TEXT}${model}${RESET}`
		: `${BOLD_TEXT}${model}${RESET}`;

	const thinking =
		ctx.thinkingLevel ||
		ctx.getThinkingLevel?.() ||
		"high";
	const thinkBadge = `${MAUVE}think: ${thinking}${RESET}`;

	const jevActive = hasJevKey();
	const jevBadge = jevActive
		? `${EMERALD}jev: active${RESET}`
		: `${AMBER}jev: offline${RESET}`;

	const brand = `${BOLD_COPPER}● ember${RESET}`;

	return [` ${brand}${SEP}${modelLabel}${SEP}${thinkBadge}${SEP}${jevBadge}`];
}

export default function emberUi(pi: {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	getThinkingLevel?: () => string;
}) {
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
		ui.ui?.setTitle?.(`pi ember | ${modelId}`);
	};

	pi.on("session_start", paint);
	pi.on("session_before_tree", paint);
	pi.on("model_select", (event: unknown, ctx: unknown) =>
		paint(event, {
			...(ctx as object),
			model: (event as { model?: { id?: string; provider?: string } }).model,
		}),
	);
}
