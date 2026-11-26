import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AiModelSpec, AiProviderId } from '../../src/types/aiProviders';
import {
  type AiProviderAdapter,
  type NormalizedUsage,
  type ProviderAdapterCallOptions,
  type ProviderAdapterResult,
  ProviderExecutionError,
  sanitizeDiagnosticMessage,
} from './types';

function parseRetryAfterMs(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(300_000, Math.max(500, Math.round(asSeconds * 1000)));
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) return Math.min(300_000, delta);
  }
  return undefined;
}

function classifyHttpFailure(
  providerId: AiProviderId,
  status: number,
  bodyText: string,
  retryAfterMs?: number
): ProviderExecutionError {
  const clean = sanitizeDiagnosticMessage(bodyText || `HTTP ${status}`);
  const lower = clean.toLowerCase();

  if (status === 401 || status === 403 || lower.includes('invalid api key') || lower.includes('api_key_invalid')) {
    return new ProviderExecutionError({
      providerId,
      errorClass: 'AUTH_INVALID',
      statusCode: status,
      message: `${providerId} authentication failed (${status}): verify server-side secret configuration.`,
      retryable: false,
      allowFallback: false, // Never silently mask bad API keys
    });
  }

  if (status === 400 || status === 422) {
    return new ProviderExecutionError({
      providerId,
      errorClass: 'BAD_REQUEST',
      statusCode: status,
      message: `${providerId} rejected malformed request (${status}): ${clean}`,
      retryable: false,
      allowFallback: false,
    });
  }

  if (status === 404 || lower.includes('model_not_found') || lower.includes('does not exist')) {
    return new ProviderExecutionError({
      providerId,
      errorClass: 'MODEL_UNSUPPORTED',
      statusCode: status,
      message: `${providerId} reported unsupported or unavailable model (${status}): ${clean}`,
      retryable: false,
      allowFallback: false,
    });
  }

  if (status === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    const isQuota = lower.includes('quota') || lower.includes('resource_exhausted') || lower.includes('daily');
    return new ProviderExecutionError({
      providerId,
      errorClass: isQuota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED',
      statusCode: 429,
      message: `${providerId} rate limit or quota reached (429): ${clean}`,
      retryable: true,
      allowFallback: true,
      retryAfterMs: retryAfterMs || (isQuota ? 60_000 : 15_000),
    });
  }

  if (status >= 500 || status === 408) {
    return new ProviderExecutionError({
      providerId,
      errorClass: 'UPSTREAM_UNAVAILABLE',
      statusCode: status,
      message: `${providerId} temporary upstream unavailability (${status}): ${clean}`,
      retryable: true,
      allowFallback: true,
      retryAfterMs: 10_000,
    });
  }

  return new ProviderExecutionError({
    providerId,
    errorClass: 'INTERNAL_ERROR',
    statusCode: status || 500,
    message: `${providerId} request failed (${status}): ${clean}`,
    retryable: false,
    allowFallback: false,
  });
}

function classifyThrownError(providerId: AiProviderId, err: unknown): ProviderExecutionError {
  if (err instanceof ProviderExecutionError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    (err instanceof Error && err.name === 'AbortError') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout')
  ) {
    return new ProviderExecutionError({
      providerId,
      errorClass: 'TIMEOUT',
      statusCode: 504,
      message: `${providerId} request timed out.`,
      retryable: true,
      allowFallback: true,
      retryAfterMs: 10_000,
    });
  }

  if (lower.includes('401') || lower.includes('403') || lower.includes('api_key_invalid') || lower.includes('permission_denied')) {
    return classifyHttpFailure(providerId, lower.includes('401') ? 401 : 403, raw);
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return classifyHttpFailure(providerId, 429, raw);
  }
  if (lower.includes('503') || lower.includes('unavailable') || lower.includes('high demand') || lower.includes('econnreset')) {
    return classifyHttpFailure(providerId, 503, raw);
  }
  if (lower.includes('400') || lower.includes('invalid argument')) {
    return classifyHttpFailure(providerId, 400, raw);
  }

  return new ProviderExecutionError({
    providerId,
    errorClass: 'INTERNAL_ERROR',
    statusCode: 500,
    message: `${providerId} error: ${sanitizeDiagnosticMessage(raw)}`,
    retryable: false,
    allowFallback: false,
  });
}

