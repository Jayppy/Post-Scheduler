import type {
  SalesChatMessage,
  SalesConversation,
  SalesKnowledgeBase,
  SalesStudioSettings,
} from '../types/sales';
import { getOperatorAuthHeaders } from './authHeaders';

export const salesClient = {
  async getSettings(): Promise<SalesStudioSettings> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/settings', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.settings) {
      throw new Error(data.error || 'Failed to load 74 STUDIO settings.');
    }
    return data.settings;
  },

  async saveSettings(settings: Partial<SalesStudioSettings>): Promise<SalesStudioSettings> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify(settings),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.settings) {
      throw new Error(data.error || 'Failed to save 74 STUDIO settings.');
    }
    return data.settings;
  },

  async getKnowledgeBase(): Promise<SalesKnowledgeBase> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/knowledge-base', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.knowledgeBase) {
      throw new Error(data.error || 'Failed to load 74 STUDIO knowledge base.');
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
      throw new Error(data.error || 'Failed to save knowledge base.');
    }
    return data.knowledgeBase;
  },

  async listConversations(): Promise<SalesConversation[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/sales/conversations', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load conversations.');
    return data.conversations || [];
  },

  async createConversation(title?: string, artistName?: string): Promise<SalesConversation> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/sales/conversations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, artistName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.conversation) {
      throw new Error(data.error || 'Failed to create conversation.');
    }
    return data.conversation;
  },

  async renameConversation(id: string, title: string): Promise<SalesConversation> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/sales/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.conversation) {
      throw new Error(data.error || 'Failed to rename conversation.');
    }
    return data.conversation;
  },

  async deleteConversation(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/sales/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete conversation.');
  },

  async sendArtistMessage(
    conversationId: string,
    payload: {
      artistMessage?: string;
      artistNote?: string;
      attachmentName?: string;
      attachmentPreviewUrl?: string;
      customGuidance?: string;
      regenerateForMessageId?: string;
    }
  ): Promise<{
    conversation: SalesConversation;
    userMessage?: SalesChatMessage;
    assistantMessage: SalesChatMessage;
  }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/sales/conversations/${encodeURIComponent(conversationId)}/reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.assistantMessage) {
      throw new Error(data.error || 'Failed to generate reply.');
    }
    return data;
  },

  async editMessage(
    conversationId: string,
    messageId: string,
    content: string
  ): Promise<{ message: SalesChatMessage; conversation: SalesConversation }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(
      `/api/sales/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ content }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.message) {
      throw new Error(data.error || 'Failed to update reply.');
    }
    return data;
  },
};
