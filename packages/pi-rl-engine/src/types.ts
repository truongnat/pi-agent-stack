export type RLMode = 'on' | 'off' | 'passive'

export interface RewardWeights {
	test: number
	lint: number
	cost: number
}

export interface RLConfig {
	mode: RLMode
	autoVerifyOnEdit: boolean
	testCommand?: string
	testTimeoutMs: number
	rewardWeights: RewardWeights
}

export interface VerificationDetail {
	test?: {
		command: string
		status: 'passed' | 'failed' | 'skipped'
		passed: boolean
		exitCode: number
		output: string
		reason?: string
	}
	lint?: {
		command: string
		passed: boolean
		exitCode: number
	}
	latencyMs?: number
}

export interface RewardResult {
	status: 'passed' | 'failed' | 'skipped'
	totalReward: number
	passed: boolean
	details: VerificationDetail
	at: string
}

export interface RLStats {
	verifications: number
	skippedVerifications: number
	passedVerifications: number
	failedVerifications: number
	totalRewardAccumulated: number
}

export interface QEntry {
	taskType: string
	model: string
	thinkingLevel: string
	qValue: number
	trials: number
	successes: number
}
