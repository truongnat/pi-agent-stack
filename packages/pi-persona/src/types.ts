export type PreferenceCategory = "coding" | "workflow" | "communication";

export interface UserPreference {
  id: string;
  category: PreferenceCategory;
  key: string;
  rule: string;
  weight: number; // Confidence score / Q-value from 0.0 to 1.0
  reinforcements: number; // Count of positive affirmations/rewards
  rejections: number; // Count of user counter-corrections/penalties
  createdAt: number;
  lastAppliedAt: number;
}

export interface PersonaConfig {
  enabled: boolean;
  maxInjectedTokens: number;
  minConfidenceThreshold: number;
  defaults?: UserPreference[];
}

export interface PersonaProfile {
  version: string;
  updatedAt: number;
  preferences: UserPreference[];
}
