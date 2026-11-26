import 'dotenv/config';
import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';
import { registerSocialIntegrations } from './server/socialIntegrations';
import { registerInstagramWebhook, WebhookRawBodyRequest } from './server/instagramWebhook';
import { registerVideoTranscoder } from './server/videoTranscoder';
import { registerMarketingIntelligence } from './server/marketingIntelligence';
import { registerAiProviderRoutes } from './server/aiProviders/routes';
import { registerSalesIntelligence } from './server/salesIntelligence';
import { registerVideoStudio } from './server/videoStudio';
import { registerSupabaseSystemRoutes } from './server/supabase/migrateFromLegacy';
import { executeAiTask, getProvidersDashboardSnapshot } from './server/aiProviders/providerManager';
import { requireServerOperator } from './server/aiProviders/authMiddleware';
import {
  checkQuotaAndAvailability,
  recordProviderError,
  recordProviderSuccess,
} from './server/aiProviders/quotaStore';
import { ProviderExecutionError } from './server/aiProviders/types';
import { aiGenerationLimiter } from './server/rateLimiters';

function resolveServerPort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const cliPort = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(cliPort) && cliPort > 0) return cliPort;
  }
  if (process.env.NODE_ENV === 'production' && !process.env.NGINX_PORT) {
    const prodPort = Number(process.env.PORT);
    if (Number.isFinite(prodPort) && prodPort > 0) return prodPort;
  }
  const devPort = Number(process.env.DEFAULT_APP_PORT);
  return Number.isFinite(devPort) && devPort > 0 ? devPort : 3000;
}