async function withTimeoutRace<T>(promise: Promise<T>, timeoutMs: number, providerId: AiProviderId): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderExecutionError({
              providerId,
              errorClass: 'TIMEOUT',
              statusCode: 504,
              message: `${providerId} exceeded timeout of ${timeoutMs}ms`,
              retryable: true,
              allowFallback: true,
              retryAfterMs: 10_000,
            })
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

// 1. GOOGLE GEMINI ADAPTER
export function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
}

export const geminiAdapter: AiProviderAdapter = {
  providerId: 'gemini',
  name: 'Google Gemini API',
  isConfigured() {
    return Boolean(createGeminiClient());
  },
  getMissingEnvVars() {
    return createGeminiClient() ? [] : ['GEMINI_API_KEY'];
  },
  async generate(opts: ProviderAdapterCallOptions): Promise<ProviderAdapterResult> {
    const ai = createGeminiClient();
    if (!ai) {
      throw new ProviderExecutionError({
        providerId: 'gemini',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'GEMINI_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true, // Allow fallback to Groq/OpenRouter if Gemini secret isn't set
      });
    }
    const start = Date.now();
    try {
      const contents = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
      const config: Record<string, unknown> = {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: opts.maxOutputTokens,
      };
      if (typeof opts.temperature === 'number') {
        config.temperature = opts.temperature;
      }
      if (opts.responseFormat === 'json') {
        config.responseMimeType = 'application/json';
        if (opts.geminiJsonSchema) {
          config.responseSchema = opts.geminiJsonSchema;
        }
      }

      const response = await withTimeoutRace(
        ai.models.generateContent({
          model: opts.model.id,
          contents,
          config,
        }),
        opts.timeoutMs,
        'gemini'
      );

      const text = (response.text || '').trim();
      const finishReason = String(
        (response as { candidates?: Array<{ finishReason?: string }> }).candidates?.[0]?.finishReason || 'STOP'
      );
      const usageMeta = (response as {
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      }).usageMetadata;
      const inputTokens = usageMeta?.promptTokenCount || estimateTokens(contents);
      const outputTokens = usageMeta?.candidatesTokenCount || estimateTokens(text);

      return {
        text,
        finishReason,
        truncated: finishReason.toUpperCase().includes('MAX_TOKENS'),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: usageMeta?.totalTokenCount || inputTokens + outputTokens,
        },
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      throw classifyThrownError('gemini', err);
    }
  },
  async stream(opts: ProviderAdapterCallOptions): Promise<ProviderAdapterResult> {
    const ai = createGeminiClient();
    if (!ai) {
      throw new ProviderExecutionError({
        providerId: 'gemini',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'GEMINI_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true,
      });
    }
    const start = Date.now();
    try {
      const contents = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
      const streamResp = await withTimeoutRace(
        ai.models.generateContentStream({
          model: opts.model.id,
          contents,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            maxOutputTokens: opts.maxOutputTokens,
            ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
          },
        }),
        opts.timeoutMs,
        'gemini'
      );

      let fullText = '';
      let finishReason = 'STOP';
      let inputTokens = estimateTokens(contents);
      let outputTokens = 0;

      for await (const chunk of streamResp) {
        const piece = chunk.text || '';
        if (piece) {
          fullText += piece;
          opts.onStreamChunk?.(piece);
        }
        const candReason = (chunk as { candidates?: Array<{ finishReason?: string }> }).candidates?.[0]?.finishReason;
        if (candReason) finishReason = String(candReason);
        const u = (chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
        if (u?.promptTokenCount) inputTokens = u.promptTokenCount;
        if (u?.candidatesTokenCount) outputTokens = u.candidatesTokenCount;
      }

      if (!outputTokens) outputTokens = estimateTokens(fullText);

      return {
        text: fullText.trim(),
        finishReason,
        truncated: finishReason.toUpperCase().includes('MAX_TOKENS'),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      throw classifyThrownError('gemini', err);
    }
  },
  async healthCheck(model: AiModelSpec, timeoutMs = 10_000) {
    const res = await geminiAdapter.generate({
      model,
      prompt: 'Reply strictly with: OK',
      maxOutputTokens: 16,
      timeoutMs,
      responseFormat: 'text',
    });
    return { ok: Boolean(res.text), latencyMs: res.latencyMs, detail: `Responded (${res.text.slice(0, 24)})` };
  },
};

// Shared OpenAI-Compatible Chat Completions Helper (Groq, OpenRouter, Cloudflare Workers AI)
async function executeOpenAiCompatible(opts: {
  providerId: AiProviderId;
  endpointUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  callOpts: ProviderAdapterCallOptions;
  stream: boolean;
}): Promise<ProviderAdapterResult> {
  const { providerId, endpointUrl, apiKey, extraHeaders, callOpts, stream } = opts;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), callOpts.timeoutMs);

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (callOpts.systemPrompt) {
    messages.push({ role: 'system', content: callOpts.systemPrompt });
  }
  const userContent =
    callOpts.responseFormat === 'json' && !callOpts.prompt.toLowerCase().includes('json')
      ? `${callOpts.prompt}\n\nRespond strictly with valid JSON.`
      : callOpts.prompt;
  messages.push({ role: 'user', content: userContent });

  const body: Record<string, unknown> = {
    model: callOpts.model.id,
    messages,
    max_tokens: callOpts.maxOutputTokens,
    stream,
    ...(typeof callOpts.temperature === 'number' ? { temperature: callOpts.temperature } : {}),
  };

  if (callOpts.responseFormat === 'json' && callOpts.model.supportsStructuredJson && !stream) {
    body.response_format = { type: 'json_object' };
  }

  try {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw classifyHttpFailure(providerId, res.status, errText, retryAfterMs);
    }

    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = (json.choices?.[0]?.message?.content || '').trim();
      const finishReason = String(json.choices?.[0]?.finish_reason || 'stop');
      const inputTokens = json.usage?.prompt_tokens || estimateTokens(userContent);
      const outputTokens = json.usage?.completion_tokens || estimateTokens(text);
      return {
        text,
        finishReason,
        truncated: finishReason === 'length' || finishReason === 'max_tokens',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: json.usage?.total_tokens || inputTokens + outputTokens,
        },
        latencyMs: Date.now() - start,
      };
    }

    // Parse SSE stream cleanly
    if (!res.body) {
      throw new ProviderExecutionError({
        providerId,
        errorClass: 'UPSTREAM_UNAVAILABLE',
        statusCode: 502,
        message: `${providerId} returned empty stream body.`,
        retryable: true,
        allowFallback: true,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let finishReason = 'stop';
    let usage: NormalizedUsage = {
      inputTokens: estimateTokens(userContent),
      outputTokens: 0,
      totalTokens: 0,
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            callOpts.onStreamChunk?.(delta);
          }
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = String(parsed.choices[0].finish_reason);
          }
          if (parsed.usage) {
            const inTok = parsed.usage.prompt_tokens || usage.inputTokens;
            const outTok = parsed.usage.completion_tokens || estimateTokens(fullText);
            usage = {
              inputTokens: inTok,
              outputTokens: outTok,
              totalTokens: parsed.usage.total_tokens || inTok + outTok,
            };
          }
        } catch {
          // Ignore malformed SSE keep-alive lines
        }
      }
    }

    if (!usage.outputTokens) {
      usage.outputTokens = estimateTokens(fullText);
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }

    return {
      text: fullText.trim(),
      finishReason,
      truncated: finishReason === 'length' || finishReason === 'max_tokens',
      usage,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    throw classifyThrownError(providerId, err);
  } finally {
    clearTimeout(timer);
  }
}

