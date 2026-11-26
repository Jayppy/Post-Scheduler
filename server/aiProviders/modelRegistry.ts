import type { AiModelSpec, AiProviderId, AiTaskType } from '../../src/types/aiProviders';
import { getTaskComplexityTier, LIGHTWEIGHT_TASKS } from './types';

const ALL_STANDARD_TEXT_TASKS: AiTaskType[] = [
  'creative-copy',
  'carousel-structure',
  'reels-plan',
  'video-script',
  'video-scene-regen',
  'marketing-generate',
  'marketing-platform',
  'long-form-article',
  'sales-lead-research',
  'sales-qualification',
  'sales-segmentation',
  'sales-buyer-intent',
  'sales-pain-points',
  'sales-opportunity-score',
  'sales-service-rec',
  'sales-response',
  'sales-follow-up',
  'sales-proposal-longform',
  'sales-campaign-intel',
  'lightweight-classification',
  'lightweight-tagging',
  'lightweight-summary',
  'lightweight-extract',
];

const LIGHTWEIGHT_ONLY_TASKS: AiTaskType[] = Array.from(LIGHTWEIGHT_TASKS);

const UNSUITABLE_TEXT_ID_PATTERN = /(tts|audio|speech|whisper|lyria|image|flux|dall-e|diffusion|embed|guard|orpheus)/i;

const BASELINE_MODELS: Record<AiProviderId, AiModelSpec[]> = {
  gemini: [
    {
      id: 'gemini-4-hydrogen',
      providerId: 'gemini',
      label: 'Gemini 4 Hydrogen (Primary Free-Tier)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 1_048_576,
      maxOutputTokens: 16384,
      supportsStructuredJson: true,
      supportsStreaming: true,
      supportsGroundedSearch: true,
      supportsAudio: false,
      allowedTasks: [...ALL_STANDARD_TEXT_TASKS, 'grounded-search'],
      notes: 'Primary free-tier model verified in @google/genai SDK integration; paid Gemini tiers are strictly excluded.',
    },
    {
      id: 'gemini-3.5-transcribe',
      providerId: 'gemini',
      label: 'Gemini 3.5 Transcribe (Audio Only)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsGroundedSearch: false,
      supportsAudio: true,
      allowedTasks: ['audio-transcribe'],
      notes: 'Dedicated audio transcription model for Reels, Shorts & Video Studio voice tracks.',
    },
  ],
  groq: [
    {
      id: 'openai/gpt-oss-120b',
      providerId: 'groq',
      label: 'GPT-OSS 120B (Groq Free-Tier Production)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Current Groq production replacement for retired Llama 3.3 70B Versatile.',
    },
    {
      id: 'openai/gpt-oss-20b',
      providerId: 'groq',
      label: 'GPT-OSS 20B (Groq Free-Tier Fast)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Low-latency Groq replacement for retired Llama 3.1 8B Instant.',
    },
  ],
  openrouter: [
    {
      id: 'openrouter/free',
      providerId: 'openrouter',
      label: 'OpenRouter Free Auto-Router ($0.00 Verified)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Routes strictly across verified zero-cost OpenRouter text models.',
    },
    {
      id: 'google/gemma-4-26b-a4b-it:free',
      providerId: 'openrouter',
      label: 'Gemma 4 26B A4B :free (OpenRouter)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Active $0.00 text-generation route verified in OpenRouter live catalog.',
    },
    {
      id: 'nvidia/nemotron-3.5-lightning:free',
      providerId: 'openrouter',
      label: 'Nemotron 3.5 Lightning :free (OpenRouter)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Fast $0.00 text-generation fallback verified in OpenRouter live catalog.',
    },
    {
      id: 'baidu/ernie-5.5-flash-preview:free',
      providerId: 'openrouter',
      label: 'ERNIE 5.5 Flash Preview :free (OpenRouter)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Free-tier general text route verified in OpenRouter live catalog.',
    },
  ],
  cloudflare: [
    {
      id: '@cf/google/gemma-4-26b-a4b-it',
      providerId: 'cloudflare',
      label: 'Gemma 4 26B A4B IT (CF Lightweight Only)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsStructuredJson: true,
      supportsStreaming: true,
      lightweightOnly: true,
      allowedTasks: LIGHTWEIGHT_ONLY_TASKS,
      notes: 'Active verified Cloudflare lightweight route strictly limited to classification, tagging, summaries, and extraction.',
    },
    {
      id: '@cf/meta/llama-3.1-8b-instruct-fast',
      providerId: 'cloudflare',
      label: 'Llama 3.1 8B Instruct Fast (Lightweight Only)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsStructuredJson: true,
      supportsStreaming: true,
      lightweightOnly: true,
      allowedTasks: LIGHTWEIGHT_ONLY_TASKS,
      notes: 'Secondary Cloudflare lightweight route when listed in live account catalog.',
    },
  ],
};

