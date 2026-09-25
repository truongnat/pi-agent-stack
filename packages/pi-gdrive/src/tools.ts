import * as t from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GDriveClient } from './client.ts'

const client = new GDriveClient()

function formatFileSize(bytesStr?: string): string {
	if (!bytesStr) return 'N/A'
	const bytes = Number.parseInt(bytesStr, 10)
	if (Number.isNaN(bytes)) return bytesStr
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 1. Tool: gdrive_search
const GDriveSearchSchema = t.Object({
	query: t.String({
		description: 'Search query keyword, screen ID, or filename pattern (e.g. "FAC10001", "画面設計書", "出荷案内書").'
	}),
	mime_type: t.Optional(
		t.String({
			description:
				'Filter by file type: "spreadsheet" / "excel", "document" / "word", "folder", "pdf", or specific MIME type.',
			default: 'all'
		})
	),
	limit: t.Optional(
		t.Integer({
			description: 'Maximum number of search results to return (default: 10, max: 50).',
			default: 10
		})
	)
})

export const gdriveSearchTool: ToolDefinition<typeof GDriveSearchSchema> = defineTool({
	name: 'gdrive_search',
	label: 'Google Drive Search',
	description:
		'Search files and folders on Google Drive by name, keyword, program ID, or type, returning file IDs, modified dates, sizes, and Drive links.',
	promptSnippet: 'gdrive_search(query, mime_type, limit) — search Google Drive files',
	parameters: GDriveSearchSchema,
	executionMode: 'sequential',
	async execute(_toolCallId, params) {
		try {
			const files = await client.searchFiles({
				query: params.query,
				mimeType: params.mime_type !== 'all' ? params.mime_type : undefined,
				limit: params.limit ?? 10
			})

			if (files.length === 0) {
				return {
					content: [{ type: 'text', text: `No files found on Google Drive matching query: "${params.query}"` }],
					details: { count: 0 }
				}
			}

			const tableRows = files.map((f) => {
				const size = formatFileSize(f.size)
				const mod = f.modifiedTime ? f.modifiedTime.slice(0, 16).replace('T', ' ') : '-'
				return `| \`${f.id}\` | **${f.name}** | ${size} | ${mod} |`
			})

			const text = [
				`### Google Drive Search Results for: "${params.query}" (Found: ${files.length})`,
				'| File ID | Name | Size | Modified (UTC) |',
				'| --- | --- | --- | --- |',
				...tableRows,
				'',
				'> **Tip**: Use `gdrive_download(file_id: "...")` to fetch any file locally.'
			].join('\n')

			return {
				content: [{ type: 'text', text }],
				details: { count: files.length, files }
			}
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Error searching Google Drive: ${err instanceof Error ? err.message : String(err)}`
					}
				],
				isError: true
			}
		}
	}
})

// 2. Tool: gdrive_download
const GDriveDownloadSchema = t.Object({
	file_id: t.String({
		description: 'The Google Drive file ID to download.'
	}),
	destination_path: t.Optional(
		t.String({
			description:
				'Local path where the file should be saved. If omitted, Excel specs are saved to ~/.agents/bsn-specs-excel/<filename>, otherwise to current working directory.'
		})
	)
})

export const gdriveDownloadTool: ToolDefinition<typeof GDriveDownloadSchema> = defineTool({
	name: 'gdrive_download',
	label: 'Google Drive Download',
	description:
		'Download a file from Google Drive by its file ID to a local destination path (supports Excel, Word, PDF, ZIP, and auto-exports Google Docs/Sheets).',
	promptSnippet: 'gdrive_download(file_id, destination_path) — download file from Google Drive',
	parameters: GDriveDownloadSchema,
	executionMode: 'sequential',
	async execute(_toolCallId, params) {
		try {
			const meta = await client.getFileMetadata(params.file_id)

			let targetPath = params.destination_path
			if (!targetPath) {
				let safeName = meta.name
				if (meta.mimeType === 'application/vnd.google-apps.spreadsheet' && !safeName.endsWith('.xlsx')) {
					safeName += '.xlsx'
				} else if (meta.mimeType === 'application/vnd.google-apps.document' && !safeName.endsWith('.docx')) {
					safeName += '.docx'
				}

				if (safeName.endsWith('.xlsx') || safeName.endsWith('.xlsm') || safeName.endsWith('.xls')) {
					targetPath = join(homedir(), '.agents', 'bsn-specs-excel', safeName)
				} else {
					targetPath = join(process.cwd(), safeName)
				}
			}

			const result = await client.downloadFile(params.file_id, targetPath)

			return {
				content: [
					{
						type: 'text',
						text: `Successfully downloaded Google Drive file **"${meta.name}"**.\n- **Saved to**: \`${result.path}\`\n- **Size**: ${formatFileSize(String(result.bytes))}\n- **Modified Time**: ${meta.modifiedTime ?? 'N/A'}`
					}
				],
				details: {
					fileId: params.file_id,
					name: meta.name,
					path: result.path,
					bytes: result.bytes
				}
			}
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Error downloading Google Drive file "${params.file_id}": ${err instanceof Error ? err.message : String(err)}`
					}
				],
				isError: true
			}
		}
	}
})

// 3. Tool: gdrive_get_file_info
const GDriveInfoSchema = t.Object({
	file_id: t.String({
		description: 'The Google Drive file ID.'
	})
})

export const gdriveInfoTool: ToolDefinition<typeof GDriveInfoSchema> = defineTool({
	name: 'gdrive_get_file_info',
	label: 'Google Drive File Info',
	description: 'Get detailed metadata and links for a file or folder on Google Drive.',
	promptSnippet: 'gdrive_get_file_info(file_id) — get Google Drive file metadata',
	parameters: GDriveInfoSchema,
	executionMode: 'sequential',
	async execute(_toolCallId, params) {
		try {
			const meta = await client.getFileMetadata(params.file_id)
			const text = [
				`### Google Drive File: ${meta.name}`,
				`- **ID**: \`${meta.id}\``,
				`- **MIME Type**: \`${meta.mimeType}\``,
				`- **Size**: ${formatFileSize(meta.size)}`,
				`- **Modified Time**: ${meta.modifiedTime ?? 'N/A'}`,
				`- **Web View Link**: ${meta.webViewLink ?? 'N/A'}`
			].join('\n')

			return {
				content: [{ type: 'text', text }],
				details: meta
			}
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Error fetching Google Drive metadata: ${err instanceof Error ? err.message : String(err)}`
					}
				],
				isError: true
			}
		}
	}
})