// 2. GROQ ADAPTER
export const groqAdapter: AiProviderAdapter = {
  providerId: 'groq',
  name: 'Groq API',
  isConfigured() {
    return Boolean(process.env.GROQ_API_KEY?.trim());
  },
  getMissingEnvVars() {
    return process.env.GROQ_API_KEY?.trim() ? [] : ['GROQ_API_KEY'];
  },
  async generate(opts) {
    const key = process.env.GROQ_API_KEY?.trim();
    if (!key) {
      throw new ProviderExecutionError({
        providerId: 'groq',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'GROQ_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'groq',
      endpointUrl: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: key,
      callOpts: opts,
      stream: false,
    });
  },
  async stream(opts) {
    const key = process.env.GROQ_API_KEY?.trim();
    if (!key) {
      throw new ProviderExecutionError({
        providerId: 'groq',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'GROQ_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'groq',
      endpointUrl: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: key,
      callOpts: opts,
      stream: true,
    });
  },
  async healthCheck(model, timeoutMs = 10_000) {
    const res = await groqAdapter.generate({
      model,
      prompt: 'Reply strictly with: OK',
      maxOutputTokens: 16,
      timeoutMs,
      responseFormat: 'text',
    });
    return { ok: Boolean(res.text), latencyMs: res.latencyMs, detail: `Responded (${res.text.slice(0, 24)})` };
  },
};

// 3. OPENROUTER ADAPTER
export const openRouterAdapter: AiProviderAdapter = {
  providerId: 'openrouter',
  name: 'OpenRouter API',
  isConfigured() {
    return Boolean(process.env.OPENROUTER_API_KEY?.trim());
  },
  getMissingEnvVars() {
    return process.env.OPENROUTER_API_KEY?.trim() ? [] : ['OPENROUTER_API_KEY'];
  },
  async generate(opts) {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      throw new ProviderExecutionError({
        providerId: 'openrouter',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'OPENROUTER_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'openrouter',
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: key,
      extraHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://74-studio.com',
        'X-Title': 'Behind The Release & 74 STUDIO Hub',
      },
      callOpts: opts,
      stream: false,
    });
  },
  async stream(opts) {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      throw new ProviderExecutionError({
        providerId: 'openrouter',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'OPENROUTER_API_KEY is not configured in Settings > Secrets.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'openrouter',
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: key,
      extraHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://74-studio.com',
        'X-Title': 'Behind The Release & 74 STUDIO Hub',
      },
      callOpts: opts,
      stream: true,
    });
  },
  async healthCheck(model, timeoutMs = 10_000) {
    const res = await openRouterAdapter.generate({
      model,
      prompt: 'Reply strictly with: OK',
      maxOutputTokens: 16,
      timeoutMs,
      responseFormat: 'text',
    });
    return { ok: Boolean(res.text), latencyMs: res.latencyMs, detail: `Responded (${res.text.slice(0, 24)})` };
  },
};

