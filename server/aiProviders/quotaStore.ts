import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AiProviderId,
  AiTaskType,
  BusinessWorkspaceId,
  FallbackActivityEntry,
  SanitizedProviderError,
  UsageBucket,
  WorkspaceAiProfileConfig,
  WorkspaceQuotaStatus,
} from '../../src/types/aiProviders';
import { getDefaultModelForProvider, getValidatedModelsForProvider } from './modelRegistry';
import { sanitizeDiagnosticMessage } from './types';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_PATH = path.join(DATA_DIR, 'ai-provider-manager.json');

export interface GlobalProviderState {
  dailyRequestBudget: number;
  dailyTokenBudget: number;
  disabledManually: boolean;
  cooldownUntil?: string;
  lastCooldownReason?: string;
  lastSuccessAt?: string;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  authErrorLocked?: boolean;
}

interface QuotaStoreData {
  version: number;
  workspaceConfigs: Record<BusinessWorkspaceId, WorkspaceAiProfileConfig>;
  globalProviderState: Record<AiProviderId, GlobalProviderState>;
  // key: `${YYYY-MM-DD}::${workspaceId}::${providerId}` or `${YYYY-MM-DD}::global::${providerId}`
  dailyUsage: Record<string, UsageBucket>;
  // key: `${YYYY-MM}::${workspaceId}::${providerId}` or `${YYYY-MM}::global::${providerId}`
  monthlyUsage: Record<string, UsageBucket>;
  recentErrors: SanitizedProviderError[];
  recentFallbacks: FallbackActivityEntry[];
}

function emptyBucket(): UsageBucket {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    fallbacksTriggered: 0,
    errorsCount: 0,
  };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function buildDefaultWorkspaceConfig(workspaceId: BusinessWorkspaceId): WorkspaceAiProfileConfig {
  const nowIso = new Date().toISOString();
  const isSales = workspaceId === 'ws-74-studio-sales';
  return {
    workspaceId,
    workspaceLabel: isSales ? '74 STUDIO Sales Intelligence' : 'Behind The Release',
    // Cloudflare Workers AI remains disabled/optional by default until first 3 providers are verified
    providerOrder: ['gemini', 'groq', 'openrouter', 'cloudflare'],
    enabledProviders: {
      gemini: true,
      groq: true,
      openrouter: true,
      cloudflare: false,
    },
    selectedModels: {
      gemini: getDefaultModelForProvider('gemini'),
      groq: getDefaultModelForProvider('groq'),
      openrouter: getDefaultModelForProvider('openrouter'),
      cloudflare: getDefaultModelForProvider('cloudflare'),
    },
    taskRouting: isSales
      ? {
          'sales-lead-research': { preferredProvider: 'gemini', allowFallback: true },
          'sales-qualification': { preferredProvider: 'gemini', allowFallback: true },
          'sales-buyer-intent': { preferredProvider: 'gemini', allowFallback: true },
          'sales-proposal-longform': { preferredProvider: 'gemini', allowFallback: true },
          'lightweight-tagging': {
            preferredProvider: 'gemini',
            allowFallback: true,
            allowCloudflareLightweight: true,
          },
        }
      : {
          'grounded-search': { preferredProvider: 'gemini', allowFallback: false },
          'audio-transcribe': { preferredProvider: 'gemini', allowFallback: false },
          'long-form-article': { preferredProvider: 'gemini', allowFallback: true },
          'marketing-generate': { preferredProvider: 'gemini', allowFallback: true },
        },
    maxOutputTokens: 8192,
    requestTimeoutMs: 45_000,
    streamingEnabled: true,
    dailyRequestBudget: 250,
    dailyTokenBudget: 450_000,
    warningThresholdPct: 80,
    updatedAt: nowIso,
  };
}

function buildDefaultGlobalState(): Record<AiProviderId, GlobalProviderState> {
  return {
    gemini: { dailyRequestBudget: 400, dailyTokenBudget: 900_000, disabledManually: false },
    groq: { dailyRequestBudget: 350, dailyTokenBudget: 450_000, disabledManually: false },
    openrouter: { dailyRequestBudget: 45, dailyTokenBudget: 250_000, disabledManually: false },
    cloudflare: { dailyRequestBudget: 150, dailyTokenBudget: 150_000, disabledManually: false },
  };
}