const PORT = resolveServerPort();

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function handleAiError(res: Response, err: unknown) {
  if (err instanceof ProviderExecutionError) {
    const isQuota =
      err.errorClass === 'RATE_LIMITED' ||
      err.errorClass === 'QUOTA_EXCEEDED' ||
      err.errorClass === 'BUDGET_EXHAUSTED';
    const isAuth = err.errorClass === 'AUTH_INVALID';
    const status = err.statusCode || (isQuota ? 429 : isAuth ? 403 : 503);
    return res.status(status).json({
      error: err.message,
      code: err.errorClass,
      providerId: err.providerId,
      quotaExceeded: isQuota,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const isQuota =
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit');
  const isAuth =
    lower.includes('403') ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied') ||
    lower.includes('api key');

  const status = isQuota ? 429 : isAuth ? 403 : 500;
  return res.status(status).json({
    error: isQuota
      ? 'AI free-tier quota or rate limit reached. You can continue creating and editing manually or retry shortly.'
      : isAuth
        ? 'AI API key is missing or invalid in Settings > Secrets. Manual creation remains available.'
        : `AI request failed: ${message}`,
    code: isQuota ? 'QUOTA_EXCEEDED' : isAuth ? 'AUTH_ERROR' : 'AI_ERROR',
    quotaExceeded: isQuota,
  });
}

async function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  const httpServer = http.createServer(app);

  const largeUploadJson = express.json({ limit: '80mb' });
  const transcribeJson = express.json({ limit: '16mb' });
  const standardJson = express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      const webhookReq = req as WebhookRawBodyRequest;
      if (webhookReq.originalUrl?.startsWith('/api/webhooks/')) {
        webhookReq.rawBody = buf;
      }
    },
  });

  // Scoped JSON payload limits: 80mb strictly for direct media upload/scheduling; 1mb default everywhere else
  app.use((req, res, next) => {
    if (
      req.path === '/api/publish/now' ||
      req.path.startsWith('/api/scheduled-jobs')
    ) {
      return largeUploadJson(req, res, next);
    }
    if (req.path === '/api/ai/transcribe-audio') {
      return transcribeJson(req, res, next);
    }
    if (
      req.path === '/api/video/transcode-mp4' ||
      req.path.startsWith('/api/video-studio')
    ) {
      // /api/video/transcode-mp4 parses binary via express.raw(), video-studio uses its 4mb parser
      return next();
    }
    return standardJson(req, res, next);
  });

  registerSocialIntegrations(app);
  registerInstagramWebhook(app);
  registerVideoTranscoder(app);
  registerMarketingIntelligence(app);
  registerAiProviderRoutes(app);
  registerSalesIntelligence(app);
  registerVideoStudio(app);
  registerSupabaseSystemRoutes(app);

  const behindReleaseAuth = requireServerOperator('ws-behind-the-release');

  app.get('/api/health', (_req: Request, res: Response) => {
    const ai = getAiClient();
    const snap = getProvidersDashboardSnapshot();
    const providersConfigured = snap.providers.reduce<Record<string, boolean>>((acc, p) => {
      acc[p.providerId] = p.configured;
      return acc;
    }, {});
    res.json({
      ok: true,
      geminiConfigured: Boolean(ai),
      providersConfigured,
      timestamp: new Date().toISOString(),
    });
  });

  // 1. Content-First Carousel Structuring
  app.post('/api/ai/carousel-structure', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {

    const { content, slideCount, designInstructions, workspaceName, brandVoice } = req.body as {
      content: string;
      slideCount: number;
      designInstructions?: string;
      workspaceName?: string;
      brandVoice?: string;
    };

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required.' });
    }

    try {
      const targetSlides = Math.max(2, Math.min(15, Number(slideCount) || 5));
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'carousel-structure',
        responseFormat: 'json',
        prompt: `Organize the following user-supplied content into exactly ${targetSlides} cohesive social carousel slides for "${workspaceName || 'Behind The Release'}".

CRITICAL RULES:
- Preserve the user's exact meaning, facts, and core arguments without inventing unrelated filler.
- Slide 1 must act as a compelling cover/opening slide with a crisp kicker, strong headline, and concise subtitle.
- Middle slides must carry clear, structured points (headline, concise body copy, optional key highlight/stat or callout).
- The final slide must conclude clearly with a call-to-action aligned with the source text.
- Keep text scannable for a 1080x1350 visual layout (headline <= 10 words, body <= 35 words per slide unless the source strictly requires more).
${designInstructions ? `Design instructions to respect in pacing/tone: ${designInstructions}` : ''}
${brandVoice ? `Brand voice guidance: ${brandVoice}` : ''}

SOURCE CONTENT:
${content}

Return JSON with keys: projectTitle, suggestedCaption, hashtags (string array), slides (array of { role, kicker, headline, body, highlight, layoutVariant, visualNote }).`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            projectTitle: { type: Type.STRING },
            suggestedCaption: { type: Type.STRING },
            hashtags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            slides: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  role: { type: Type.STRING, description: 'cover | body | breakdown | quote | cta' },
                  kicker: { type: Type.STRING },
                  headline: { type: Type.STRING },
                  body: { type: Type.STRING },
                  highlight: { type: Type.STRING },
                  layoutVariant: {
                    type: Type.STRING,
                    description: 'hero-center | editorial-split | stat-focus | quote-card | minimal-list | cta-end',
                  },
                  visualNote: { type: Type.STRING },
                },
                required: ['role', 'headline', 'body', 'layoutVariant'],
              },
            },
          },
          required: ['projectTitle', 'slides'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return res.json({
        ...parsed,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
        },
      });
    } catch (err) {
      return handleAiError(res, err);
    }
  });

  // 2. Topic-First Carousel Generation
  app.post('/api/ai/carousel-topic', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {
    const {
      topic,
      audience,
      objective,
      tone,
      slideCount,
      cta,
      keywords,
      referenceMaterial,
      workspaceName,
      brandVoice,
    } = req.body as {
      topic: string;
      audience: string;
      objective: string;
      tone: string;
      slideCount: number;
      cta: string;
      keywords?: string;
      referenceMaterial?: string;
      workspaceName?: string;
      brandVoice?: string;
    };

    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: 'Topic is required.' });
    }

    try {
      const targetSlides = Math.max(2, Math.min(15, Number(slideCount) || 5));
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'carousel-structure',
        responseFormat: 'json',
        prompt: `Develop a complete, high-authority ${targetSlides}-slide Instagram carousel for brand "${workspaceName || 'Behind The Release'}".

BRIEF:
- Topic: ${topic}
- Target Audience: ${audience || 'Independent artists, managers, and creative directors'}
- Main Objective: ${objective || 'Educate and drive saves'}
- Preferred Tone: ${tone || 'Confident, editorial, practical'}
- Closing Call To Action: ${cta || 'Save this breakdown for your next release'}
${keywords ? `- Keywords: ${keywords}` : ''}
${brandVoice ? `- Brand Voice Profile: ${brandVoice}` : ''}
${referenceMaterial ? `- Reference Material:\n${referenceMaterial}` : ''}

QUALITY RULES:
- Never generate vague filler just to pad slides. Every slide must deliver concrete insight, framework steps, or real-world music industry / creative studio examples.
- Slide 1: High-impact hook cover slide.
- Middle slides: Logical narrative progression with crisp headlines (<= 9 words) and focused body copy (20-38 words).
- Final slide: Strong synthesis and the requested CTA.

Return JSON with keys: projectTitle, suggestedCaption, hashtags (string array), slides (array of { role, kicker, headline, body, highlight, layoutVariant, visualNote }).`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            projectTitle: { type: Type.STRING },
            suggestedCaption: { type: Type.STRING },
            hashtags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            slides: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  role: { type: Type.STRING },
                  kicker: { type: Type.STRING },
                  headline: { type: Type.STRING },
                  body: { type: Type.STRING },
                  highlight: { type: Type.STRING },
                  layoutVariant: { type: Type.STRING },
                  visualNote: { type: Type.STRING },
                },
                required: ['role', 'headline', 'body', 'layoutVariant'],
              },
            },
          },
          required: ['projectTitle', 'slides'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return res.json({
        ...parsed,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
        },
      });
    } catch (err) {
      return handleAiError(res, err);
    }
  });

  // 3. Single Slide Design/Copy Regeneration
  app.post('/api/ai/carousel-slide-regen', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {
    const { slide, instruction, workspaceName, themeName } = req.body as {
      slide: { kicker?: string; headline: string; body: string; highlight?: string; layoutVariant?: string };
      instruction?: string;
      workspaceName?: string;
      themeName?: string;
    };

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'creative-copy',
        responseFormat: 'json',
        prompt: `Refine and elevate this single carousel slide for "${workspaceName || 'Behind The Release'}" using visual theme "${themeName || 'Dark Luxury'}".
Current slide:
Kicker: ${slide.kicker || ''}
Headline: ${slide.headline}
Body: ${slide.body}
Highlight: ${slide.highlight || ''}
Current Layout Variant: ${slide.layoutVariant || 'editorial-split'}

User instruction: ${instruction || 'Make the layout and copy sharper, punchier, and more scannable without losing the core point.'}

Return JSON { kicker, headline, body, highlight, layoutVariant } choosing layoutVariant from: hero-center, editorial-split, stat-focus, quote-card, minimal-list, cta-end.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            kicker: { type: Type.STRING },
            headline: { type: Type.STRING },
            body: { type: Type.STRING },
            highlight: { type: Type.STRING },
            layoutVariant: { type: Type.STRING },
          },
          required: ['headline', 'body', 'layoutVariant'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return res.json(parsed);
    } catch (err) {
      return handleAiError(res, err);
    }
  });

  // 4. Reels & Shorts Script + Storyboard + Editing Intelligence Plan
  app.post('/api/ai/reels-plan', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {
    const {
      topic,
      existingScript,
      transcript,
      creationMode,
      editingPresetName,
      targetDuration,
      assets,
      workspaceName,
      brandVoice,
    } = req.body as {
      topic: string;
      existingScript?: string;
      transcript?: string;
      creationMode: string;
      editingPresetName: string;
      targetDuration: number;
      assets: Array<{ id: string; name: string; kind: string; duration?: number; description?: string }>;
      workspaceName?: string;
      brandVoice?: string;
    };

    try {
      const clampedDuration = Math.max(10, Math.min(60, Number(targetDuration) || 30));
      const assetManifest =
        assets && assets.length > 0
          ? assets
              .map(
                (a, idx) =>
                  `${idx + 1}. [id=${a.id}] "${a.name}" (${a.kind}${a.duration ? `, ${a.duration.toFixed(1)}s` : ''})${a.description ? ` — Note: ${a.description}` : ''}`
              )
              .join('\n')
          : 'No media files uploaded yet — design a typography-driven or placeholder-slot storyboard clearly labeled for user media assignment.';

      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'reels-plan',
        responseFormat: 'json',
        prompt: `You are an elite short-form video editor and creative director for "${workspaceName || 'Behind The Release'}".
Create a realistic, actionable editing plan and scene-by-scene storyboard for a vertical 9:16 video (Instagram Reels / YouTube Shorts).

CONSTRAINTS (STRICT):
- Total duration MUST be <= ${clampedDuration} seconds (and never exceed 60 seconds).
- NEVER claim to have generated video footage. You are creating an editing plan and motion-graphics blueprint.
- ONLY reference uploaded assets listed in the Asset Manifest below by their exact assetId. Never invent scene footage that was not supplied. If no visual clips exist, assign assetId as "typography-card" and describe the kinetic text layout.
- Mode: ${creationMode}
- Editing Preset: ${editingPresetName}
${brandVoice ? `- Brand Voice: ${brandVoice}` : ''}

INPUTS:
- Topic / Concept: ${topic || 'Short-form music & studio feature'}
${existingScript ? `- Existing Script:\n${existingScript}` : ''}
${transcript ? `- Transcript:\n${transcript}` : ''}

UPLOADED ASSET MANIFEST:
${assetManifest}

Return JSON { projectTitle, hookLine, fullScript, musicDirection, closingCta, editingNotes, suggestedCaption, scenes: [{ sceneNumber, recommendedAssetId, recommendedAssetName, durationSeconds, sceneDescription, textOverlay, lowerThird, subtitleLine, transitionStyle, motionPreset, visualEmphasis }] }.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            projectTitle: { type: Type.STRING },
            hookLine: { type: Type.STRING },
            fullScript: { type: Type.STRING },
            musicDirection: { type: Type.STRING },
            closingCta: { type: Type.STRING },
            editingNotes: { type: Type.STRING },
            suggestedCaption: { type: Type.STRING },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sceneNumber: { type: Type.INTEGER },
                  recommendedAssetId: { type: Type.STRING },
                  recommendedAssetName: { type: Type.STRING },
                  durationSeconds: { type: Type.NUMBER },
                  sceneDescription: { type: Type.STRING },
                  textOverlay: { type: Type.STRING },
                  lowerThird: { type: Type.STRING },
                  subtitleLine: { type: Type.STRING },
                  transitionStyle: {
                    type: Type.STRING,
                    description: 'cut | crossfade | slide-up | zoom-punch | flash-silver',
                  },
                  motionPreset: {
                    type: Type.STRING,
                    description: 'kinetic-pop | editorial-reveal | lower-third | minimal-fade | type-writer',
                  },
                  visualEmphasis: { type: Type.STRING },
                },
                required: [
                  'sceneNumber',
                  'recommendedAssetId',
                  'durationSeconds',
                  'sceneDescription',
                  'textOverlay',
                  'transitionStyle',
                ],
              },
            },
          },
          required: ['projectTitle', 'hookLine', 'fullScript', 'closingCta', 'scenes'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return res.json(parsed);
    } catch (err) {
      return handleAiError(res, err);
    }
  });

  // 5. AI Content Assistant (Social Hub Copy, Hooks, Hashtags, Press Notes)
  app.post('/api/ai/social-copy', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {
    const { prompt, format, platform, workspaceName, brandVoice } = req.body as {
      prompt: string;
      format: string;
      platform: string;
      workspaceName?: string;
      brandVoice?: string;
    };

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'creative-copy',
        responseFormat: 'json',
        prompt: `Draft ready-to-publish social media assets for "${workspaceName || 'Behind The Release'}".
Platform: ${platform || 'Instagram'}
Deliverable Format: ${format || 'Caption + Hooks'}
Brand Voice: ${brandVoice || 'Confident, editorial, music-industry savvy'}

Request:
${prompt}

Return JSON { headline, caption, hooks (string array), hashtags (string array), cta }.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            caption: { type: Type.STRING },
            hooks: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            hashtags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            cta: { type: Type.STRING },
          },
          required: ['headline', 'caption', 'hooks', 'hashtags'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return res.json({
        ...parsed,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
        },
      });
    } catch (err) {
      return handleAiError(res, err);
    }
  });

  // 6. Optional Audio Transcription for Reels Subtitles (quota-tracked)
  app.post('/api/ai/transcribe-audio', behindReleaseAuth, aiGenerationLimiter, async (req: Request, res: Response) => {
    const ai = getAiClient();
    if (!ai) {
      return res.status(503).json({
        error: 'Gemini API key is not configured. Use manual transcript or SRT upload instead.',
        code: 'NO_API_KEY',
      });
    }

    const quota = checkQuotaAndAvailability('ws-behind-the-release', 'gemini');
    if (!quota.ok) {
      return res.status(429).json({
        error: quota.reason || 'Gemini quota budget reached for Behind The Release.',
        code: 'BUDGET_EXHAUSTED',
        quotaExceeded: true,
      });
    }

    const { base64Audio, mimeType } = req.body as { base64Audio: string; mimeType: string };
    if (!base64Audio) {
      return res.status(400).json({ error: 'Audio payload is required.' });
    }

    const startedAt = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType || 'audio/mp3',
                data: base64Audio,
              },
            },
            {
              text: 'Transcribe this audio verbatim with clean punctuation. Return plain text lines split by natural spoken phrases.',
            },
          ],
        },
      });

      const transcript = (response.text || '').trim();
      const inputTokens = Math.max(40, Math.round(base64Audio.length / 1000));
      const outputTokens = Math.ceil(transcript.length / 4);
      recordProviderSuccess({
        workspaceId: 'ws-behind-the-release',
        providerId: 'gemini',
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs: Date.now() - startedAt,
      });

      return res.json({ transcript });
    } catch (err) {
      recordProviderError({
        workspaceId: 'ws-behind-the-release',
        providerId: 'gemini',
        taskType: 'audio-transcribe',
        errorClass: 'UPSTREAM_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
      return handleAiError(res, err);
    }
  });

  // Vite dev middleware vs static production serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: hmrDisabled ? false : { server: httpServer },
        ...(hmrDisabled ? { ws: { server: httpServer } } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response, next) => {
        if (req.path.startsWith('/api/')) {
          return next();
        }
        return res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`74 STUDIO SOCIAL HUB server listening on http://0.0.0.0:${PORT}`);
  });
}

createApp().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
