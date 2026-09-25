import * as t from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Xlsx2MdRunner } from './cli.ts'

const runner = new Xlsx2MdRunner()

const MAX_INLINE_CHARS = 40_000

// 1. Tool: xlsx2md_convert
const ConvertSchema = t.Object({
	file_path: t.String({
		description: 'Absolute or relative path to the Excel file (.xlsx or .xlsm).'
	}),
	sheet: t.Optional(
		t.String({
			description: 'Optional sheet name to convert (e.g. "変更履歴", "画面レイアウト", "単項目チェック"). If omitted, converts all sheets.'
		})
	),
	output_path: t.Optional(
		t.String({
			description: 'Optional file path to save the generated Markdown file (e.g. "./spec.md").'
		})
	),
	with_meta: t.Optional(
		t.Boolean({
			description:
				'Whether to extract cell colors, fills, font highlights, comments, and merges map into a .meta.json sidecar file.',
			default: false
		})
	),
	no_markup: t.Optional(
		t.Boolean({
			description: 'Disable strikethrough (~~text~~) and comment annotations in cell text.',
			default: false
		})
	)
})

export const convertTool: ToolDefinition<typeof ConvertSchema> = defineTool({
	name: 'xlsx2md_convert',
	label: 'Convert Excel to Markdown (xlsx2md)',
	description:
		'Convert complex/merged Excel files (.xlsx, .xlsm, Japanese screen/report design books 画面設計書/帳票設計書) into clean, densified GitHub Markdown without NaN or Unnamed artifacts.',
	promptSnippet: 'xlsx2md_convert(file_path, sheet, output_path, with_meta) — convert Excel to clean Markdown',
	parameters: ConvertSchema,
	executionMode: 'sequential',
	async execute(_toolCallId, params) {
		try {
			const metaPath = params.with_meta
				? params.output_path
					? params.output_path.replace(/\.md$/, '.meta.json')
					: `${params.file_path}.meta.json`
				: undefined

			const res = await runner.convert({
				inputPath: params.file_path,
				outputPath: params.output_path,
				sheet: params.sheet,
				noMarkup: params.no_markup,
				metaPath
			})

			if (!res.success) {
				return {
					content: [
						{
							type: 'text',
							text: `Error converting Excel file "${params.file_path}":\n${res.error}\n${res.stats}`
						}
					],
					isError: true
				}
			}

			const md = res.markdown || ''
			let outputText = ''

			if (params.output_path) {
				outputText += `Successfully converted "${params.file_path}" to "${params.output_path}".\n`
				if (metaPath) outputText += `Metadata sidecar saved to "${metaPath}".\n`
				if (res.stats) outputText += `\n**Stats**:\n${res.stats}\n`
				if (md.length > 0 && md.length <= MAX_INLINE_CHARS) {
					outputText += `\n---\n\n${md}`
				} else if (md.length > MAX_INLINE_CHARS) {
					outputText += `\n---\n\n(Content is large: ${md.length} characters. Showing preview first ${MAX_INLINE_CHARS} chars):\n\n${md.slice(0, MAX_INLINE_CHARS)}\n\n...(truncated)`
				}
			} else {
				if (res.stats) outputText += `**Stats**: ${res.stats}\n\n`
				if (md.length <= MAX_INLINE_CHARS) {
					outputText += md
				} else {
					outputText += `(Output is ${md.length} characters. Showing preview):\n\n${md.slice(0, MAX_INLINE_CHARS)}\n\n...(truncated. Consider using output_path to save full file)`
				}
			}

			return {
				content: [{ type: 'text', text: outputText }],
				details: {
					file: params.file_path,
					outputPath: params.output_path,
					metaPath,
					stats: res.stats,
					chars: md.length
				}
			}
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Failed to execute xlsx2md: ${err instanceof Error ? err.message : String(err)}`
					}
				],
				isError: true
			}
		}
	}
})

// 2. Tool: xlsx2md_diff
const DiffSchema = t.Object({
	base_file: t.String({
		description: 'Path to the older / baseline Excel file.'
	}),
	other_file: t.String({
		description: 'Path to the newer Excel file to compare.'
	}),
	sheet: t.Optional(
		t.String({
			description: 'Optional sheet name to restrict the diff comparison to.'
		})
	),
	output_path: t.Optional(
		t.String({
			description: 'Optional file path to save the diff Markdown result.'
		})
	),
	with_meta: t.Optional(
		t.Boolean({
			description: 'Whether to save the detailed diff metadata as JSON.',
			default: false
		})
	)
})

export const diffTool: ToolDefinition<typeof DiffSchema> = defineTool({
	name: 'xlsx2md_diff',
	label: 'Diff Excel Workbooks (xlsx2md diff)',
	description:
		'Compare two Excel workbooks and produce a detailed diff of cell texts, formulas, background fills, font colors, strikethroughs, comments, and merged ranges.',
	promptSnippet: 'xlsx2md_diff(base_file, other_file, sheet, output_path) — compare two Excel files and show changes',
	parameters: DiffSchema,
	executionMode: 'sequential',
	async execute(_toolCallId, params) {
		try {
			const metaPath = params.with_meta
				? params.output_path
					? params.output_path.replace(/\.md$/, '.meta.json')
					: `${params.other_file}.diff.meta.json`
				: undefined

			const res = await runner.diff({
				basePath: params.base_file,
				otherPath: params.other_file,
				outputPath: params.output_path,
				sheet: params.sheet,
				metaPath
			})

			if (!res.success) {
				return {
					content: [
						{
							type: 'text',
							text: `Error diffing Excel files:\n${res.error}\n${res.stats}`
						}
					],
					isError: true
				}
			}

			const md = res.markdown || ''
			let outputText = ''

			if (params.output_path) {
				outputText += `Diff report between "${params.base_file}" and "${params.other_file}" saved to "${params.output_path}".\n`
				if (metaPath) outputText += `Diff metadata saved to "${metaPath}".\n`
				if (res.stats) outputText += `\n**Stats**: ${res.stats}\n`
				if (md.length > 0 && md.length <= MAX_INLINE_CHARS) {
					outputText += `\n---\n\n${md}`
				}
			} else {
				if (res.stats) outputText += `**Diff Stats**: ${res.stats}\n\n`
				outputText += md.length <= MAX_INLINE_CHARS ? md : `${md.slice(0, MAX_INLINE_CHARS)}\n\n...(truncated)`
			}

			return {
				content: [{ type: 'text', text: outputText }],
				details: {
					baseFile: params.base_file,
					otherFile: params.other_file,
					stats: res.stats,
					chars: md.length
				}
			}
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Failed to execute xlsx2md diff: ${err instanceof Error ? err.message : String(err)}`
					}
				],
				isError: true
			}
		}
	}
})