function createInitialStore(): QuotaStoreData {
  return {
    version: 1,
    workspaceConfigs: {
      'ws-behind-the-release': buildDefaultWorkspaceConfig('ws-behind-the-release'),
      'ws-74-studio-sales': buildDefaultWorkspaceConfig('ws-74-studio-sales'),
    },
    globalProviderState: buildDefaultGlobalState(),
    dailyUsage: {},
    monthlyUsage: {},
    recentErrors: [],
    recentFallbacks: [],
  };
}

let cachedStore: QuotaStoreData | null = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadQuotaStore(): QuotaStoreData {
  if (cachedStore) return cachedStore;
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) {
    cachedStore = createInitialStore();
    saveQuotaStore(cachedStore);
    return cachedStore;
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<QuotaStoreData>;
    const defaults = createInitialStore();
    cachedStore = {
      version: 1,
      workspaceConfigs: {
        'ws-behind-the-release': {
          ...defaults.workspaceConfigs['ws-behind-the-release'],
          ...(parsed.workspaceConfigs?.['ws-behind-the-release'] || {}),
        },
        'ws-74-studio-sales': {
          ...defaults.workspaceConfigs['ws-74-studio-sales'],
          ...(parsed.workspaceConfigs?.['ws-74-studio-sales'] || {}),
        },
      },
      globalProviderState: {
        gemini: { ...defaults.globalProviderState.gemini, ...(parsed.globalProviderState?.gemini || {}) },
        groq: { ...defaults.globalProviderState.groq, ...(parsed.globalProviderState?.groq || {}) },
        openrouter: { ...defaults.globalProviderState.openrouter, ...(parsed.globalProviderState?.openrouter || {}) },
        cloudflare: { ...defaults.globalProviderState.cloudflare, ...(parsed.globalProviderState?.cloudflare || {}) },
      },
      dailyUsage: parsed.dailyUsage || {},
      monthlyUsage: parsed.monthlyUsage || {},
      recentErrors: Array.isArray(parsed.recentErrors) ? parsed.recentErrors.slice(0, 50) : [],
      recentFallbacks: Array.isArray(parsed.recentFallbacks) ? parsed.recentFallbacks.slice(0, 50) : [],
    };
    return cachedStore;
  } catch {
    cachedStore = createInitialStore();
    saveQuotaStore(cachedStore);
    return cachedStore;
  }
}

