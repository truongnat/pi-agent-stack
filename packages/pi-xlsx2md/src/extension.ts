import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { convertTool, diffTool } from './tools.ts'

export function registerXlsx2MdExtension(pi: ExtensionAPI): void {
	pi.registerTool(convertTool)
	pi.registerTool(diffTool)
}
