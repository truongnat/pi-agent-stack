import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { QEntry } from './types.ts'

export class ContextualBandit {
	private qTable: Map<string, QEntry> = new Map()
	private persistPath: string

	constructor(persistPath?: string) {
		this.persistPath = persistPath || join(homedir(), '.pi', 'agent', 'rl-qtable.json')
		this.load()
	}

	private key(taskType: string, model: string, thinkingLevel: string): string {
		return `${taskType}::${model}::${thinkingLevel}`
	}

	load(): void {
		if (!existsSync(this.persistPath)) return
		try {
			const data = JSON.parse(readFileSync(this.persistPath, 'utf8')) as QEntry[]
			for (const entry of data) {
				this.qTable.set(this.key(entry.taskType, entry.model, entry.thinkingLevel), entry)
			}
		} catch {
			// Unreadable: move it aside so the next save does not erase the learned history.
			try {
				renameSync(this.persistPath, `${this.persistPath}.corrupt-${Date.now()}`)
			} catch {
				// Nothing more to preserve.
			}
		}
	}

	save(): void {
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true })
			const entries = Array.from(this.qTable.values())
			const tmp = `${this.persistPath}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
			renameSync(tmp, this.persistPath)
		} catch {
			// ignore save error
		}
	}

	getEntry(taskType: string, model: string, thinkingLevel: string): QEntry {
		const k = this.key(taskType, model, thinkingLevel)
		let entry = this.qTable.get(k)
		if (!entry) {
			entry = {
				taskType,
				model,
				thinkingLevel,
				qValue: 0.5,
				trials: 0,
				successes: 0
			}
			this.qTable.set(k, entry)
		}
		return entry
	}

	update(
		taskType: string,
		model: string,
		thinkingLevel: string,
		reward: number,
		learningRate: number = 0.2
	): void {
		const entry = this.getEntry(taskType, model, thinkingLevel)
		entry.trials++
		if (reward > 0) entry.successes++
		entry.qValue = entry.qValue + learningRate * (reward - entry.qValue)
		this.save()
	}

	selectBestArm(
		taskType: string,
		availableArms: Array<{ model: string; thinkingLevel: string }>,
		epsilon: number = 0.1
	): {
		model: string
		thinkingLevel: string
		qValue: number
		explored: boolean
	} {
		if (availableArms.length === 0) {
			return {
				model: 'gpt-5.6-luna',
				thinkingLevel: 'high',
				qValue: 0.5,
				explored: false
			}
		}

		// Epsilon-greedy exploration
		if (Math.random() < epsilon) {
			const randomIndex = Math.floor(Math.random() * availableArms.length)
			const arm = availableArms[randomIndex]!
			const entry = this.getEntry(taskType, arm.model, arm.thinkingLevel)
			return { ...arm, qValue: entry.qValue, explored: true }
		}

		// Exploitation: Pick arm with highest Q-value
		let bestArm = availableArms[0]!
		let maxQ = -Infinity

		for (const arm of availableArms) {
			const entry = this.getEntry(taskType, arm.model, arm.thinkingLevel)
			if (entry.qValue > maxQ) {
				maxQ = entry.qValue
				bestArm = arm
			}
		}

		return { ...bestArm, qValue: maxQ, explored: false }
	}

	getAllEntries(): QEntry[] {
		return Array.from(this.qTable.values())
	}
}
