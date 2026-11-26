import type {
  AiProviderId,
  AiProvidersDashboardSnapshot,
  BusinessWorkspaceId,
  ProviderQuotaSummary,
} from '../../src/types/aiProviders';
import { ADAPTER_REGISTRY } from './adapters';
import {
  getValidatedModelsForProvider,
  refreshLiveProviderCatalog,
  validateModelForTask,
} from './modelRegistry';
import {
  checkQuotaAndAvailability,
  getGlobalProviderBuckets,
  getWorkspaceAiConfig,
  getWorkspaceQuotaStatus,
  loadQuotaStore,
  recordProviderError,
  recordProviderFallback,
  recordProviderSuccess,
} from './quotaStore';
import {
  type ExecuteAiTaskRequest,
  type ExecuteAiTaskResponse,
  getTaskComplexityTier,
  ProviderExecutionError,
  sanitizeDiagnosticMessage,
} from './types';

const PROVIDER_META: Record<AiProviderId, { name: string; roleLabel: string; lightweightRestricted: boolean }> = {
  gemini: {
    name: 'Google Gemini API',
    roleLabel: 'Primary (All Tasks + Search Grounding + Audio)',
    lightweightRestricted: false,
  },
  groq: {
    name: 'Groq API',
    roleLabel: 'Fallback #1 (Free-Tier Fast Inference)',
    lightweightRestricted: false,
  },
  openrouter: {
    name: 'OpenRouter API',
    roleLabel: 'Fallback #2 ($0.00 Verified Free Catalog)',
    lightweightRestricted: false,
  },
  cloudflare: {
    name: 'Cloudflare Workers AI',
    roleLabel: 'Optional Lightweight Only (Tagging / Classification)',
    lightweightRestricted: true,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function resolveCandidateProviders(req: ExecuteAiTaskRequest): AiProviderId[] {
  const tier = getTaskComplexityTier(req.taskType);

  // Grounded web search & audio transcription are strictly Gemini-only
  if (tier === 'grounded' || tier === 'audio') {
    return ['gemini'];
  }

  const wsCfg = getWorkspaceAiConfig(req.workspaceId);
  const routePref = wsCfg.taskRouting[req.taskType];
  const ordered: AiProviderId[] = [];
  const seen = new Set<AiProviderId>();

  const pushUnique = (pid: AiProviderId) => {
    if (seen.has(pid)) return;
    // Block Cloudflare Workers AI on non-lightweight tasks at routing time too
    if (pid === 'cloudflare' && tier !== 'lightweight') return;
    seen.add(pid);
    ordered.push(pid);
  };

  if (routePref?.preferredProvider) {
    pushUnique(routePref.preferredProvider);
  }
  for (const pid of wsCfg.providerOrder) {
    pushUnique(pid);
  }

  if (routePref && routePref.allowFallback === false && ordered.length > 1) {
    return [ordered[0]];
  }
  return ordered;
}

export async function executeAiTask(req: ExecuteAiTaskRequest): Promise<ExecuteAiTaskResponse> {
  const wsCfg = getWorkspaceAiConfig(req.workspaceId);
  const candidates = resolveCandidateProviders(req);
  const timeoutMs = Math.max(3000, Math.min(120_000, req.timeoutMs || wsCfg.requestTimeoutMs));
  const requiresJsonSchema = req.responseFormat === 'json';
  const fallbackChain: Array<{ providerId: AiProviderId; errorClass: string; message: string }> = [];
  const attemptedProviders = new Set<AiProviderId>();

  let lastFailoverProvider: AiProviderId | null = null;
  let lastFailoverReason = '';

  for (const providerId of candidates) {
    if (attemptedProviders.has(providerId)) continue; // Strict loop prevention
    attemptedProviders.add(providerId);

    const adapter = req.mockAdapterOverride?.[providerId] || ADAPTER_REGISTRY[providerId];
    if (!adapter) continue;

    // 1. Secret configuration check (if mock is NOT injected and key isn't configured, skip cleanly)
    if (!adapter.isConfigured()) {
      fallbackChain.push({
        providerId,
        errorClass: 'UNCONFIGURED',
        message: `${adapter.name} skipped (missing server secrets: ${adapter.getMissingEnvVars().join(', ')}).`,
      });
      continue;
    }

    // 2. Quota, cooldown, manual disable, and workspace-isolated budget check
    const quotaCheck = checkQuotaAndAvailability(req.workspaceId, providerId);
    if (!quotaCheck.ok) {
      fallbackChain.push({
        providerId,
        errorClass: quotaCheck.code,
        message: quotaCheck.reason,
      });
      continue;
    }

    // 3. Model validation (free-tier, output caps, JSON support, Cloudflare lightweight gate)
    const selectedModelId =
      req.taskType === 'audio-transcribe'
        ? 'gemini-3.5-transcribe'
        : wsCfg.selectedModels[providerId];
    const modelCheck = validateModelForTask({
      providerId,
      modelId: selectedModelId,
      taskType: req.taskType,
      requiresJsonSchema,
      requestedMaxTokens: req.maxOutputTokens || wsCfg.maxOutputTokens,
    });

    if (!modelCheck.ok) {
      // Invalid or paid or task-restricted model must NOT silently upgrade or bypass policy
      if (modelCheck.code === 'MODEL_UNSUPPORTED') {
        throw new ProviderExecutionError({
          providerId,
          errorClass: 'MODEL_UNSUPPORTED',
          statusCode: 400,
          message: modelCheck.reason,
          retryable: false,
          allowFallback: false,
        });
      }
      fallbackChain.push({
        providerId,
        errorClass: modelCheck.code,
        message: modelCheck.reason,
      });
      continue;
    }

    if (lastFailoverProvider) {
      recordProviderFallback({
        workspaceId: req.workspaceId,
        taskType: req.taskType,
        fromProvider: lastFailoverProvider,
        toProvider: providerId,
        reason: lastFailoverReason,
      });
      req.onFallbackSwitch?.(lastFailoverProvider, providerId, lastFailoverReason);
    }

    // Execute with bounded exponential backoff retries for transient failures
    const maxAttempts = 2;
    let attemptErr: ProviderExecutionError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const callOpts = {
          model: modelCheck.spec,
          prompt: req.prompt,
          systemPrompt: req.systemPrompt,
          maxOutputTokens: modelCheck.clampedMaxOutputTokens,
          temperature: req.temperature,
          timeoutMs,
          responseFormat: req.responseFormat || 'text',
          geminiJsonSchema: req.geminiJsonSchema,
          onStreamChunk: req.onStreamChunk
            ? (chunk: string) => req.onStreamChunk!(chunk, providerId, modelCheck.spec.id)
            : undefined,
        };

        const result =
          req.stream && modelCheck.spec.supportsStreaming
            ? await adapter.stream(callOpts)
            : await adapter.generate(callOpts);

        recordProviderSuccess({
          workspaceId: req.workspaceId,
          providerId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: result.latencyMs,
        });

        return {
          text: result.text,
          providerId,
          model: modelCheck.spec.id,
          finishReason: result.finishReason,
          truncated: Boolean(result.truncated),
          usage: result.usage,
          latencyMs: result.latencyMs,
          wasFallback: fallbackChain.length > 0 && lastFailoverProvider !== null,
          fallbackChain,
        };
      } catch (rawErr) {
        const err =
          rawErr instanceof ProviderExecutionError
            ? rawErr
            : new ProviderExecutionError({
                providerId,
                errorClass: 'INTERNAL_ERROR',
                statusCode: 500,
                message: rawErr instanceof Error ? rawErr.message : String(rawErr),
                retryable: false,
                allowFallback: false,
              });

        attemptErr = err;

        // Hard configuration/request errors (401/403 bad key, 400 malformed, 404 bad model) -> NEVER silently fallback
        if (!err.allowFallback) {
          recordProviderError({
            workspaceId: req.workspaceId,
            providerId,
            taskType: req.taskType,
            errorClass: err.errorClass,
            statusCode: err.statusCode,
            message: err.message,
            authError: err.errorClass === 'AUTH_INVALID',
          });
          throw err;
        }

        // Transient 429/503/timeout: retry once in-process only if Retry-After is brief (<= 3s)
        const shouldRetrySameProvider =
          attempt < maxAttempts && err.retryable && (!err.retryAfterMs || err.retryAfterMs <= 3000);
        if (shouldRetrySameProvider) {
          const jitter = Math.floor(Math.random() * 250);
          const waitMs = Math.min(3000, err.retryAfterMs || 700 * attempt + jitter);
          await sleep(waitMs);
          continue;
        }
        break;
      }
    }

    if (attemptErr) {
      recordProviderError({
        workspaceId: req.workspaceId,
        providerId,
        taskType: req.taskType,
        errorClass: attemptErr.errorClass,
        statusCode: attemptErr.statusCode,
        message: attemptErr.message,
        cooldownMs: attemptErr.retryAfterMs || 20_000,
      });

      const cleanMsg = sanitizeDiagnosticMessage(attemptErr.message);
      fallbackChain.push({
        providerId,
        errorClass: attemptErr.errorClass,
        message: cleanMsg,
      });
      lastFailoverProvider = providerId;
      lastFailoverReason = `${attemptErr.errorClass}: ${cleanMsg}`;
    }
  }

  // All enabled/configured providers failed or budgets exhausted
  const summary = fallbackChain.map((f) => `${f.providerId}[${f.errorClass}]: ${f.message}`).join(' | ');
  throw new ProviderExecutionError({
    providerId: candidates[0] || 'gemini',
    errorClass: 'BUDGET_EXHAUSTED',
    statusCode: 503,
    message: `All eligible AI providers failed or reached quota limits for "${req.taskType}". ${summary}`,
    retryable: false,
    allowFallback: false,
  });
}