export function saveQuotaStore(store: QuotaStoreData): void {
  ensureDir();
  cachedStore = store;
  const tmpPath = `${STORE_PATH}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

export function getWorkspaceAiConfig(workspaceId: BusinessWorkspaceId): WorkspaceAiProfileConfig {
  const store = loadQuotaStore();
  return store.workspaceConfigs[workspaceId];
}

export function updateWorkspaceAiConfig(
  workspaceId: BusinessWorkspaceId,
  patch: Partial<WorkspaceAiProfileConfig>
): WorkspaceAiProfileConfig {
  const store = loadQuotaStore();
  const current = store.workspaceConfigs[workspaceId];
  const validProviders: AiProviderId[] = ['gemini', 'groq', 'openrouter', 'cloudflare'];

  const nextOrder = Array.isArray(patch.providerOrder)
    ? Array.from(new Set(patch.providerOrder.filter((p): p is AiProviderId => validProviders.includes(p))))
    : current.providerOrder;
  for (const p of validProviders) {
    if (!nextOrder.includes(p)) nextOrder.push(p);
  }

  const nextSelectedModels = { ...current.selectedModels };
  if (patch.selectedModels) {
    for (const pid of validProviders) {
      const candidate = patch.selectedModels[pid];
      if (candidate) {
        const validated = getValidatedModelsForProvider(pid).some((m) => m.id === candidate && !m.paidModel);
        if (!validated) {
          throw new Error(
            `Model "${candidate}" is not in the verified free-tier catalog for "${pid}". Paid or unverified models cannot be selected.`
          );
        }
        nextSelectedModels[pid] = candidate;
      }
    }
  }

  const next: WorkspaceAiProfileConfig = {
    ...current,
    providerOrder: nextOrder,
    enabledProviders: {
      ...current.enabledProviders,
      ...(patch.enabledProviders || {}),
    },
    selectedModels: nextSelectedModels,
    taskRouting: patch.taskRouting ? { ...current.taskRouting, ...patch.taskRouting } : current.taskRouting,
    maxOutputTokens: Math.max(512, Math.min(32768, Number(patch.maxOutputTokens ?? current.maxOutputTokens))),
    requestTimeoutMs: Math.max(3000, Math.min(120000, Number(patch.requestTimeoutMs ?? current.requestTimeoutMs))),
    streamingEnabled:
      typeof patch.streamingEnabled === 'boolean' ? patch.streamingEnabled : current.streamingEnabled,
    dailyRequestBudget: Math.max(
      1,
      Math.min(10_000, Number(patch.dailyRequestBudget ?? current.dailyRequestBudget))
    ),
    dailyTokenBudget: Math.max(
      1_000,
      Math.min(10_000_000, Number(patch.dailyTokenBudget ?? current.dailyTokenBudget))
    ),
    warningThresholdPct: Math.max(
      50,
      Math.min(99, Number(patch.warningThresholdPct ?? current.warningThresholdPct))
    ),
    updatedAt: new Date().toISOString(),
  };

  store.workspaceConfigs[workspaceId] = next;
  saveQuotaStore(store);
  return next;
}

export function updateGlobalProviderPolicy(
  providerId: AiProviderId,
  patch: Partial<Pick<GlobalProviderState, 'disabledManually' | 'dailyRequestBudget' | 'dailyTokenBudget'>> & {
    clearCooldown?: boolean;
  }
): GlobalProviderState {
  const store = loadQuotaStore();
  const cur = store.globalProviderState[providerId];
  const next: GlobalProviderState = {
    ...cur,
    disabledManually:
      typeof patch.disabledManually === 'boolean' ? patch.disabledManually : cur.disabledManually,
    dailyRequestBudget: Math.max(
      1,
      Math.min(50_000, Number(patch.dailyRequestBudget ?? cur.dailyRequestBudget))
    ),
    dailyTokenBudget: Math.max(
      1_000,
      Math.min(50_000_000, Number(patch.dailyTokenBudget ?? cur.dailyTokenBudget))
    ),
  };
  if (patch.clearCooldown) {
    delete next.cooldownUntil;
    delete next.lastCooldownReason;
    next.authErrorLocked = false;
  }
  store.globalProviderState[providerId] = next;
  saveQuotaStore(store);
  return next;
}

export function checkQuotaAndAvailability(
  workspaceId: BusinessWorkspaceId,
  providerId: AiProviderId
): { ok: true } | { ok: false; reason: string; code: 'PROVIDER_DISABLED' | 'BUDGET_EXHAUSTED' | 'COOLDOWN' } {
  const store = loadQuotaStore();
  const wsCfg = store.workspaceConfigs[workspaceId];
  const gState = store.globalProviderState[providerId];

  if (gState.disabledManually) {
    return {
      ok: false,
      code: 'PROVIDER_DISABLED',
      reason: `Provider "${providerId}" is manually disabled globally in the AI Provider Console.`,
    };
  }
  if (!wsCfg.enabledProviders[providerId]) {
    return {
      ok: false,
      code: 'PROVIDER_DISABLED',
      reason: `Provider "${providerId}" is disabled for workspace "${wsCfg.workspaceLabel}".`,
    };
  }
  if (gState.cooldownUntil && Date.parse(gState.cooldownUntil) > Date.now()) {
    return {
      ok: false,
      code: 'COOLDOWN',
      reason: `Provider "${providerId}" is in rate-limit cooldown until ${gState.cooldownUntil} (${gState.lastCooldownReason || 'rate limit'}).`,
    };
  }

  const d = todayKey();
  const globalDaily = store.dailyUsage[`${d}::global::${providerId}`] || emptyBucket();
  if (globalDaily.requests >= gState.dailyRequestBudget) {
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      reason: `Global daily request budget (${gState.dailyRequestBudget}) reached for "${providerId}".`,
    };
  }
  if (globalDaily.totalTokens >= gState.dailyTokenBudget) {
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      reason: `Global daily token budget (${gState.dailyTokenBudget}) reached for "${providerId}".`,
    };
  }

  // Per-workspace isolation budget (sum across providers for this workspace today)
  const wsUsage = getWorkspaceDailyUsage(workspaceId);
  if (wsUsage.requests >= wsCfg.dailyRequestBudget) {
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      reason: `Workspace daily request budget (${wsCfg.dailyRequestBudget}) reached for "${wsCfg.workspaceLabel}". Other workspaces remain protected.`,
    };
  }
  if (wsUsage.totalTokens >= wsCfg.dailyTokenBudget) {
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      reason: `Workspace daily token budget (${wsCfg.dailyTokenBudget}) reached for "${wsCfg.workspaceLabel}". Other workspaces remain protected.`,
    };
  }

  return { ok: true };
}

function addToBucket(
  map: Record<string, UsageBucket>,
  key: string,
  delta: Partial<UsageBucket>
) {
  const cur = map[key] || emptyBucket();
  map[key] = {
    requests: cur.requests + (delta.requests || 0),
    inputTokens: cur.inputTokens + (delta.inputTokens || 0),
    outputTokens: cur.outputTokens + (delta.outputTokens || 0),
    totalTokens: cur.totalTokens + (delta.totalTokens || 0),
    fallbacksTriggered: cur.fallbacksTriggered + (delta.fallbacksTriggered || 0),
    errorsCount: cur.errorsCount + (delta.errorsCount || 0),
  };
}

export function recordProviderSuccess(opts: {
  workspaceId: BusinessWorkspaceId;
  providerId: AiProviderId;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}): void {
  const store = loadQuotaStore();
  const d = todayKey();
  const m = monthKey();
  const delta: Partial<UsageBucket> = {
    requests: 1,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    totalTokens: opts.totalTokens,
  };

  addToBucket(store.dailyUsage, `${d}::${opts.workspaceId}::${opts.providerId}`, delta);
  addToBucket(store.dailyUsage, `${d}::global::${opts.providerId}`, delta);
  addToBucket(store.monthlyUsage, `${m}::${opts.workspaceId}::${opts.providerId}`, delta);
  addToBucket(store.monthlyUsage, `${m}::global::${opts.providerId}`, delta);

  const nowIso = new Date().toISOString();
  store.globalProviderState[opts.providerId] = {
    ...store.globalProviderState[opts.providerId],
    lastSuccessAt: nowIso,
    lastCheckedAt: nowIso,
    lastLatencyMs: opts.latencyMs,
    authErrorLocked: false,
    cooldownUntil: undefined,
    lastCooldownReason: undefined,
  };

  saveQuotaStore(store);
}

export function recordProviderError(opts: {
  workspaceId: BusinessWorkspaceId;
  providerId: AiProviderId;
  taskType: AiTaskType;
  errorClass: string;
  statusCode?: number;
  message: string;
  cooldownMs?: number;
  authError?: boolean;
}): void {
  const store = loadQuotaStore();
  const d = todayKey();
  const m = monthKey();
  const delta: Partial<UsageBucket> = { errorsCount: 1 };

  addToBucket(store.dailyUsage, `${d}::${opts.workspaceId}::${opts.providerId}`, delta);
  addToBucket(store.dailyUsage, `${d}::global::${opts.providerId}`, delta);
  addToBucket(store.monthlyUsage, `${m}::${opts.workspaceId}::${opts.providerId}`, delta);
  addToBucket(store.monthlyUsage, `${m}::global::${opts.providerId}`, delta);

  const nowIso = new Date().toISOString();
  const sanitizedMsg = sanitizeDiagnosticMessage(opts.message);

  const prev = store.globalProviderState[opts.providerId];
  store.globalProviderState[opts.providerId] = {
    ...prev,
    lastCheckedAt: nowIso,
    authErrorLocked: opts.authError ? true : prev.authErrorLocked,
    cooldownUntil:
      opts.cooldownMs && opts.cooldownMs > 0
        ? new Date(Date.now() + opts.cooldownMs).toISOString()
        : prev.cooldownUntil,
    lastCooldownReason:
      opts.cooldownMs && opts.cooldownMs > 0 ? `${opts.errorClass}: ${sanitizedMsg.slice(0, 120)}` : prev.lastCooldownReason,
  };

  store.recentErrors.unshift({
    id: `err-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    workspaceId: opts.workspaceId,
    providerId: opts.providerId,
    taskType: opts.taskType,
    errorClass: opts.errorClass,
    statusCode: opts.statusCode,
    message: sanitizedMsg,
    occurredAt: nowIso,
  });
  store.recentErrors = store.recentErrors.slice(0, 50);

  saveQuotaStore(store);
}

