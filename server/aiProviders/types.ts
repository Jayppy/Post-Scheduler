import type {
  AiModelSpec,
  AiProviderId,
  AiTaskType,
  BusinessWorkspaceId,
  TaskComplexityTier,
} from '../../src/types/aiProviders';

export type ProviderErrorClass =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'AUTH_INVALID'
  | 'BAD_REQUEST'
  | 'MODEL_UNSUPPORTED'
  | 'BUDGET_EXHAUSTED'
  | 'PROVIDER_DISABLED'
  | 'TASK_RESTRICTED'
  | 'INTERNAL_ERROR';

export class ProviderExecutionError extends Error {
  providerId: AiProviderId;
  errorClass: ProviderErrorClass;
  statusCode: number;
  retryable: boolean;
  allowFallback: boolean;
  retryAfterMs?: number;

  constructor(opts: {
    providerId: AiProviderId;
    errorClass: ProviderErrorClass;
    statusCode: number;
    message: string;
    retryable: boolean;
    allowFallback: boolean;
    retryAfterMs?: number;
  }) {
    super(opts.message);
    this.name = 'ProviderExecutionError';
    this.providerId = opts.providerId;
    this.errorClass = opts.errorClass;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable;
    this.allowFallback = opts.allowFallback;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderAdapterCallOptions {
  model: AiModelSpec;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  responseFormat?: 'text' | 'json';
  geminiJsonSchema?: Record<string, unknown>;
  onStreamChunk?: (chunkText: string) => void;
}

export interface ProviderAdapterResult {
  text: string;
  finishReason: string;
  usage: NormalizedUsage;
  latencyMs: number;
  truncated?: boolean;
}

export interface AiProviderAdapter {
  providerId: AiProviderId;
  name: string;
  isConfigured(): boolean;
  getMissingEnvVars(): string[];
  generate(opts: ProviderAdapterCallOptions): Promise<ProviderAdapterResult>;
  stream(opts: ProviderAdapterCallOptions): Promise<ProviderAdapterResult>;
  healthCheck(model: AiModelSpec, timeoutMs?: number): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}

export interface ExecuteAiTaskRequest {
  workspaceId: BusinessWorkspaceId;
  taskType: AiTaskType;
  prompt: string;
  systemPrompt?: string;
  responseFormat?: 'text' | 'json';
  geminiJsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  stream?: boolean;
  onStreamChunk?: (chunkText: string, providerId: AiProviderId, model: string) => void;
  onFallbackSwitch?: (from: AiProviderId, to: AiProviderId, reason: string) => void;
  mockAdapterOverride?: Partial<Record<AiProviderId, AiProviderAdapter>>;
}

export interface ExecuteAiTaskResponse {
  text: string;
  providerId: AiProviderId;
  model: string;
  finishReason: string;
  truncated: boolean;
  usage: NormalizedUsage;
  latencyMs: number;
  wasFallback: boolean;
  fallbackChain: Array<{ providerId: AiProviderId; errorClass: string; message: string }>;
}

export const LIGHTWEIGHT_TASKS: ReadonlySet<AiTaskType> = new Set<AiTaskType>([
  'lightweight-classification',
  'lightweight-tagging',
  'lightweight-summary',
  'lightweight-extract',
]);

export function getTaskComplexityTier(taskType: AiTaskType): TaskComplexityTier {
  if (taskType === 'grounded-search') return 'grounded';
  if (taskType === 'audio-transcribe') return 'audio';
  if (taskType === 'long-form-article' || taskType === 'sales-proposal-longform') return 'long-form';
  if (LIGHTWEIGHT_TASKS.has(taskType)) return 'lightweight';
  return 'complex';
}

export function sanitizeDiagnosticMessage(raw: string): string {
  // Never persist or return potential Bearer tokens, API keys, or query-string secrets
  return String(raw || '')
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, '[REDACTED_KEY]')
    .replace(/gsk_[0-9A-Za-z\-_]{10,}/g, '[REDACTED_KEY]')
    .replace(/sk-or-[0-9A-Za-z\-_]{10,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[0-9A-Za-z\-_.=+/]{8,}/gi, 'Bearer [REDACTED]')
    .slice(0, 400);
}