export async function testProviderConnection(
  workspaceId: BusinessWorkspaceId,
  providerId: AiProviderId
): Promise<{
  ok: boolean;
  providerId: AiProviderId;
  model: string;
  latencyMs: number;
  detail: string;
  catalogVerification?: { verifiedCount: number; source: string; error?: string };
}> {
  const adapter = ADAPTER_REGISTRY[providerId];
  const wsCfg = getWorkspaceAiConfig(workspaceId);
  const modelId = wsCfg.selectedModels[providerId];

  if (!adapter.isConfigured()) {
    return {
      ok: false,
      providerId,
      model: modelId,
      latencyMs: 0,
      detail: `Missing server-side secret(s): ${adapter.getMissingEnvVars().join(', ')}.`,
    };
  }

  const catalogVerification = await refreshLiveProviderCatalog(providerId);
  const spec = getValidatedModelsForProvider(providerId).find((m) => m.id === modelId);
  if (!spec) {
    return {
      ok: false,
      providerId,
      model: modelId,
      latencyMs: 0,
      detail: `Selected model "${modelId}" is not in the verified free-tier catalog.`,
      catalogVerification,
    };
  }

  try {
    const probe = await adapter.healthCheck(spec, Math.min(12_000, wsCfg.requestTimeoutMs));
    recordProviderSuccess({
      workspaceId,
      providerId,
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
      latencyMs: probe.latencyMs,
    });
    return {
      ok: probe.ok,
      providerId,
      model: spec.id,
      latencyMs: probe.latencyMs,
      detail: probe.detail,
      catalogVerification,
    };
  } catch (err) {
    const execErr =
      err instanceof ProviderExecutionError
        ? err
        : new ProviderExecutionError({
            providerId,
            errorClass: 'INTERNAL_ERROR',
            statusCode: 500,
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
            allowFallback: false,
          });
    recordProviderError({
      workspaceId,
      providerId,
      taskType: 'lightweight-summary',
      errorClass: execErr.errorClass,
      statusCode: execErr.statusCode,
      message: execErr.message,
      authError: execErr.errorClass === 'AUTH_INVALID',
    });
    return {
      ok: false,
      providerId,
      model: spec.id,
      latencyMs: 0,
      detail: sanitizeDiagnosticMessage(execErr.message),
      catalogVerification,
    };
  }
}

