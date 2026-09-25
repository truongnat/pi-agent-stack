import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerGDriveExtension } from './src/extension.ts'

export default function (pi: ExtensionAPI): void {
	registerGDriveExtension(pi)
}

export * from './src/client.ts'
export * from './src/tools.ts'