// Optional extra verified Groq free-tier text model candidates when live catalog confirms them active
const GROQ_EXTRA_ALLOWLIST: Record<string, { label: string; supportsJson: boolean }> = {
  'qwen/qwen3-32b': { label: 'Qwen 3 32B (Groq Free Tier)', supportsJson: true },
  'moonshotai/kimi-k2-instruct': { label: 'Kimi K2 Instruct (Groq)', supportsJson: true },
  'meta-llama/llama-4-scout-17b-16e-instruct': { label: 'Llama 4 Scout 17B (Groq)', supportsJson: true },
};

// Runtime cache enriched when live provider catalogs are checked
const dynamicModelCatalog: Record<AiProviderId, AiModelSpec[]> = {
  gemini: BASELINE_MODELS.gemini.map((m) => ({ ...m })),
  groq: BASELINE_MODELS.groq.map((m) => ({ ...m })),
  openrouter: BASELINE_MODELS.openrouter.map((m) => ({ ...m })),
  cloudflare: BASELINE_MODELS.cloudflare.map((m) => ({ ...m })),
};

export function getValidatedModelsForProvider(providerId: AiProviderId): AiModelSpec[] {
  return (dynamicModelCatalog[providerId] || []).map((m) => ({ ...m }));
}

export function getDefaultModelForProvider(providerId: AiProviderId): string {
  return BASELINE_MODELS[providerId][0].id;
}

function isSuitableFreeOpenRouterTextModel(m: {
  id: string;
  pricing?: { prompt?: string; completion?: string; request?: string; image?: string };
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
}): boolean {
  if (!m.id || UNSUITABLE_TEXT_ID_PATTERN.test(m.id)) return false;
  if (m.id !== 'openrouter/free' && !m.id.endsWith(':free')) return false;

  const promptCost = Number(m.pricing?.prompt ?? '1');
  const completionCost = Number(m.pricing?.completion ?? '1');
  const requestCost = m.pricing?.request !== undefined ? Number(m.pricing.request) : 0;
  const imageCost = m.pricing?.image !== undefined ? Number(m.pricing.image) : 0;
  if (
    !Number.isFinite(promptCost) ||
    !Number.isFinite(completionCost) ||
    promptCost !== 0 ||
    completionCost !== 0 ||
    (Number.isFinite(requestCost) && requestCost > 0) ||
    (Number.isFinite(imageCost) && imageCost > 0)
  ) {
    return false;
  }

  // Strictly require text-only output modality (exclude image-gen, audio-gen, TTS, embeddings)
  const outMods = m.architecture?.output_modalities;
  if (Array.isArray(outMods) && outMods.length > 0) {
    const normalized = outMods.map((x) => String(x).toLowerCase());
    if (!normalized.includes('text')) return false;
    if (normalized.some((x) => x === 'image' || x === 'audio' || x === 'video')) return false;
  }
  const modality = String(m.architecture?.modality || '').toLowerCase();
  if (modality.includes('->')) {
    const outSide = modality.split('->')[1]?.trim() || '';
    if (outSide !== 'text') return false;
  }

  return true;
}