// 4. CLOUDFLARE WORKERS AI ADAPTER (Strictly Optional & Lightweight-Only)
export const cloudflareAdapter: AiProviderAdapter = {
  providerId: 'cloudflare',
  name: 'Cloudflare Workers AI',
  isConfigured() {
    return Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim() && process.env.CLOUDFLARE_ACCOUNT_ID?.trim());
  },
  getMissingEnvVars() {
    const missing: string[] = [];
    if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) missing.push('CLOUDFLARE_API_TOKEN');
    if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');
    return missing;
  },
  async generate(opts) {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!token || !accountId) {
      throw new ProviderExecutionError({
        providerId: 'cloudflare',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for Cloudflare Workers AI.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'cloudflare',
      endpointUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
      apiKey: token,
      callOpts: opts,
      stream: false,
    });
  },
  async stream(opts) {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!token || !accountId) {
      throw new ProviderExecutionError({
        providerId: 'cloudflare',
        errorClass: 'AUTH_INVALID',
        statusCode: 401,
        message: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for Cloudflare Workers AI.',
        retryable: false,
        allowFallback: true,
      });
    }
    return executeOpenAiCompatible({
      providerId: 'cloudflare',
      endpointUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
      apiKey: token,
      callOpts: opts,
      stream: true,
    });
  },
  async healthCheck(model, timeoutMs = 10_000) {
    const res = await cloudflareAdapter.generate({
      model,
      prompt: 'Reply strictly with: OK',
      maxOutputTokens: 16,
      timeoutMs,
      responseFormat: 'text',
    });
    return { ok: Boolean(res.text), latencyMs: res.latencyMs, detail: `Responded (${res.text.slice(0, 24)})` };
  },
};

export const ADAPTER_REGISTRY: Record<AiProviderId, AiProviderAdapter> = {
  gemini: geminiAdapter,
  groq: groqAdapter,
  openrouter: openRouterAdapter,
  cloudflare: cloudflareAdapter,
};