export function recordProviderFallback(opts: {
  workspaceId: BusinessWorkspaceId;
  taskType: AiTaskType;
  fromProvider: AiProviderId;
  toProvider: AiProviderId;
  reason: string;
}): void {
  const store = loadQuotaStore();
  const d = todayKey();
  const m = monthKey();
  const delta: Partial<UsageBucket> = { fallbacksTriggered: 1 };

  addToBucket(store.dailyUsage, `${d}::${opts.workspaceId}::${opts.fromProvider}`, delta);
  addToBucket(store.dailyUsage, `${d}::global::${opts.fromProvider}`, delta);
  addToBucket(store.monthlyUsage, `${m}::${opts.workspaceId}::${opts.fromProvider}`, delta);
  addToBucket(store.monthlyUsage, `${m}::global::${opts.fromProvider}`, delta);

  store.recentFallbacks.unshift({
    id: `fb-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    workspaceId: opts.workspaceId,
    taskType: opts.taskType,
    fromProvider: opts.fromProvider,
    toProvider: opts.toProvider,
    reason: sanitizeDiagnosticMessage(opts.reason),
    occurredAt: new Date().toISOString(),
  });
  store.recentFallbacks = store.recentFallbacks.slice(0, 50);

  saveQuotaStore(store);
}

export function getWorkspaceDailyUsage(workspaceId: BusinessWorkspaceId): UsageBucket {
  const store = loadQuotaStore();
  const d = todayKey();
  const providers: AiProviderId[] = ['gemini', 'groq', 'openrouter', 'cloudflare'];
  return providers.reduce<UsageBucket>((acc, pid) => {
    const b = store.dailyUsage[`${d}::${workspaceId}::${pid}`];
    if (!b) return acc;
    return {
      requests: acc.requests + b.requests,
      inputTokens: acc.inputTokens + b.inputTokens,
      outputTokens: acc.outputTokens + b.outputTokens,
      totalTokens: acc.totalTokens + b.totalTokens,
      fallbacksTriggered: acc.fallbacksTriggered + b.fallbacksTriggered,
      errorsCount: acc.errorsCount + b.errorsCount,
    };
  }, emptyBucket());
}

export function getWorkspaceMonthlyUsage(workspaceId: BusinessWorkspaceId): UsageBucket {
  const store = loadQuotaStore();
  const m = monthKey();
  const providers: AiProviderId[] = ['gemini', 'groq', 'openrouter', 'cloudflare'];
  return providers.reduce<UsageBucket>((acc, pid) => {
    const b = store.monthlyUsage[`${m}::${workspaceId}::${pid}`];
    if (!b) return acc;
    return {
      requests: acc.requests + b.requests,
      inputTokens: acc.inputTokens + b.inputTokens,
      outputTokens: acc.outputTokens + b.outputTokens,
      totalTokens: acc.totalTokens + b.totalTokens,
      fallbacksTriggered: acc.fallbacksTriggered + b.fallbacksTriggered,
      errorsCount: acc.errorsCount + b.errorsCount,
    };
  }, emptyBucket());
}

export function getWorkspaceQuotaStatus(workspaceId: BusinessWorkspaceId): WorkspaceQuotaStatus {
  const cfg = getWorkspaceAiConfig(workspaceId);
  const todayUsage = getWorkspaceDailyUsage(workspaceId);
  const monthlyUsage = getWorkspaceMonthlyUsage(workspaceId);
  const requestPct = Math.round((todayUsage.requests / Math.max(1, cfg.dailyRequestBudget)) * 100);
  const tokenPct = Math.round((todayUsage.totalTokens / Math.max(1, cfg.dailyTokenBudget)) * 100);
  const exhausted = todayUsage.requests >= cfg.dailyRequestBudget || todayUsage.totalTokens >= cfg.dailyTokenBudget;
  const warningTriggered = requestPct >= cfg.warningThresholdPct || tokenPct >= cfg.warningThresholdPct;
  return {
    workspaceId,
    todayUsage,
    monthlyUsage,
    dailyRequestBudget: cfg.dailyRequestBudget,
    dailyTokenBudget: cfg.dailyTokenBudget,
    warningThresholdPct: cfg.warningThresholdPct,
    requestPct,
    tokenPct,
    warningTriggered,
    exhausted,
  };
}

export function getGlobalProviderBuckets(providerId: AiProviderId): {
  todayGlobalUsage: UsageBucket;
  monthlyGlobalUsage: UsageBucket;
} {
  const store = loadQuotaStore();
  return {
    todayGlobalUsage: store.dailyUsage[`${todayKey()}::global::${providerId}`] || emptyBucket(),
    monthlyGlobalUsage: store.monthlyUsage[`${monthKey()}::global::${providerId}`] || emptyBucket(),
  };
}

export function resetWorkspaceUsageCounters(workspaceId: BusinessWorkspaceId): void {
  const store = loadQuotaStore();
  const d = todayKey();
  const providers: AiProviderId[] = ['gemini', 'groq', 'openrouter', 'cloudflare'];
  for (const pid of providers) {
    delete store.dailyUsage[`${d}::${workspaceId}::${pid}`];
  }
  store.recentErrors = store.recentErrors.filter((e) => e.workspaceId !== workspaceId);
  store.recentFallbacks = store.recentFallbacks.filter((f) => f.workspaceId !== workspaceId);
  saveQuotaStore(store);
}
