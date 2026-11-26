import { rateLimit, ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from './aiProviders/authMiddleware';

/**
 * Multi-tier HTTP Rate Limiting for 74 STUDIO SOCIAL HUB & Behind The Release.
 *
 * Production Multi-Instance Note:
 * `express-rate-limit` defaults to an in-memory store (`MemoryStore`), which enforces
 * accurate per-user/per-workspace/IP limits on a single Node.js instance. If deployed across
 * multiple horizontal replicas (e.g., Cloud Run max-instances > 1), attach a shared external
 * store such as `rate-limit-redis` or a centralized PostgreSQL/Memorystore backend.
 */

function resolveWorkspaceScope(req: Request): string {
  const bodyWs = (req.body as { workspaceId?: unknown } | undefined)?.workspaceId;
  const queryWs = req.query.workspaceId;
  const paramWs = req.params?.workspaceId;
  const raw = typeof bodyWs === 'string'
    ? bodyWs
    : typeof queryWs === 'string'
      ? queryWs
      : typeof paramWs === 'string'
        ? paramWs
        : '';
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (clean) return clean.slice(0, 64);

  if (req.path.startsWith('/api/sales')) return 'ws-74-studio-sales';
  if (
    req.path.startsWith('/api/video') ||
    req.path.startsWith('/api/marketing') ||
    req.path.startsWith('/api/integrations') ||
    req.path.startsWith('/api/scheduled-jobs') ||
    req.path.startsWith('/api/publish') ||
    req.path.startsWith('/api/auth/')
  ) {
    return 'ws-behind-the-release';
  }
  return 'global';
}

function buildRateLimitKey(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  const userScope = authReq.operatorContext?.ownerScopeKey || 'anon';
  const wsScope = resolveWorkspaceScope(req);
  const ipScope = ipKeyGenerator(req.ip || '127.0.0.1');
  return `${userScope}:${wsScope}:${ipScope}`;
}

function createLimiter(opts: {
  name: string;
  windowMs: number;
  max: number;
  skip?: (req: Request) => boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: buildRateLimitKey,
    skip: opts.skip,
    handler: (_req: Request, res: Response) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(opts.windowMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: `Too many requests on ${opts.name}. Please wait briefly and try again.`,
        code: 'RATE_LIMIT_EXCEEDED',
        limiter: opts.name,
        retryAfterSeconds,
      });
    },
  });
}

// 1. Expensive AI generation & model testing endpoints (per user + workspace + IP)
export const aiGenerationLimiter = createLimiter({
  name: 'ai-generation',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_AI_MAX) || 30,
});

// 2. Heavy 160MB FFmpeg video transcoding endpoint
export const videoTranscodeLimiter = createLimiter({
  name: 'video-transcode',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_TRANSCODE_MAX) || 12,
});

// 3. Chunked / resumable video render uploads (2MB chunks; high headroom for 90s 1080p renders)
export const videoUploadLimiter = createLimiter({
  name: 'video-upload',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_UPLOAD_MAX) || 120,
});

// 4. OAuth initiation, disconnect, immediate publish, and scheduled job mutations
export const authAndIntegrationMutationLimiter = createLimiter({
  name: 'integrations-mutation',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_INTEGRATIONS_MAX) || 40,
});

// 5. Legitimate status/queue polling reads (generous headroom, exempting external callbacks/webhooks)
export const integrationReadLimiter = createLimiter({
  name: 'integrations-read',
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_READ_MAX) || 120,
  skip: (req) =>
    req.path.startsWith('/api/auth/youtube/callback') ||
    req.path.startsWith('/api/auth/instagram/callback') ||
    req.path.startsWith('/api/webhooks/') ||
    req.path.startsWith('/api/temp-media/'),
});
