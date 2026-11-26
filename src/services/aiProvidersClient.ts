import type {
  AiProviderId,
  AiProvidersDashboardSnapshot,
  BusinessWorkspaceId,
  WorkspaceAiProfileConfig,
} from '../types/aiProviders';
import { getOperatorAuthHeaders } from './authHeaders';

export const aiProvidersClient = {
  async getDashboard(): Promise<AiProvidersDashboardSnapshot> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/ai-providers/dashboard', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to load AI provider manager dashboard.');
    }
    return data as AiProvidersDashboardSnapshot;
  },

  async updateWorkspaceConfig(
    workspaceId: BusinessWorkspaceId,
    patch: Partial<WorkspaceAiProfileConfig>
  ): Promise<{ workspaceConfig: WorkspaceAiProfileConfig; snapshot: AiProvidersDashboardSnapshot }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/ai-providers/workspace-config/${encodeURIComponent(workspaceId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update workspace AI configuration.');
    }
    return data;
  },

  async updateGlobalPolicy(
    providerId: AiProviderId,
    patch: {
      disabledManually?: boolean;
      dailyRequestBudget?: number;
      dailyTokenBudget?: number;
      clearCooldown?: boolean;
    }
  ): Promise<{ snapshot: AiProvidersDashboardSnapshot }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/ai-providers/global-policy/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update provider policy.');
    }
    return data;
  },

  async testConnection(
    workspaceId: BusinessWorkspaceId,
    providerId: AiProviderId
  ): Promise<{
    result: {
      ok: boolean;
      providerId: AiProviderId;
      model: string;
      latencyMs: number;
      detail: string;
      catalogVerification?: { verifiedCount: number; source: string; error?: string };
    };
    snapshot: AiProvidersDashboardSnapshot;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/ai-providers/test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId, providerId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Provider health probe failed.');
    }
    return data;
  },

  async verifyCatalog(providerId: AiProviderId): Promise<{
    providerId: AiProviderId;
    verifiedCount: number;
    source: string;
    error?: string;
    snapshot: AiProvidersDashboardSnapshot;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/ai-providers/verify-catalog/${encodeURIComponent(providerId)}`, {
      method: 'POST',
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Catalog verification failed.');
    }
    return data;
  },

  async resetWorkspaceUsage(workspaceId: BusinessWorkspaceId): Promise<AiProvidersDashboardSnapshot> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/ai-providers/reset-usage/${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to reset workspace usage.');
    }
    return data.snapshot as AiProvidersDashboardSnapshot;
  },
};
