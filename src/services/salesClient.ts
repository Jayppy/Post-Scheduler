import type { AiProviderId, LongFormDocumentManifest } from '../types/aiProviders';
import type {
  SalesActivityRecord,
  SalesKnowledgeBase,
  SalesLeadRecord,
  SalesOutputRecord,
  SalesOutputType,
} from '../types/sales';
import { getOperatorAuthHeaders } from './authHeaders';

export interface ProposalStreamHandlers {
  onManifest?: (manifest: LongFormDocumentManifest) => void;
  onDelta?: (sectionIndex: number, chunk: string, providerId: AiProviderId, model: string) => void;
  onFallback?: (fromProvider: AiProviderId, toProvider: AiProviderId, reason: string) => void;
}

export const salesClient = {
  async getKnowledgeBase(): Promise<SalesKnowledgeBase> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/knowledge-base', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.knowledgeBase) {
      throw new Error(data.error || 'Failed to load 74 STUDIO Sales knowledge base.');
    }
    return data.knowledgeBase;
  },

  async saveKnowledgeBase(kb: SalesKnowledgeBase): Promise<SalesKnowledgeBase> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/knowledge-base', {
      method: 'PUT',
      headers,
      body: JSON.stringify(kb),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.knowledgeBase) {
      throw new Error(data.error || 'Failed to save Sales knowledge base.');
    }
    return data.knowledgeBase;
  },

  async listLeads(): Promise<SalesLeadRecord[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/leads', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load leads.');
    return data.leads || [];
  },

  async saveLead(lead: Partial<SalesLeadRecord>): Promise<{ lead: SalesLeadRecord; activities?: SalesActivityRecord[] }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/leads', {
      method: 'POST',
      headers,
      body: JSON.stringify(lead),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.lead) {
      throw new Error(data.error || 'Failed to save prospect.');
    }
    return data;
  },

  async patchLead(id: string, patch: Partial<SalesLeadRecord>): Promise<SalesLeadRecord> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/sales/leads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.lead) {
      throw new Error(data.error || 'Failed to update prospect.');
    }
    return data.lead;
  },

  async deleteLead(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/sales/leads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete prospect.');
  },

  async analyzeLead(
    id: string,
    focusNotes?: string
  ): Promise<{
    lead: SalesLeadRecord;
    activity: SalesActivityRecord;
    providerMeta: { providerId: AiProviderId; model: string; wasFallback: boolean };
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/sales/leads/${encodeURIComponent(id)}/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ focusNotes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.lead) {
      throw new Error(data.error || 'Lead intelligence analysis failed.');
    }
    return data;
  },

  async quickTagNotes(rawNotes: string): Promise<{
    classification: {
      segment: SalesLeadRecord['segment'];
      buyerIntentLevel: SalesLeadRecord['buyerIntentLevel'];
      shortSummary: string;
      tags: string[];
    };
    providerMeta: { providerId: AiProviderId; model: string; wasFallback: boolean };
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/leads/quick-tag', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawNotes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Quick tagging failed.');
    return data;
  },

  async listOutputs(): Promise<SalesOutputRecord[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/outputs', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load sales outputs.');
    return data.outputs || [];
  },

  async deleteOutput(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/sales/outputs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete sales output.');
  },

  async generateOutput(payload: {
    leadId?: string;
    outputType: Exclude<SalesOutputType, 'proposal'>;
    customInstruction?: string;
    campaignFocus?: string;
  }): Promise<{
    output: SalesOutputRecord;
    activity: SalesActivityRecord;
    providerMeta: { providerId: AiProviderId; model: string; wasFallback: boolean };
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/generate-output', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.output) {
      throw new Error(data.error || 'Sales generation failed.');
    }
    return data;
  },

  async streamProposalManifest(
    payload: {
      leadId: string;
      proposalTitle?: string;
      sectionsOutline?: string[];
      customInstruction?: string;
      targetWordsPerSection?: number;
    },
    handlers: ProposalStreamHandlers = {}
  ): Promise<{
    output: SalesOutputRecord;
    manifest: LongFormDocumentManifest;
    markdown: string;
    providerId: AiProviderId | 'fallback';
    model: string;
    wasFallback: boolean;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/proposals/stream-manifest', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to start proposal stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalPayload: {
      output: SalesOutputRecord;
      manifest: LongFormDocumentManifest;
      markdown: string;
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
            throw new Error(parsed.error || 'Proposal streaming failed.');
          }
        }
        sepIdx = buffer.indexOf('\n\n');
      }
    }

    if (!finalPayload) {
      throw new Error('Proposal stream ended before completion manifest arrived.');
    }
    return finalPayload;
  },

  async continueProposalManifest(payload: {
    outputId?: string;
    leadId?: string;
    manifest?: LongFormDocumentManifest;
    proposalTitle?: string;
  }): Promise<{
    output?: SalesOutputRecord;
    manifest: LongFormDocumentManifest;
    markdown: string;
    providerId: AiProviderId | 'fallback';
    model: string;
    wasFallback: boolean;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/proposals/continue-manifest', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.manifest) {
      throw new Error(data.error || 'Failed to continue incomplete proposal sections.');
    }
    return data;
  },

  async listActivities(): Promise<SalesActivityRecord[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/activities', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return data.activities || [];
  },
};
