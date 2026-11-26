import express, { type Express, type Response } from 'express';
import type { AiProviderId, WorkspaceAiProfileConfig } from '../../src/types/aiProviders';
import {
  type AuthenticatedRequest,
  requireServerOperator,
  validateBusinessWorkspaceId,
} from './authMiddleware';
import { refreshLiveProviderCatalog } from './modelRegistry';
import {
  getProvidersDashboardSnapshot,
  testProviderConnection,
} from './providerManager';
import {
  resetWorkspaceUsageCounters,
  updateGlobalProviderPolicy,
  updateWorkspaceAiConfig,
} from './quotaStore';
import { aiGenerationLimiter } from '../rateLimiters';

const VALID_PROVIDERS = new Set<AiProviderId>(['gemini', 'groq', 'openrouter', 'cloudflare']);

export function registerAiProviderRoutes(app: Express): void {
  const smallJsonParser = express.json({ limit: '512kb' });
  const authGuard = requireServerOperator();

  app.get('/api/ai-providers/dashboard', authGuard, (_req: AuthenticatedRequest, res: Response) => {
    return res.json(getProvidersDashboardSnapshot());
  });

  app.put(
    '/api/ai-providers/workspace-config/:workspaceId',
    smallJsonParser,
    authGuard,
    (req: AuthenticatedRequest, res: Response) => {
      const workspaceId = validateBusinessWorkspaceId(req.params.workspaceId);
      if (!workspaceId) {
        return res.status(400).json({ error: 'Invalid workspaceId. Expected ws-behind-the-release or ws-74-studio-sales.' });
      }
      const patch = (req.body || {}) as Partial<WorkspaceAiProfileConfig>;
      try {
        const updated = updateWorkspaceAiConfig(workspaceId, patch);
        return res.json({ workspaceConfig: updated, snapshot: getProvidersDashboardSnapshot() });
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid workspace AI configuration update.',
        });
      }
    }
  );

  app.put(
    '/api/ai-providers/global-policy/:providerId',
    smallJsonParser,
    authGuard,
    (req: AuthenticatedRequest, res: Response) => {
      const providerId = req.params.providerId as AiProviderId;
      if (!VALID_PROVIDERS.has(providerId)) {
        return res.status(400).json({ error: 'Invalid providerId.' });
      }
      const body = (req.body || {}) as {
        disabledManually?: boolean;
        dailyRequestBudget?: number;
        dailyTokenBudget?: number;
        clearCooldown?: boolean;
      };
      const updated = updateGlobalProviderPolicy(providerId, body);
      return res.json({ policy: updated, snapshot: getProvidersDashboardSnapshot() });
    }
  );

  app.post(
    '/api/ai-providers/test',
    smallJsonParser,
    authGuard,
    aiGenerationLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const { workspaceId: rawWs, providerId } = (req.body || {}) as {
        workspaceId?: string;
        providerId?: AiProviderId;
      };
      const workspaceId = validateBusinessWorkspaceId(rawWs) || 'ws-behind-the-release';
      if (!providerId || !VALID_PROVIDERS.has(providerId)) {
        return res.status(400).json({ error: 'Valid providerId (gemini | groq | openrouter | cloudflare) is required.' });
      }
      const result = await testProviderConnection(workspaceId, providerId);
      return res.json({
        result,
        snapshot: getProvidersDashboardSnapshot(),
      });
    }
  );

  app.post(
    '/api/ai-providers/verify-catalog/:providerId',
    smallJsonParser,
    authGuard,
    async (req: AuthenticatedRequest, res: Response) => {
      const providerId = req.params.providerId as AiProviderId;
      if (!VALID_PROVIDERS.has(providerId)) {
        return res.status(400).json({ error: 'Invalid providerId.' });
      }
      const result = await refreshLiveProviderCatalog(providerId);
      return res.json({
        providerId,
        ...result,
        snapshot: getProvidersDashboardSnapshot(),
      });
    }
  );

  app.post(
    '/api/ai-providers/reset-usage/:workspaceId',
    smallJsonParser,
    authGuard,
    (req: AuthenticatedRequest, res: Response) => {
      const workspaceId = validateBusinessWorkspaceId(req.params.workspaceId);
      if (!workspaceId) {
        return res.status(400).json({ error: 'Invalid workspaceId.' });
      }
      resetWorkspaceUsageCounters(workspaceId);
      return res.json({ ok: true, snapshot: getProvidersDashboardSnapshot() });
    }
  );
}
