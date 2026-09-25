import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerRLExtension } from './src/extension.ts'

export default function (pi: ExtensionAPI): void {
	registerRLExtension(pi)
}

export * from './src/bandit.ts'
export * from './src/lessons.ts'
export * from './src/reflection.ts'
export * from './src/verifier.ts'
