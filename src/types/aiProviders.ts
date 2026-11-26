export type BusinessWorkspaceId = 'ws-behind-the-release' | 'ws-74-studio-sales';

export type AiProviderId = 'gemini' | 'groq' | 'openrouter' | 'cloudflare';

export type AiTaskType =
  | 'creative-copy'
  | 'carousel-structure'
  | 'reels-plan'
  | 'marketing-generate'
  | 'marketing-platform'
  | 'long-form-article'
  | 'grounded-search'
  | 'audio-transcribe'
  | 'sales-lead-research'
  | 'sales-qualification'
  | 'sales-segmentation'
  | 'sales-buyer-intent'
  | 'sales-pain-points'
  | 'sales-opportunity-score'
  | 'sales-service-rec'
  | 'sales-response'
  | 'sales-follow-up'
  | 'sales-proposal-longform'
  | 'sales-campaign-intel'
  | 'lightweight-classification'
  | 'lightweight-tagging'
  | 'lightweight-summary'
  | 'lightweight-extract';

export type TaskComplexityTier = 'grounded' | 'audio' | 'complex' | 'long-form' | 'lightweight';

export interface AiModelSpec {
  id: string;
  providerId: AiProviderId;
  label: string;
  freeTierVerified: boolean;
  paidModel: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStructuredJson: boolean;
  supportsStreaming: boolean;
  supportsGroundedSearch?: boolean;
  supportsAudio?: boolean;
  lightweightOnly?: boolean;
  allowedTasks: AiTaskType[];
  verifiedViaLiveCatalog?: boolean;
  verifiedAt?: string;
  notes?: string;
}

export interface SectionCompletionManifestItem {
  index: number;
  expectedHeading: string;
  normalizedSlug: string;
  generationStatus: 'pending' | 'streaming' | 'generated' | 'failed';
  completionStatus: 'incomplete' | 'complete' | 'verified';
  savedContent: string;
  wordCount: number;
  providerId?: AiProviderId | 'fallback';
  model?: string;
  tokenCount?: number;
  completedAt?: string;
  error?: string;
}

export interface LongFormDocumentManifest {
  status: 'incomplete' | 'complete' | 'verified';
  totalExpectedSections: number;
  completedSections: number;
  duplicateHeadingsDetected: string[];
  consistencyIssues: string[];
  sections: SectionCompletionManifestItem[];
  lastUpdatedAt: string;
}

export interface TaskRoutePreference {
  preferredProvider: AiProviderId;
  allowFallback: boolean;
  allowCloudflareLightweight?: boolean;
}

export interface WorkspaceAiProfileConfig {
  workspaceId: BusinessWorkspaceId;
  workspaceLabel: string;
  providerOrder: AiProviderId[];
  enabledProviders: Record<AiProviderId, boolean>;
  selectedModels: Record<AiProviderId, string>;
  taskRouting: Partial<Record<AiTaskType, TaskRoutePreference>>;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  streamingEnabled: boolean;
  dailyRequestBudget: number;
  dailyTokenBudget: number;
  warningThresholdPct: number;
  updatedAt: string;
}

export interface UsageBucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fallbacksTriggered: number;
  errorsCount: number;
}

export interface SanitizedProviderError {
  id: string;
  workspaceId: BusinessWorkspaceId;
  providerId: AiProviderId;
  taskType: AiTaskType;
  errorClass: string;
  statusCode?: number;
  message: string;
  occurredAt: string;
}

export interface FallbackActivityEntry {
  id: string;
  workspaceId: BusinessWorkspaceId;
  taskType: AiTaskType;
  fromProvider: AiProviderId;
  toProvider: AiProviderId;
  reason: string;
  occurredAt: string;
}

export interface ProviderQuotaSummary {
  providerId: AiProviderId;
  name: string;
  roleLabel: string;
  configured: boolean;
  missingEnvVars: string[];
  disabledManually: boolean;
  availability: 'available' | 'cooldown' | 'disabled' | 'unconfigured' | 'budget-exhausted' | 'auth-error';
  cooldownUntil?: string;
  lastCooldownReason?: string;
  lastSuccessAt?: string;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  dailyRequestBudget: number;
  dailyTokenBudget: number;
  todayGlobalUsage: UsageBucket;
  monthlyGlobalUsage: UsageBucket;
  budgetPctRequests: number;
  budgetPctTokens: number;
  warningTriggered: boolean;
  validatedModels: AiModelSpec[];
  lightweightRestricted: boolean;
}

export interface WorkspaceQuotaStatus {
  workspaceId: BusinessWorkspaceId;
  todayUsage: UsageBucket;
  monthlyUsage: UsageBucket;
  dailyRequestBudget: number;
  dailyTokenBudget: number;
  warningThresholdPct: number;
  requestPct: number;
  tokenPct: number;
  warningTriggered: boolean;
  exhausted: boolean;
}

export interface AiProvidersDashboardSnapshot {
  todayKey: string;
  monthKey: string;
  costProtectionPolicy: {
    paidModelsBlocked: boolean;
    cloudflareLightweightOnly: boolean;
    groundingLockedToGemini: boolean;
  };
  providers: ProviderQuotaSummary[];
  workspaceConfigs: Record<BusinessWorkspaceId, WorkspaceAiProfileConfig>;
  workspaceUsage: Record<BusinessWorkspaceId, WorkspaceQuotaStatus>;
  recentErrors: SanitizedProviderError[];
  recentFallbacks: FallbackActivityEntry[];
}