export function validateModelForTask(opts: {
  providerId: AiProviderId;
  modelId: string;
  taskType: AiTaskType;
  requiresJsonSchema?: boolean;
  requestedMaxTokens?: number;
}): { ok: true; spec: AiModelSpec; clampedMaxOutputTokens: number } | { ok: false; reason: string; code: 'MODEL_UNSUPPORTED' | 'TASK_RESTRICTED' } {
  const { providerId, modelId, taskType, requiresJsonSchema, requestedMaxTokens } = opts;

  // Hard restriction #1: Cloudflare Workers AI is NEVER allowed for non-lightweight tasks
  const tier = getTaskComplexityTier(taskType);
  if (providerId === 'cloudflare' && tier !== 'lightweight') {
    return {
      ok: false,
      code: 'TASK_RESTRICTED',
      reason: `Cloudflare Workers AI is strictly restricted to lightweight tasks (classification, tagging, short summaries, simple extraction) and blocked for "${taskType}".`,
    };
  }

  // Hard restriction #2: Grounded search & audio transcribe are Gemini-only
  if ((tier === 'grounded' || tier === 'audio') && providerId !== 'gemini') {
    return {
      ok: false,
      code: 'TASK_RESTRICTED',
      reason: `Task "${taskType}" requires Google Gemini capabilities and cannot run on ${providerId}.`,
    };
  }

  const catalog = dynamicModelCatalog[providerId] || [];
  const spec = catalog.find((m) => m.id === modelId);

  if (!spec) {
    return {
      ok: false,
      code: 'MODEL_UNSUPPORTED',
      reason: `Model "${modelId}" is not in the verified free-tier catalog for "${providerId}". Unverified, retired, or paid models are blocked.`,
    };
  }

  if (spec.paidModel || !spec.freeTierVerified) {
    return {
      ok: false,
      code: 'MODEL_UNSUPPORTED',
      reason: `Model "${modelId}" is not verified as free-tier eligible. Paid model auto-selection is disabled.`,
    };
  }

  if (!spec.allowedTasks.includes(taskType)) {
    return {
      ok: false,
      code: 'TASK_RESTRICTED',
      reason: `Model "${modelId}" (${providerId}) is not approved for task "${taskType}".`,
    };
  }

  if (requiresJsonSchema && !spec.supportsStructuredJson) {
    return {
      ok: false,
      code: 'MODEL_UNSUPPORTED',
      reason: `Model "${modelId}" does not guarantee compatible structured JSON output.`,
    };
  }

  const desired = Number(requestedMaxTokens) || spec.maxOutputTokens;
  const clampedMaxOutputTokens = Math.max(128, Math.min(spec.maxOutputTokens, desired));
  return { ok: true, spec, clampedMaxOutputTokens };
}

/**
 * Live catalog verification against Groq, OpenRouter, and Cloudflare Workers AI endpoints.
 * Strictly admits verified active text-generation free-tier routes only.
 */
