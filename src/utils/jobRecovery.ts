import {
  IntegrationsApiError,
  integrationsClient,
  PublishHistoryEntry,
  ScheduledJobSummary,
} from '../services/integrationsClient';
import { prepareMediaItemsForPublish } from '../services/mediaPayload';
import {
  DestinationPublishState,
  MediaAsset,
  PublishingLifecycleStatus,
  SocialPlatform,
  YouTubePrivacyStatus,
} from '../types/studio';
import { DEFAULT_PUBLISHING_TIMEZONE } from './publishing';

/**
 * Merge server jobs with Firestore cloudJobs keyed uniquely by postId.
 * Always preserves cloudJobs that are absent on the server while preferring
 * the authoritative server record whenever both exist.
 */
export function mergeServerAndCloudJobs(
  serverJobs: ScheduledJobSummary[],
  cloudJobs: ScheduledJobSummary[]
): ScheduledJobSummary[] {
  const byKey = new Map<string, ScheduledJobSummary>();

  for (const cj of cloudJobs) {
    const key = cj.postId || cj.id;
    byKey.set(key, cj);
  }

  for (const sj of serverJobs) {
    const key = sj.postId || sj.id;
    const prev = byKey.get(key);
    byKey.set(key, {
      ...prev,
      ...sj,
      mediaAssetIds:
        sj.mediaAssetIds && sj.mediaAssetIds.length > 0
          ? sj.mediaAssetIds
          : prev?.mediaAssetIds,
      destinations:
        sj.destinations && sj.destinations.length > 0
          ? sj.destinations
          : prev?.destinations,
    });
  }

  return Array.from(byKey.values());
}

/**
 * Merge server publishHistory with Firestore cloudHistory keyed uniquely by id.
 */
export function mergeServerAndCloudHistory(
  serverHistory: PublishHistoryEntry[],
  cloudHistory: PublishHistoryEntry[]
): PublishHistoryEntry[] {
  const byId = new Map<string, PublishHistoryEntry>();

  for (const ch of cloudHistory) {
    byId.set(ch.id, ch);
  }
  for (const sh of serverHistory) {
    byId.set(sh.id, sh);
  }

  return Array.from(byId.values()).sort((a, b) =>
    (b.timestamp || '').localeCompare(a.timestamp || '')
  );
}

export function isNotFoundError(err: unknown): boolean {
  if (err instanceof IntegrationsApiError) {
    return err.status === 404;
  }
  const msg = err instanceof Error ? err.message : String(err || '');
  return /\b404\b|not found/i.test(msg);
}

export interface RehydrateJobInput {
  workspaceId: string;
  postId: string;
  jobId?: string;
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
  mediaCount?: number;
  status?: PublishingLifecycleStatus;
  attempts?: number;
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  preEncodedMediaItems?: Array<{ filename: string; mimeType: string; base64Data: string }>;
}

/**
 * Safely restores a missing backend scheduled-job record from Firestore / local
 * metadata and IndexedDB media (when available), without discarding the post if
 * binary media cannot be recovered.
 */
export async function rehydrateBackendJob(
  input: RehydrateJobInput,
  mediaAssets: MediaAsset[]
): Promise<ScheduledJobSummary> {
  const normalizedPostId =
    input.postId || (input.jobId ? input.jobId.replace(/^job-/, '') : `post-${Date.now()}`);

  let mediaItems = input.preEncodedMediaItems || [];
  if (mediaItems.length === 0 && input.mediaAssetIds && input.mediaAssetIds.length > 0) {
    mediaItems = await prepareMediaItemsForPublish(
      input.mediaAssetIds,
      mediaAssets,
      input.platform
    ).catch(() => []);
  }

  const preservedStatus: PublishingLifecycleStatus =
    input.status && input.status !== 'publishing' ? input.status : 'scheduled';

  return integrationsClient.syncScheduledJob({
    workspaceId: input.workspaceId,
    postId: normalizedPostId,
    title: input.title || 'Scheduled Post',
    platform: input.platform,
    platforms: input.platforms,
    destinations: input.destinations,
    caption: input.caption || '',
    hashtags: input.hashtags || [],
    youtubePrivacyStatus: input.youtubePrivacyStatus,
    scheduledIso: input.scheduledIso || new Date().toISOString(),
    timezone: input.timezone || DEFAULT_PUBLISHING_TIMEZONE,
    campaignId: input.campaignId,
    mediaAssetIds: input.mediaAssetIds,
    preservedMediaCount:
      mediaItems.length > 0 ? mediaItems.length : input.mediaCount || input.mediaAssetIds?.length || 0,
    status: preservedStatus,
    attempts: input.attempts,
    publishedAt: input.publishedAt,
    platformPostId: input.platformPostId,
    resultUrl: input.resultUrl,
    error: input.error,
    mediaItems,
  });
}
