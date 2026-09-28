import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OrchestratorConfig } from '../src/config.ts'
import { SubagentManager, type WorkerRequest, type WorkerRunner } from '../src/manager.ts'

/** A pi worker that streams one assistant reply, the way `pi --mode json` does. */
export const piReply =
	(text: string, usage = { input: 120, output: 30 }): WorkerRunner =>
	async (request) => {
		const line = JSON.stringify({
			type: 'message_end',
			message: { role: 'assistant', content: [{ type: 'text', text }], usage }
		})
		request.onChunk?.(`${line}\n`)
		return { stdout: line, stderr: '', code: 0 }
	}

/** Manager with scratchpads in a temp dir and a fake runner; `calls` records every spawn. */
export function fakeManager(
	config: Partial<OrchestratorConfig> = {},
	runner: WorkerRunner = piReply('Completed successfully.')
) {
	const calls: WorkerRequest[] = []
	const manager = new SubagentManager(
		{ scratchpadRoot: mkdtempSync(join(tmpdir(), 'orch-')), ...config },
		{
			runner: (request) => {
				calls.push(request)
				return runner(request)
			}
		}
	)
	return { manager, calls }
}
