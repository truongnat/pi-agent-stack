/**
 * Ember chrome: copper spinner, compact rail above the editor, window title.
 */
const COPPER = "\x1b[38;2;245;169;127m";
const MUTE = "\x1b[38;2;165;173;203m";
const RESET = "\x1b[0m";

function rail(ctx: {
	model?: { id?: string; provider?: string };
	sessionManager?: { getModel?: () => { id?: string } };
}): string[] {
	const model =
		ctx.model?.id ||
		ctx.sessionManager?.getModel?.()?.id ||
		"model";
	const provider = ctx.model?.provider || "";
	const label = provider ? `${provider}/${model}` : model;
	return [`${COPPER}ember${RESET} ${MUTE}|${RESET} ${label} ${MUTE}|${RESET} jev`];
}

export default function emberUi(pi: {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
}) {
	const paint = (_event: unknown, ctx: unknown) => {
		const ui = ctx as {
			hasUI?: boolean;
			mode?: string;
			model?: { id?: string; provider?: string };
			sessionManager?: { getModel?: () => { id?: string } };
			ui?: {
				setWidget?: (key: string, content: string[] | undefined, opts?: { placement?: string }) => void;
				setWorkingIndicator?: (opts?: { frames?: string[]; intervalMs?: number }) => void;
				setHiddenThinkingLabel?: (label?: string) => void;
				setTitle?: (title: string) => void;
			};
		};
		if (!ui.hasUI || ui.mode === "json" || ui.mode === "print") return;
		ui.ui?.setWidget?.("ember-rail", rail(ui), { placement: "aboveEditor" });
		ui.ui?.setWorkingIndicator?.({
			frames: [
				`${COPPER}·${RESET}`,
				`${COPPER}:${RESET}`,
				`${COPPER}•${RESET}`,
				`${COPPER}●${RESET}`,
				`${COPPER}•${RESET}`,
				`${COPPER}:${RESET}`,
			],
			intervalMs: 90,
		});
		ui.ui?.setHiddenThinkingLabel?.("think");
		ui.ui?.setTitle?.("pi ember");
	};

	pi.on("session_start", paint);
	pi.on("session_before_tree", paint);
	// Repaint on model changes (/model, /accounts, automatic switches); the event carries the new model.
	pi.on("model_select", (event: unknown, ctx: unknown) =>
		paint(event, { ...(ctx as object), model: (event as { model?: { id?: string; provider?: string } }).model }),
	);
}