export function getProvidersDashboardSnapshot(): AiProvidersDashboardSnapshot {
  const store = loadQuotaStore();
  const providerIds: AiProviderId[] = ['gemini', 'groq', 'openrouter', 'cloudflare'];

  const providers: ProviderQuotaSummary[] = providerIds.map((pid) => {
    const adapter = ADAPTER_REGISTRY[pid];
    const meta = PROVIDER_META[pid];
    const gState = store.globalProviderState[pid];
    const configured = adapter.isConfigured();
    const { todayGlobalUsage, monthlyGlobalUsage } = getGlobalProviderBuckets(pid);

    const budgetPctRequests = Math.round(
      (todayGlobalUsage.requests / Math.max(1, gState.dailyRequestBudget)) * 100
    );
    const budgetPctTokens = Math.round(
      (todayGlobalUsage.totalTokens / Math.max(1, gState.dailyTokenBudget)) * 100
    );

    const cooldownActive = Boolean(gState.cooldownUntil && Date.parse(gState.cooldownUntil) > Date.now());
    const budgetExhausted =
      todayGlobalUsage.requests >= gState.dailyRequestBudget ||
      todayGlobalUsage.totalTokens >= gState.dailyTokenBudget;

    let availability: ProviderQuotaSummary['availability'] = 'available';
    if (!configured) availability = 'unconfigured';
    else if (gState.disabledManually) availability = 'disabled';
    else if (gState.authErrorLocked) availability = 'auth-error';
    else if (budgetExhausted) availability = 'budget-exhausted';
    else if (cooldownActive) availability = 'cooldown';

    return {
      providerId: pid,
      name: meta.name,
      roleLabel: meta.roleLabel,
      configured,
      missingEnvVars: adapter.getMissingEnvVars(),
      disabledManually: gState.disabledManually,
      availability,
      cooldownUntil: cooldownActive ? gState.cooldownUntil : undefined,
      lastCooldownReason: cooldownActive ? gState.lastCooldownReason : undefined,
      lastSuccessAt: gState.lastSuccessAt,
      lastCheckedAt: gState.lastCheckedAt,
      lastLatencyMs: gState.lastLatencyMs,
      dailyRequestBudget: gState.dailyRequestBudget,
      dailyTokenBudget: gState.dailyTokenBudget,
      todayGlobalUsage,
      monthlyGlobalUsage,
      budgetPctRequests,
      budgetPctTokens,
      warningTriggered: budgetPctRequests >= 80 || budgetPctTokens >= 80,
      validatedModels: getValidatedModelsForProvider(pid),
      lightweightRestricted: meta.lightweightRestricted,
    };
  });

  return {
    todayKey: new Date().toISOString().slice(0, 10),
    monthKey: new Date().toISOString().slice(0, 7),
    costProtectionPolicy: {
      paidModelsBlocked: true,
      cloudflareLightweightOnly: true,
      groundingLockedToGemini: true,
    },
    providers,
    workspaceConfigs: store.workspaceConfigs,
    workspaceUsage: {
      'ws-behind-the-release': getWorkspaceQuotaStatus('ws-behind-the-release'),
      'ws-74-studio-sales': getWorkspaceQuotaStatus('ws-74-studio-sales'),
    },
    recentErrors: store.recentErrors.slice(0, 30),
    recentFallbacks: store.recentFallbacks.slice(0, 30),
  };
}
