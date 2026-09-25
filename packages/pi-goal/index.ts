import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createGoalExtension } from './src/extension.ts'

export default function (pi: ExtensionAPI) {
	createGoalExtension(pi)
}
