import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent'
import { Markdown, Text, type Component } from '@earendil-works/pi-tui'

type ThemeLike = {
	fg: (color: any, text: string) => string
}

function ensurePiTheme(): void {
	try {
		getMarkdownTheme().heading('x')
	} catch {
		initTheme()
	}
}

/**
 * Paint markdown the same way Pi paints assistant messages.
 * Markdown.render() calls the theme; without initTheme it throws and the TUI
 * falls back to raw `**` / `#` source. Catch paint errors too.
 */
export function renderMarkdown(
	text: string,
	paddingX: number,
	uiTheme: ThemeLike,
	colorKey = 'toolOutput'
): Component {
	const body = text.trimEnd()
	if (!body) return new Text('', paddingX, 0)
	ensurePiTheme()
	try {
		const mdTheme = getMarkdownTheme()
		const painted = new Markdown(body, paddingX, 0, mdTheme, {
			color: (s) => uiTheme.fg(colorKey, s)
		})
		return {
			render: (width: number) => {
				try {
					return painted.render(width)
				} catch {
					return new Text(body, paddingX, 0).render(width)
				}
			},
			invalidate: () => painted.invalidate()
		} satisfies Component
	} catch {
		return new Text(body, paddingX, 0)
	}
}
