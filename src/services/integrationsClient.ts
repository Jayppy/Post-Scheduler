import {
  DestinationPublishState,
  PublishingLifecycleStatus,
  SocialPlatform,
  YouTubePrivacyStatus,
} from '../types/studio';

export interface PlatformStatusInfo {
  configured: boolean;
  missingVars?: string[];
  authMode?: 'unified-login' | string;
  configuredOAuthCredentials?: boolean;
  configuredUnifiedConfigId?: boolean;
  connected: boolean;
  accountId?: string;
  accountName?: string;
  accountHandle?: string;
  tokenType?: string;
  expiresAt?: number;
  lastError?: string;
  connectedAt?: string;
  callbackUrl: string;
}

export interface IntegrationsStatusResponse {
  appBaseUrl: string;
  youtube: PlatformStatusInfo;
  instagram: PlatformStatusInfo;
}

export interface MediaPreviewRef {
  index: number;
  filename: string;
  mimeType: string;
  url: string;
}

export interface ScheduledJobSummary {
  id: string;
  workspaceId: string;
  postId: string;
  title: string;
  platform: SocialPlatform;
  platforms?: Array<'instagram' | 'youtube'>;
  destinations?: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledIso: string;
  timezone?: string;
  campaignId?: string;
  mediaAssetIds?: string[];
  status: PublishingLifecycleStatus | 'pending';
  attempts: number;
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  mediaCount: number;
  mediaPreviews?: MediaPreviewRef[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishHistoryEntry {
  id: string;
  workspaceId: string;
  postId: string;
  jobId?: string;
  title: string;
  platform: SocialPlatform;
  mode: 'manual-send' | 'immediate' | 'retry' | 'scheduled';
  status: 'published' | 'failed';
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  timestamp: string;
}

export interface SendJobPayload {
  targets?: Array<'instagram' | 'youtube'>;
  instagramCaption?: string;
  instagramFormat?: 'instagram-reel' | 'instagram-carousel' | 'instagram-feed';
  youtubeTitle?: string;
  youtubeDescription?: string;
  youtubeTags?: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  mediaItems?: Array<{ filename: string; mimeType: string; base64Data: string }>;
}

export const integrationsClient = {
  async getStatus(workspaceId: string, verify = false): Promise<IntegrationsStatusResponse> {
    const res = await fetch(
      `/api/integrations/status?workspaceId=${encodeURIComponent(workspaceId)}${
        verify ? '&verify=true' : ''
      }`
    );
    if (!res.ok) throw new Error('Failed to load connected account status.');
    return res.json();
  },

  async getOAuthUrl(workspaceId: string, platform: 'youtube' | 'instagram'): Promise<string> {
    const res = await fetch(
      `/api/auth/${platform}/url?workspaceId=${encodeURIComponent(workspaceId)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      throw new Error(data.error || `Unable to start ${platform} connection.`);
    }
    return data.url;
  },

  async disconnect(workspaceId: string, platform: 'youtube' | 'instagram'): Promise<void> {
    const res = await fetch('/api/integrations/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, platform }),
    });
    if (!res.ok) throw new Error('Failed to disconnect account.');
  },

  async publishNow(payload: {
    workspaceId: string;
    postId?: string;
    platform: SocialPlatform;
    title: string;
    caption: string;
    hashtags: string[];
    youtubePrivacyStatus?: YouTubePrivacyStatus;
    mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>;
  }): Promise<{ ok: boolean; resultUrl?: string; platformPostId?: string; publishedAt?: string }> {
    const res = await fetch('/api/publish/now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Publishing failed.');
    }
    return data;
  },

  async listScheduledJobs(workspaceId: string): Promise<ScheduledJobSummary[]> {
    const res = await fetch(
      `/api/scheduled-jobs?workspaceId=${encodeURIComponent(workspaceId)}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.jobs || [];
  },

  async listPublishHistory(workspaceId: string): Promise<PublishHistoryEntry[]> {
    const res = await fetch(
      `/api/publish-history?workspaceId=${encodeURIComponent(workspaceId)}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.history || [];
  },

  async syncScheduledJob(payload: {
    workspaceId: string;
    postId: string;
    title: string;
    platform: SocialPlatform;
    platforms?: Array<'instagram' | 'youtube'>;
    caption: string;
    hashtags: string[];
    youtubePrivacyStatus?: YouTubePrivacyStatus;
    scheduledIso: string;
    timezone?: string;
    campaignId?: string;
    mediaAssetIds?: string[];
    status?: 'draft' | 'scheduled';
    mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>;
  }): Promise<ScheduledJobSummary> {
    const res = await fetch('/api/scheduled-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save scheduled post.');
    }
    return data.job;
  },

  async updateScheduledJob(
    jobId: string,
    patch: Partial<{
      title: string;
      caption: string;
      hashtags: string[];
      scheduledIso: string;
      timezone: string;
      platform: SocialPlatform;
      platforms: Array<'instagram' | 'youtube'>;
      youtubePrivacyStatus: YouTubePrivacyStatus;
      status: 'draft' | 'scheduled';
      mediaAssetIds: string[];
      mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>;
    }>
  ): Promise<ScheduledJobSummary> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update scheduled post.');
    }
    return data.job;
  },

  async sendScheduledJob(
    jobId: string,
    payload: SendJobPayload = {}
  ): Promise<{
    ok: boolean;
    partial?: boolean;
    results?: Record<string, { ok: boolean; resultUrl?: string; platformPostId?: string; error?: string }>;
    job: ScheduledJobSummary;
    resultUrl?: string;
    status: string;
    error?: string;
  }> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.partial) {
      throw new Error(data.error || 'Publishing failed.');
    }
    return data;
  },

  async reconcileScheduledJob(
    jobId: string,
    platform?: 'instagram' | 'youtube'
  ): Promise<{
    ok: boolean;
    outcomes: Record<string, { reconciledPublished: boolean; detail: string }>;
    job: ScheduledJobSummary;
  }> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Reconciliation check failed.');
    }
    return data;
  },

  async retryScheduledJob(
    jobId: string,
    targets?: Array<'instagram' | 'youtube'>
  ): Promise<{ ok: boolean; partial?: boolean; resultUrl?: string; status: string; job?: ScheduledJobSummary }> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.partial) {
      throw new Error(data.error || 'Retry failed.');
    }
    return data;
  },

  async cancelScheduledJob(jobId: string): Promise<void> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to cancel scheduled post.');
    }
  },

  async deleteScheduledJob(jobId: string): Promise<void> {
    const res = await fetch(`/api/scheduled-jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error('Failed to delete scheduled post.');
    }
  },
};
