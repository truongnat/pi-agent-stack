import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown } from '../src/tui-markdown.ts'

test('renderMarkdown paints headings and emphasis instead of source markers', () => {
	const theme = {
		fg: (_color: string, text: string) => text
	}
	const component = renderMarkdown('# Title\n\n**bold** and `code`', 0, theme)
	const lines = typeof component.render === 'function' ? component.render(80) : []
	const painted = Array.isArray(lines) ? lines.join('\n') : String(lines)
	assert.match(painted, /Title/)
	assert.match(painted, /bold/)
	assert.equal(painted.includes('# Title'), false)
	assert.equal(painted.includes('**bold**'), false)
	assert.equal(painted.includes('`code`'), false)
})
