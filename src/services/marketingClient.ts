import type { AiProviderId, LongFormDocumentManifest } from '../types/aiProviders';
import type {
  BusinessKnowledgeBase,
  CentralContentConcept,
  EvidenceClaimRef,
  GenerateMarketingContentInput,
  MarketingDraft,
  OptionalResearchIntegrationStatus,
  PlatformContentBundle,
  ResearchCategory,
  ResearchSourceRecord,
  TopicOpportunity,
} from '../types/marketing';
import { getOperatorAuthHeaders } from './authHeaders';

export interface MarketingIntegrationsResponse {
  geminiConfigured: boolean;
  liveWebSearchEnabled: boolean;
  integrations: OptionalResearchIntegrationStatus[];
  disclosure: string;
}

export interface BlogStreamHandlers {
  onManifest?: (manifest: LongFormDocumentManifest) => void;
  onDelta?: (sectionIndex: number, chunk: string, providerId: AiProviderId, model: string) => void;
  onFallback?: (fromProvider: AiProviderId, toProvider: AiProviderId, reason: string) => void;
}

export const marketingClient = {
  async getIntegrations(): Promise<MarketingIntegrationsResponse> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/marketing/integrations', { headers });
    if (!res.ok) throw new Error('Failed to load marketing integration status.');
    return res.json();
  },

  async getKnowledgeBase(): Promise<BusinessKnowledgeBase> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/marketing/knowledge-base', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.knowledgeBase) {
      throw new Error(data.error || 'Failed to load 74 STUDIO knowledge base.');
    }
    return data.knowledgeBase;
  },

  async saveKnowledgeBase(kb: BusinessKnowledgeBase): Promise<BusinessKnowledgeBase> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/knowledge-base', {
      method: 'PUT',
      headers,
      body: JSON.stringify(kb),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.knowledgeBase) {
      throw new Error(data.error || 'Failed to save 74 STUDIO knowledge base.');
    }
    return data.knowledgeBase;
  },

  async getResearch(): Promise<{
    sources: ResearchSourceRecord[];
    opportunities: TopicOpportunity[];
    lastLiveResearchAt?: string;
  }> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/marketing/research', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load research intelligence.');
    return data;
  },

  async addResearchSource(
    source: Partial<ResearchSourceRecord>
  ): Promise<ResearchSourceRecord> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/research', {
      method: 'POST',
      headers,
      body: JSON.stringify(source),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.source) {
      throw new Error(data.error || 'Failed to add research source.');
    }
    return data.source;
  },

  async deleteResearchSource(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/marketing/research/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to remove research source.');
  },

  async runLiveResearchScan(opts: {
    focusQuery?: string;
    category?: ResearchCategory;
    forceRefresh?: boolean;
  }): Promise<{
    cached: boolean;
    addedSources: ResearchSourceRecord[];
    sources: ResearchSourceRecord[];
    lastLiveResearchAt?: string;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/research/discover', {
      method: 'POST',
      headers,
      body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Live research scan failed.');
    return data;
  },

  async discoverTopics(filters: {
    targetAudience?: string;
    serviceOffer?: string;
    contentCategory?: string;
  }): Promise<{ opportunities: TopicOpportunity[]; fallback?: boolean }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/discover-topics', {
      method: 'POST',
      headers,
      body: JSON.stringify(filters),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Topic discovery failed.');
    return data;
  },

  async generateCrossPlatformContent(input: GenerateMarketingContentInput): Promise<{
    title: string;
    centralConcept: CentralContentConcept;
    platforms: PlatformContentBundle;
    evidenceClaims: EvidenceClaimRef[];
    fallbackMode?: boolean;
    providerMeta?: { providerId: AiProviderId; model: string; wasFallback: boolean };
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Content generation failed.');
    return data;
  },

  async regeneratePlatform(payload: {
    platform: 'linkedin' | 'x' | 'threads' | 'blog';
    centralConcept: CentralContentConcept;
    evidenceClaims?: EvidenceClaimRef[];
    tone?: string;
    xTargetChars?: number;
    blogWordTarget?: number;
    instruction?: string;
  }): Promise<{
    platform: 'linkedin' | 'x' | 'threads' | 'blog';
    data: unknown;
    providerMeta?: { providerId: AiProviderId; model: string; wasFallback: boolean };
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/regenerate-platform', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Platform regeneration failed.');
    return data;
  },

  async streamBlogManifest(
    payload: {
      title: string;
      centralConcept: CentralContentConcept;
      h2Outline: string[];
      evidenceClaims?: EvidenceClaimRef[];
      blogWordTarget?: number;
      instruction?: string;
    },
    handlers: BlogStreamHandlers = {}
  ): Promise<{
    manifest: LongFormDocumentManifest;
    bodyMarkdown: string;
    providerId: AiProviderId | 'fallback';
    model: string;
    wasFallback: boolean;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/blog/stream-manifest', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to stream long-form blog sections.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalPayload: {
      manifest: LongFormDocumentManifest;
      bodyMarkdown: string;
      providerId: AiProviderId | 'fallback';
      model: string;
      wasFallback: boolean;
    } | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx = buffer.indexOf('\n\n');
      while (sepIdx !== -1) {
        const rawBlock = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const lines = rawBlock.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (dataLine) {
          const parsed = JSON.parse(dataLine);
          if (eventName === 'manifest') handlers.onManifest?.(parsed);
          else if (eventName === 'delta') {
            handlers.onDelta?.(parsed.sectionIndex, parsed.chunk, parsed.providerId, parsed.model);
          } else if (eventName === 'fallback') {
            handlers.onFallback?.(parsed.fromProvider, parsed.toProvider, parsed.reason);
          } else if (eventName === 'done') {
            finalPayload = parsed;
          } else if (eventName === 'error') {
            throw new Error(parsed.error || 'Blog SSE stream failed.');
          }
        }
        sepIdx = buffer.indexOf('\n\n');
      }
    }

    if (!finalPayload) {
      throw new Error('Blog SSE stream terminated before completion manifest arrived.');
    }
    return finalPayload;
  },

  async continueBlogManifest(payload: {
    title: string;
    centralConcept: CentralContentConcept;
    manifest: LongFormDocumentManifest;
    evidenceClaims?: EvidenceClaimRef[];
    blogWordTarget?: number;
  }): Promise<{
    manifest: LongFormDocumentManifest;
    bodyMarkdown: string;
    providerId: AiProviderId | 'fallback';
    model: string;
    wasFallback: boolean;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/blog/continue-manifest', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.manifest) {
      throw new Error(data.error || 'Failed to continue incomplete blog sections.');
    }
    return data;
  },

  async listDrafts(): Promise<MarketingDraft[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/marketing/drafts', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return data.drafts || [];
  },

  async saveDraft(draft: Partial<MarketingDraft>): Promise<MarketingDraft> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/marketing/drafts', {
      method: 'POST',
      headers,
      body: JSON.stringify(draft),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.draft) throw new Error(data.error || 'Failed to save draft.');
    return data.draft;
  },

  async deleteDraft(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/marketing/drafts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete draft.');
  },
};

