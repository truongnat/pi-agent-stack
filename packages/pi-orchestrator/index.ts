import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createOrchestratorExtension } from './src/extension.ts'

export default function (pi: ExtensionAPI) {
	createOrchestratorExtension(pi)
}