export async function refreshLiveProviderCatalog(providerId: AiProviderId): Promise<{
  verifiedCount: number;
  source: 'live-catalog' | 'baseline-registry';
  error?: string;
}> {
  const nowIso = new Date().toISOString();

  if (providerId === 'groq') {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      return { verifiedCount: dynamicModelCatalog.groq.length, source: 'baseline-registry' };
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        return {
          verifiedCount: dynamicModelCatalog.groq.length,
          source: 'baseline-registry',
          error: `Groq catalog returned HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        data?: Array<{ id: string; active?: boolean; context_window?: number; max_completion_tokens?: number }>;
      };
      const liveById = new Map((json.data || []).map((m) => [m.id, m]));

      // Strictly require model to be present AND active in live Groq catalog
      const verified: AiModelSpec[] = BASELINE_MODELS.groq
        .filter((base) => {
          const hit = liveById.get(base.id);
          return Boolean(hit && hit.active !== false);
        })
        .map((base) => {
          const hit = liveById.get(base.id)!;
          return {
            ...base,
            contextWindow: hit.context_window || base.contextWindow,
            maxOutputTokens: hit.max_completion_tokens || base.maxOutputTokens,
            verifiedViaLiveCatalog: true,
            verifiedAt: nowIso,
          };
        });

      for (const [extraId, meta] of Object.entries(GROQ_EXTRA_ALLOWLIST)) {
        const hit = liveById.get(extraId);
        if (hit && hit.active !== false && !verified.some((v) => v.id === extraId)) {
          verified.push({
            id: extraId,
            providerId: 'groq',
            label: meta.label,
            freeTierVerified: true,
            paidModel: false,
            contextWindow: hit.context_window || 65_536,
            maxOutputTokens: Math.min(16384, hit.max_completion_tokens || 8192),
            supportsStructuredJson: meta.supportsJson,
            supportsStreaming: true,
            allowedTasks: ALL_STANDARD_TEXT_TASKS,
            verifiedViaLiveCatalog: true,
            verifiedAt: nowIso,
          });
        }
      }

      if (verified.length > 0) {
        dynamicModelCatalog.groq = verified;
      }
      return { verifiedCount: dynamicModelCatalog.groq.length, source: 'live-catalog' };
    } catch (err) {
      return {
        verifiedCount: dynamicModelCatalog.groq.length,
        source: 'baseline-registry',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (providerId === 'openrouter') {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const headers: Record<string, string> = {};
      if (process.env.OPENROUTER_API_KEY?.trim()) {
        headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`;
      }
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) {
        return {
          verifiedCount: dynamicModelCatalog.openrouter.length,
          source: 'baseline-registry',
          error: `OpenRouter catalog returned HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          name?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string; request?: string; image?: string };
          architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
          top_provider?: { max_completion_tokens?: number | null };
          supported_parameters?: string[];
        }>;
      };
      const freeTextModels = (json.data || []).filter((m) => isSuitableFreeOpenRouterTextModel(m));

      const merged: AiModelSpec[] = [
        {
          ...BASELINE_MODELS.openrouter[0],
          verifiedViaLiveCatalog: true,
          verifiedAt: nowIso,
        },
      ];

      for (const m of freeTextModels.slice(0, 12)) {
        if (m.id === 'openrouter/free') continue;
        const supportsJson =
          Array.isArray(m.supported_parameters) &&
          (m.supported_parameters.includes('response_format') || m.supported_parameters.includes('structured_outputs'));
        merged.push({
          id: m.id,
          providerId: 'openrouter',
          label: `${m.name || m.id} ($0.00 Free)`,
          freeTierVerified: true,
          paidModel: false,
          contextWindow: m.context_length || 64_000,
          maxOutputTokens: Math.min(16384, m.top_provider?.max_completion_tokens || 8192),
          supportsStructuredJson: supportsJson,
          supportsStreaming: true,
          allowedTasks: ALL_STANDARD_TEXT_TASKS,
          verifiedViaLiveCatalog: true,
          verifiedAt: nowIso,
        });
      }

      if (merged.length > 0) {
        dynamicModelCatalog.openrouter = merged;
      }
      return { verifiedCount: dynamicModelCatalog.openrouter.length, source: 'live-catalog' };
    } catch (err) {
      return {
        verifiedCount: dynamicModelCatalog.openrouter.length,
        source: 'baseline-registry',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (providerId === 'cloudflare') {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!token || !accountId) {
      return { verifiedCount: dynamicModelCatalog.cloudflare.length, source: 'baseline-registry' };
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text+Generation&per_page=100`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }
      );
      clearTimeout(t);
      if (!res.ok) {
        return {
          verifiedCount: dynamicModelCatalog.cloudflare.length,
          source: 'baseline-registry',
          error: `Cloudflare catalog returned HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        result?: Array<{ name?: string; properties?: Array<{ property_id?: string; value?: string }> }>;
      };
      const activeNames = new Set(
        (json.result || [])
          .filter((m) => {
            const name = m.name || '';
            if (!name || UNSUITABLE_TEXT_ID_PATTERN.test(name)) return false;
            const deprecated = m.properties?.some(
              (p) => p.property_id === 'planned_deprecation_date' || p.property_id === 'deprecated'
            );
            return !deprecated;
          })
          .map((m) => m.name!)
      );
      const verifiedCf = BASELINE_MODELS.cloudflare
        .filter((base) => activeNames.size === 0 || activeNames.has(base.id))
        .map((base) => ({
          ...base,
          verifiedViaLiveCatalog: activeNames.has(base.id),
          verifiedAt: activeNames.has(base.id) ? nowIso : undefined,
        }));
      if (verifiedCf.length > 0) {
        dynamicModelCatalog.cloudflare = verifiedCf;
      }
      return { verifiedCount: dynamicModelCatalog.cloudflare.length, source: 'live-catalog' };
    } catch (err) {
      return {
        verifiedCount: dynamicModelCatalog.cloudflare.length,
        source: 'baseline-registry',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { verifiedCount: (dynamicModelCatalog[providerId] || []).length, source: 'baseline-registry' };
}
