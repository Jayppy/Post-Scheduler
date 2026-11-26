import type { AiModelSpec, AiProviderId, AiTaskType } from '../../src/types/aiProviders';
import { getTaskComplexityTier, LIGHTWEIGHT_TASKS } from './types';

const ALL_STANDARD_TEXT_TASKS: AiTaskType[] = [
  'creative-copy',
  'carousel-structure',
  'reels-plan',
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
      notes: 'Primary provider for creative copy, marketing, sales intelligence, long-form & Google Search grounding.',
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
      notes: 'Dedicated audio transcription model for Reels & Shorts.',
    },
  ],
  groq: [
    {
      id: 'llama-3.3-70b-versatile',
      providerId: 'groq',
      label: 'Llama 3.3 70B Versatile (Groq Free Tier)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'High-quality 70B reasoning, structured JSON, and long-form fallback.',
    },
    {
      id: 'llama-3.1-8b-instant',
      providerId: 'groq',
      label: 'Llama 3.1 8B Instant (Groq Fast)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Low-latency Groq free-tier fallback for fast drafting and classification.',
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
      notes: 'Routes strictly across verified zero-cost OpenRouter models.',
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      providerId: 'openrouter',
      label: 'Llama 3.3 70B Instruct :free (OpenRouter)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      supportsStructuredJson: true,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Explicitly free-tier :free route on OpenRouter.',
    },
    {
      id: 'google/gemma-3-27b-it:free',
      providerId: 'openrouter',
      label: 'Gemma 3 27B IT :free (OpenRouter)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 96_000,
      maxOutputTokens: 8192,
      supportsStructuredJson: false,
      supportsStreaming: true,
      allowedTasks: ALL_STANDARD_TEXT_TASKS,
      notes: 'Free-tier general text route (best for prose/long-form streaming).',
    },
  ],
  cloudflare: [
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
      notes: 'Restricted strictly to classification, tagging, short summaries, and simple extraction.',
    },
    {
      id: '@cf/meta/llama-3.1-8b-instruct',
      providerId: 'cloudflare',
      label: 'Llama 3.1 8B Instruct (Lightweight Only)',
      freeTierVerified: true,
      paidModel: false,
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsStructuredJson: true,
      supportsStreaming: true,
      lightweightOnly: true,
      allowedTasks: LIGHTWEIGHT_ONLY_TASKS,
      notes: 'Restricted strictly to lightweight tasks.',
    },
  ],
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
      reason: `Model "${modelId}" is not in the verified free-tier catalog for "${providerId}". Unverified or paid models are blocked.`,
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
 * Live catalog check against Groq & OpenRouter model endpoints when API keys are present.
 * Strictly filters OpenRouter models to zero-cost ($0 prompt & $0 completion) routes only.
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
      dynamicModelCatalog.groq = BASELINE_MODELS.groq
        .filter((base) => {
          const hit = liveById.get(base.id);
          return !hit || hit.active !== false;
        })
        .map((base) => {
          const hit = liveById.get(base.id);
          return {
            ...base,
            contextWindow: hit?.context_window || base.contextWindow,
            maxOutputTokens: hit?.max_completion_tokens || base.maxOutputTokens,
            verifiedViaLiveCatalog: Boolean(hit),
            verifiedAt: hit ? nowIso : undefined,
          };
        });
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
          pricing?: { prompt?: string; completion?: string };
          top_provider?: { max_completion_tokens?: number | null };
          supported_parameters?: string[];
        }>;
      };
      const freeModels = (json.data || []).filter((m) => {
        const promptCost = Number(m.pricing?.prompt ?? '1');
        const completionCost = Number(m.pricing?.completion ?? '1');
        return Number.isFinite(promptCost) && Number.isFinite(completionCost) && promptCost === 0 && completionCost === 0;
      });

      const merged: AiModelSpec[] = [
        {
          ...BASELINE_MODELS.openrouter[0],
          verifiedViaLiveCatalog: true,
          verifiedAt: nowIso,
        },
      ];

      for (const m of freeModels.slice(0, 12)) {
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

  return { verifiedCount: (dynamicModelCatalog[providerId] || []).length, source: 'baseline-registry' };
}
