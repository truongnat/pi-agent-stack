import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerRLExtension } from './src/extension.ts'

export default function (pi: ExtensionAPI): void {
	registerRLExtension(pi)
}
