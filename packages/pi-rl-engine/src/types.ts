export type RLMode = 'on' | 'off' | 'shadow' | 'passive'

export interface RewardWeights {
	test: number
	lint: number
	cost: number
}

export interface RLConfig {
	mode: RLMode
	autoVerifyOnEdit: boolean
	shadowBranchFactor: number
	testCommand?: string
	testTimeoutMs: number
	explorationRate: number
	rewardWeights: RewardWeights
}

export interface VerificationDetail {
	test?: {
		command: string
		passed: boolean
		exitCode: number
		output: string
	}
	lint?: {
		command: string
		passed: boolean
		exitCode: number
	}
	latencyMs?: number
}

export interface RewardResult {
	totalReward: number
	passed: boolean
	details: VerificationDetail
	at: string
}

export interface RolloutCandidate {
	id: string
	worktreePath: string
	branchName: string
	reward: RewardResult
	patch: string
}

export interface RLStats {
	verifications: number
	passedVerifications: number
	failedVerifications: number
	shadowRollouts: number
	rolloutWins: number
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
