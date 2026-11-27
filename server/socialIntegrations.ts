import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import {
  decryptSecret,
  EncryptedPayload,
  encryptSecret,
  getDataDirPath,
  getTokenCryptoDiagnostics,
  isValidEncryptedPayload,
  TokenCryptoError,
} from './tokenCrypto';
import {
  type AuthenticatedRequest,
  isProductionRuntime,
  requireServerOperator,
} from './aiProviders/authMiddleware';
import {
  createSignedStorageUrl,
  downloadStorageObjectToBuffer,
  getSafeStorageOwnerPrefix,
  getSupabaseAdmin,
  isSupabaseConfigured,
  listStorageObjects,
  removeStorageObjects,
  uploadToSupabaseBucket,
} from './supabase/client';
import {
  assertSyncOk,
  callSupabaseRpc,
  deleteRowFromSupabase,
  fetchRowsFromSupabase,
  SupabasePersistenceError,
  syncRowsToSupabase,
} from './supabase/syncHelper';
import {
  authAndIntegrationMutationLimiter,
  integrationReadLimiter,
} from './rateLimiters';

export type ConnectedPlatform = 'youtube' | 'instagram';
export type SocialFormat = 'youtube-shorts' | 'instagram-reel' | 'instagram-carousel' | 'instagram-feed';
export type YouTubePrivacyStatus = 'public' | 'unlisted' | 'private';

export type JobLifecycleStatus =
  | 'draft'
  | 'scheduled'
  | 'ready-to-send'
  | 'publishing'
  | 'published'
  | 'partially-published'
  | 'failed'
  | 'cancelled';

export interface DestinationPublishState {
  platform: ConnectedPlatform;
  format: SocialFormat;
  status: 'scheduled' | 'ready-to-send' | 'publishing' | 'published' | 'failed' | 'cancelled';
  attempts: number;
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  inFlightId?: string;
  needsReconciliation?: boolean;
  youtubeTitle?: string;
  youtubeDescription?: string;
  youtubeTags?: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  instagramCaption?: string;
}

export interface StoredMediaRef {
  index: number;
  filename: string;
  mimeType: string;
  storageBucket: 'social-media';
  objectPath: string;
  byteLength: number;
}

interface OAuthStateEntry {
  ownerUid: string;
  workspaceId: string;
  platform: ConnectedPlatform;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkspaceConnection {
  ownerUid: string;
  workspaceId: string;
  platform: ConnectedPlatform;
  accountId: string;
  accountName: string;
  accountHandle?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: 'SYSTEM_USER' | 'USER' | 'GOOGLE_OAUTH';
  expiresAt?: number;
  lastError?: string;
  connectedAt: string;
  updatedAt: string;
}

interface StoredConnectionRecord {
  ownerUid?: string;
  workspaceId: string;
  platform: ConnectedPlatform;
  accountId: string;
  accountName: string;
  accountHandle?: string;
  encryptedAccessToken: EncryptedPayload;
  encryptedRefreshToken?: EncryptedPayload;
  tokenType?: 'SYSTEM_USER' | 'USER' | 'GOOGLE_OAUTH';
  expiresAt?: number;
  lastError?: string;
  connectedAt: string;
  updatedAt: string;
}

interface TempMediaEntry {
  buffer: Buffer;
  mimeType: string;
  expiresAt: number;
}

export interface ScheduledPublishJob {
  id: string;
  workspaceId: string;
  postId: string;
  title: string;
  platform: SocialFormat;
  platforms?: ConnectedPlatform[];
  destinations: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledIso: string;
  timezone: string;
  campaignId?: string;
  mediaAssetIds?: string[];
  preservedMediaCount?: number;
  publicBaseUrl?: string;
  mediaRefs?: StoredMediaRef[];
  mediaItems: Array<{
    filename: string;
    mimeType: string;
    base64Data: string;
  }>;
  status: JobLifecycleStatus;
  attempts: number;
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishHistoryEntry {
  id: string;
  workspaceId: string;
  postId: string;
  jobId?: string;
  title: string;
  platform: SocialFormat;
  mode: 'manual-send' | 'immediate' | 'retry';
  status: 'published' | 'failed';
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  timestamp: string;
}

interface DirectPublishedRecord {
  platformPostId?: string;
  resultUrl?: string;
  publishedAt: string;
}

interface VaultSnapshot {
  connections: Record<string, StoredConnectionRecord>;
  scheduledJobs: Record<string, ScheduledPublishJob>;
  publishHistory: PublishHistoryEntry[];
  pendingStates: Record<string, OAuthStateEntry>;
  publishedDirectKeys?: Record<string, DirectPublishedRecord>;
}

const META_GRAPH_HOST = 'https://graph.facebook.com';
const META_GRAPH_VERSION = 'v21.0';
const VAULT_FILE = path.join(getDataDirPath(), 'integrations-vault.json');
const TEMP_IG_MEDIA_TTL_SECONDS = 3600;
const STALE_TEMP_IG_CUTOFF_MS = 90 * 60 * 1000;

// Non-production dev fallbacks ONLY when Supabase is unconfigured
const devFallbackStates = new Map<string, OAuthStateEntry>();
const connections = new Map<string, WorkspaceConnection>(); // key: `${ownerUid}::${workspaceId}::${platform}`
const legacyLocalConnections = new Map<string, StoredConnectionRecord>(); // Read-only pre-Phase-1 vault entries
const connectionDecryptionErrors = new Map<string, { code: string; message: string }>();
const devTempMediaStore = new Map<string, TempMediaEntry>(); // Dev fallback ONLY when !isSupabaseConfigured()
const devScheduledJobs = new Map<string, ScheduledPublishJob>(); // Dev fallback ONLY when !isSupabaseConfigured()
const devPublishHistory: PublishHistoryEntry[] = []; // Dev fallback ONLY when !isSupabaseConfigured()
const devPublishedDirectKeys = new Map<string, DirectPublishedRecord>();
const devActivePublishingKeys = new Set<string>();

function handleSocialError(res: Response, err: unknown, fallbackMsg: string) {
  if (err instanceof SupabasePersistenceError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      retriable: err.retriable,
    });
  }
  const statusCode = Number((err as { statusCode?: number } | undefined)?.statusCode || 500);
  const msg = err instanceof Error ? err.message : fallbackMsg;
  return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ error: msg });
}

function isDueNow(scheduledIso: string, nowMs: number = Date.now()): boolean {
  const targetMs = Date.parse(scheduledIso);
  return !Number.isNaN(targetMs) && targetMs <= nowMs;
}

function buildDefaultDestinations(opts: {
  platform: SocialFormat;
  platforms?: ConnectedPlatform[];
  title: string;
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledIso: string;
  statusHint?: string;
}): DestinationPublishState[] {
  const requestedPlatforms: ConnectedPlatform[] =
    opts.platforms && opts.platforms.length > 0
      ? Array.from(new Set(opts.platforms))
      : [opts.platform === 'youtube-shorts' ? 'youtube' : 'instagram'];

  const baseStatus: DestinationPublishState['status'] =
    opts.statusHint === 'cancelled'
      ? 'cancelled'
      : opts.statusHint === 'published'
        ? 'published'
        : opts.statusHint === 'failed'
          ? 'failed'
          : isDueNow(opts.scheduledIso)
            ? 'ready-to-send'
            : 'scheduled';

  return requestedPlatforms.map((plat) => {
    if (plat === 'youtube') {
      return {
        platform: 'youtube',
        format: 'youtube-shorts',
        status: baseStatus,
        attempts: 0,
        youtubeTitle: opts.title,
        youtubeDescription: opts.caption,
        youtubeTags: opts.hashtags,
        youtubePrivacyStatus: opts.youtubePrivacyStatus || 'public',
      };
    }
    return {
      platform: 'instagram',
      format: opts.platform === 'youtube-shorts' ? 'instagram-reel' : opts.platform,
      status: baseStatus,
      attempts: 0,
      instagramCaption: opts.caption,
    };
  });
}

function computeEffectiveStatus(job: ScheduledPublishJob, nowMs: number = Date.now()): JobLifecycleStatus {
  if (job.status === 'draft') return 'draft';
  if (job.status === 'cancelled') return 'cancelled';

  const dests = job.destinations || [];
  if (dests.length === 0) {
    if (job.status === 'published' || job.status === 'failed' || job.status === 'publishing') {
      return job.status;
    }
    return isDueNow(job.scheduledIso, nowMs) ? 'ready-to-send' : 'scheduled';
  }

  if (dests.some((d) => d.status === 'publishing')) {
    return 'publishing';
  }
  const publishedCount = dests.filter((d) => d.status === 'published').length;
  if (publishedCount === dests.length) {
    return 'published';
  }
  if (publishedCount > 0 && publishedCount < dests.length) {
    return 'partially-published';
  }
  if (dests.every((d) => d.status === 'cancelled')) {
    return 'cancelled';
  }
  if (dests.some((d) => d.status === 'failed')) {
    return 'failed';
  }
  if (isDueNow(job.scheduledIso, nowMs)) {
    return 'ready-to-send';
  }
  return 'scheduled';
}

function normalizeDestinationsForRead(job: ScheduledPublishJob, nowMs: number = Date.now()): DestinationPublishState[] {
  const due = isDueNow(job.scheduledIso, nowMs);
  return (job.destinations || []).map((d) => {
    if (d.status === 'scheduled' && due && job.status !== 'draft' && job.status !== 'cancelled') {
      return { ...d, status: 'ready-to-send' };
    }
    return d;
  });
}

async function serializeJobSummary(job: ScheduledPublishJob) {
  const nowMs = Date.now();
  const destinations = normalizeDestinationsForRead(job, nowMs);
  const status = computeEffectiveStatus({ ...job, destinations }, nowMs);
  const { mediaItems, mediaRefs, ...rest } = job;
  const refs = Array.isArray(mediaRefs) ? mediaRefs : [];

  let mediaPreviews: Array<{ index: number; filename: string; mimeType: string; url: string }> = [];
  if (refs.length > 0 && isSupabaseConfigured()) {
    mediaPreviews = await Promise.all(
      refs.map(async (ref) => {
        const signed = await createSignedStorageUrl(ref.storageBucket || 'social-media', ref.objectPath, 3600);
        return {
          index: ref.index,
          filename: ref.filename,
          mimeType: ref.mimeType,
          url: signed.ok
            ? signed.signedUrl
            : `/api/scheduled-jobs/${encodeURIComponent(job.id)}/media/${ref.index}`,
        };
      })
    );
  } else {
    mediaPreviews = (mediaItems || []).map((m, index) => ({
      index,
      filename: m.filename,
      mimeType: m.mimeType,
      url: `/api/scheduled-jobs/${encodeURIComponent(job.id)}/media/${index}`,
    }));
  }

  return {
    ...rest,
    status,
    destinations,
    mediaCount:
      refs.length > 0
        ? refs.length
        : mediaItems.length > 0
          ? mediaItems.length
          : (job.preservedMediaCount ?? 0),
    mediaPreviews,
  };
}

function loadVaultFromDisk() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return;
    const raw = fs.readFileSync(VAULT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VaultSnapshot>;

    if (parsed.connections) {
      for (const [key, rec] of Object.entries(parsed.connections)) {
        if (!rec || !rec.workspaceId || (rec.platform !== 'youtube' && rec.platform !== 'instagram')) {
          continue;
        }
        legacyLocalConnections.set(`${rec.workspaceId}:${rec.platform}`, rec);
        if (rec.ownerUid) {
          try {
            const accessToken = decryptSecret(rec.encryptedAccessToken);
            const refreshToken = rec.encryptedRefreshToken
              ? decryptSecret(rec.encryptedRefreshToken)
              : undefined;
            if (accessToken.trim()) {
              connections.set(connKey(rec.ownerUid, rec.workspaceId, rec.platform), {
                ownerUid: rec.ownerUid,
                workspaceId: rec.workspaceId,
                platform: rec.platform,
                accountId: rec.accountId,
                accountName: rec.accountName,
                accountHandle: rec.accountHandle,
                accessToken,
                refreshToken,
                tokenType: rec.tokenType,
                expiresAt: rec.expiresAt,
                lastError: rec.lastError,
                connectedAt: rec.connectedAt,
                updatedAt: rec.updatedAt || rec.connectedAt,
              });
            }
          } catch (err) {
            const code = err instanceof TokenCryptoError ? err.code : 'DECRYPTION_FAILED';
            const msg = err instanceof Error ? err.message : 'Unable to decrypt stored OAuth connection.';
            connectionDecryptionErrors.set(connKey(rec.ownerUid, rec.workspaceId, rec.platform), {
              code,
              message: msg,
            });
            console.warn(`Could not decrypt stored connection ${key}:`, msg);
          }
        }
      }
    }

    if (parsed.scheduledJobs) {
      for (const [id, rawJob] of Object.entries(parsed.scheduledJobs)) {
        const legacyStatus = (rawJob as { status?: string }).status || 'scheduled';
        const migratedStatus: JobLifecycleStatus =
          legacyStatus === 'pending'
            ? isDueNow(rawJob.scheduledIso)
              ? 'ready-to-send'
              : 'scheduled'
            : legacyStatus === 'publishing'
              ? 'failed'
              : (legacyStatus as JobLifecycleStatus);

        const rawDests = Array.isArray(rawJob.destinations) && rawJob.destinations.length > 0
          ? rawJob.destinations
          : buildDefaultDestinations({
              platform: rawJob.platform,
              platforms: rawJob.platforms,
              title: rawJob.title,
              caption: rawJob.caption,
              hashtags: rawJob.hashtags || [],
              youtubePrivacyStatus: rawJob.youtubePrivacyStatus,
              scheduledIso: rawJob.scheduledIso,
              statusHint: migratedStatus,
            });

        const recoveredDests: DestinationPublishState[] = rawDests.map((d) => {
          if (d.status === 'publishing') {
            return {
              ...d,
              status: 'failed',
              needsReconciliation: true,
              error:
                'Connection or server interrupted while publishing was in progress. Reconcile platform status before retrying to avoid duplicate posts.',
            };
          }
          return d;
        });

        const normalizedJob: ScheduledPublishJob = {
          ...rawJob,
          mediaItems: Array.isArray(rawJob.mediaItems) ? rawJob.mediaItems : [],
          timezone: rawJob.timezone || 'Africa/Lagos',
          destinations: recoveredDests,
          attempts: rawJob.attempts ?? 0,
          status: migratedStatus,
          error:
            legacyStatus === 'publishing'
              ? 'Server interrupted during publishing. Verify destination status before retrying.'
              : rawJob.error,
        };
        normalizedJob.status = computeEffectiveStatus(normalizedJob);
        devScheduledJobs.set(id, normalizedJob);
      }
    }

    if (Array.isArray(parsed.publishHistory)) {
      devPublishHistory.push(...parsed.publishHistory.slice(0, 200));
    }

    if (parsed.publishedDirectKeys) {
      for (const [k, v] of Object.entries(parsed.publishedDirectKeys)) {
        devPublishedDirectKeys.set(k, v);
      }
    }
  } catch (err) {
    console.warn('Failed to load integrations vault from disk:', err);
  }
}

function saveVaultToDisk() {
  if (isProductionRuntime() || isSupabaseConfigured()) {
    return;
  }
  try {
    const connObj: Record<string, StoredConnectionRecord> = {};
    for (const [legacyScope, rec] of legacyLocalConnections.entries()) {
      const storageKey = rec.ownerUid ? `${rec.ownerUid}::${legacyScope}` : legacyScope;
      connObj[storageKey] = rec;
    }
    for (const [scopedKey, conn] of connections.entries()) {
      if (!conn.accessToken || !conn.accessToken.trim()) continue;
      try {
        connObj[scopedKey] = {
          ownerUid: conn.ownerUid,
          workspaceId: conn.workspaceId,
          platform: conn.platform,
          accountId: conn.accountId,
          accountName: conn.accountName,
          accountHandle: conn.accountHandle,
          encryptedAccessToken: encryptSecret(conn.accessToken),
          encryptedRefreshToken: conn.refreshToken ? encryptSecret(conn.refreshToken) : undefined,
          tokenType: conn.tokenType,
          expiresAt: conn.expiresAt,
          lastError: conn.lastError,
          connectedAt: conn.connectedAt,
          updatedAt: conn.updatedAt,
        };
      } catch {
        // Never overwrite existing vault connection if encryption fails
      }
    }

    const jobsObj: Record<string, ScheduledPublishJob> = {};
    for (const [id, job] of devScheduledJobs.entries()) {
      jobsObj[id] = job;
    }

    const directObj: Record<string, DirectPublishedRecord> = {};
    for (const [k, v] of devPublishedDirectKeys.entries()) {
      directObj[k] = v;
    }

    const snapshot: VaultSnapshot = {
      connections: connObj,
      scheduledJobs: jobsObj,
      publishHistory: devPublishHistory.slice(0, 200),
      pendingStates: {},
      publishedDirectKeys: directObj,
    };

    const tmpPath = `${VAULT_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(tmpPath, VAULT_FILE);
  } catch (err) {
    console.warn('Failed to persist integrations vault:', err);
  }
}

loadVaultFromDisk();

interface SupabaseScheduledJobRow {
  id: string;
  owner_uid: string;
  workspace_id: string;
  post_id: string;
  title: string;
  platform: SocialFormat;
  platforms_json?: ConnectedPlatform[] | null;
  destinations_json?: DestinationPublishState[] | null;
  caption: string;
  hashtags_json?: string[] | null;
  youtube_privacy_status?: YouTubePrivacyStatus | null;
  scheduled_iso: string;
  timezone?: string | null;
  campaign_id?: string | null;
  media_asset_ids_json?: string[] | null;
  preserved_media_count?: number | null;
  media_refs_json?: StoredMediaRef[] | null;
  public_base_url?: string | null;
  status: JobLifecycleStatus;
  attempts: number;
  published_at?: string | null;
  platform_post_id?: string | null;
  result_url?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

interface SupabasePublishHistoryRow {
  id: string;
  owner_uid: string;
  workspace_id: string;
  post_id: string;
  job_id?: string | null;
  title: string;
  platform: SocialFormat;
  mode: PublishHistoryEntry['mode'];
  status: PublishHistoryEntry['status'];
  platform_post_id?: string | null;
  result_url?: string | null;
  error?: string | null;
  timestamp: string;
}

interface SupabaseIdempotencyRow {
  owner_uid: string;
  workspace_id: string;
  post_id: string;
  platform: ConnectedPlatform;
  job_id?: string | null;
  status: 'publishing' | 'published' | 'failed' | 'needs_reconciliation';
  in_flight_id?: string | null;
  platform_post_id?: string | null;
  result_url?: string | null;
  last_error?: string | null;
  attempts: number;
  published_at?: string | null;
}

function hydrateJobFromRow(
  row: SupabaseScheduledJobRow,
  idempotencyRows: SupabaseIdempotencyRow[] = []
): ScheduledPublishJob {
  const baseDests =
    Array.isArray(row.destinations_json) && row.destinations_json.length > 0
      ? row.destinations_json
      : buildDefaultDestinations({
          platform: row.platform,
          platforms: Array.isArray(row.platforms_json) ? row.platforms_json : undefined,
          title: row.title,
          caption: row.caption,
          hashtags: Array.isArray(row.hashtags_json) ? row.hashtags_json : [],
          youtubePrivacyStatus: row.youtube_privacy_status || undefined,
          scheduledIso: row.scheduled_iso,
          statusHint: row.status,
        });

  const mergedDests: DestinationPublishState[] = baseDests.map((d) => {
    const idem = idempotencyRows.find(
      (r) =>
        r.workspace_id === row.workspace_id &&
        (r.post_id === row.post_id || r.job_id === row.id) &&
        r.platform === d.platform
    );
    if (!idem) return d;
    if (idem.status === 'published') {
      return {
        ...d,
        status: 'published',
        platformPostId: idem.platform_post_id || d.platformPostId,
        resultUrl: idem.result_url || d.resultUrl,
        publishedAt: idem.published_at || d.publishedAt,
        needsReconciliation: false,
        error: undefined,
      };
    }
    if (idem.status === 'needs_reconciliation') {
      return {
        ...d,
        status: 'failed',
        inFlightId: idem.in_flight_id || d.inFlightId,
        needsReconciliation: true,
        error: idem.last_error || d.error,
      };
    }
    return d;
  });

  const mediaRefs = Array.isArray(row.media_refs_json) ? row.media_refs_json : [];
  const job: ScheduledPublishJob = {
    id: row.id,
    workspaceId: row.workspace_id,
    postId: row.post_id,
    title: row.title,
    platform: row.platform,
    platforms: Array.isArray(row.platforms_json) ? row.platforms_json : undefined,
    destinations: mergedDests,
    caption: row.caption || '',
    hashtags: Array.isArray(row.hashtags_json) ? row.hashtags_json : [],
    youtubePrivacyStatus: row.youtube_privacy_status || undefined,
    scheduledIso: row.scheduled_iso,
    timezone: row.timezone || 'Africa/Lagos',
    campaignId: row.campaign_id || undefined,
    mediaAssetIds: Array.isArray(row.media_asset_ids_json) ? row.media_asset_ids_json : [],
    preservedMediaCount:
      mediaRefs.length > 0 ? mediaRefs.length : Number(row.preserved_media_count || 0),
    publicBaseUrl: row.public_base_url || undefined,
    mediaRefs,
    mediaItems: [],
    status: row.status,
    attempts: Number(row.attempts || 0),
    publishedAt: row.published_at || undefined,
    platformPostId: row.platform_post_id || undefined,
    resultUrl: row.result_url || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  job.status = computeEffectiveStatus(job);
  return job;
}

async function uploadJobMediaItemsToStorage(
  ownerUid: string,
  jobId: string,
  mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>
): Promise<StoredMediaRef[]> {
  const refs: StoredMediaRef[] = [];
  for (let idx = 0; idx < mediaItems.length; idx += 1) {
    const item = mediaItems[idx];
    const buf = Buffer.from(item.base64Data, 'base64');
    const safeFilename =
      (item.filename || `media-${idx}`).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || `media-${idx}`;
    const up = await uploadToSupabaseBucket({
      bucket: 'social-media',
      ownerUid,
      relativePath: `scheduled-jobs/${jobId}/${idx}-${safeFilename}`,
      buffer: buf,
      contentType: item.mimeType || 'application/octet-stream',
      upsert: true,
    });
    if (!up.ok) {
      throw new SupabasePersistenceError({
        ok: false,
        code: 'SUPABASE_WRITE_FAILED',
        message: `Failed to store scheduled post media #${idx + 1} in Supabase Storage: ${up.error}`,
        retriable: true,
        statusCode: 502,
      });
    }
    refs.push({
      index: idx,
      filename: item.filename || safeFilename,
      mimeType: item.mimeType || 'application/octet-stream',
      storageBucket: 'social-media',
      objectPath: up.path,
      byteLength: buf.length,
    });
  }
  return refs;
}

async function persistScheduledJobAuthoritative(
  ownerUid: string,
  job: ScheduledPublishJob
): Promise<ScheduledPublishJob> {
  job.status = computeEffectiveStatus(job);
  job.updatedAt = new Date().toISOString();

  if (isSupabaseConfigured()) {
    if (job.mediaItems && job.mediaItems.length > 0 && (!job.mediaRefs || job.mediaRefs.length === 0)) {
      job.mediaRefs = await uploadJobMediaItemsToStorage(ownerUid, job.id, job.mediaItems);
      job.preservedMediaCount = job.mediaRefs.length;
    }

    const row = {
      id: job.id,
      owner_uid: ownerUid,
      workspace_id: job.workspaceId,
      post_id: job.postId,
      title: job.title,
      platform: job.platform,
      platforms_json: job.platforms || [],
      destinations_json: job.destinations,
      caption: job.caption,
      hashtags_json: job.hashtags || [],
      youtube_privacy_status: job.youtubePrivacyStatus || null,
      scheduled_iso: job.scheduledIso,
      timezone: job.timezone || 'Africa/Lagos',
      campaign_id: job.campaignId || null,
      media_asset_ids_json: job.mediaAssetIds || [],
      preserved_media_count:
        job.mediaRefs && job.mediaRefs.length > 0
          ? job.mediaRefs.length
          : job.preservedMediaCount ?? 0,
      media_refs_json: job.mediaRefs || [],
      public_base_url: job.publicBaseUrl || null,
      status: job.status,
      attempts: job.attempts || 0,
      published_at: job.publishedAt || null,
      platform_post_id: job.platformPostId || null,
      result_url: job.resultUrl || null,
      error: job.error || null,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    };

    assertSyncOk(await syncRowsToSupabase('scheduled_jobs', [row], 'owner_uid,id'));
    return job;
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production for scheduled job persistence.',
      retriable: false,
      statusCode: 503,
    });
  }

  devScheduledJobs.set(job.id, job);
  saveVaultToDisk();
  return job;
}

async function listScheduledJobsAuthoritative(
  ownerUid: string,
  workspaceId?: string
): Promise<ScheduledPublishJob[]> {
  if (isSupabaseConfigured()) {
    const filters = workspaceId ? { workspace_id: workspaceId } : undefined;
    const [jobRows, idemRows] = await Promise.all([
      fetchRowsFromSupabase<SupabaseScheduledJobRow>(
        'scheduled_jobs',
        ownerUid,
        { column: 'updated_at', ascending: false },
        filters
      ).then((r) => assertSyncOk(r) || []),
      fetchRowsFromSupabase<SupabaseIdempotencyRow>(
        'publish_idempotency',
        ownerUid,
        undefined,
        filters
      ).then((r) => assertSyncOk(r) || []),
    ]);
    return jobRows.map((row) => hydrateJobFromRow(row, idemRows));
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production to list scheduled jobs.',
      retriable: false,
      statusCode: 503,
    });
  }

  return Array.from(devScheduledJobs.values())
    .filter((j) => !workspaceId || j.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function getScheduledJobAuthoritative(
  ownerUid: string,
  jobId: string
): Promise<ScheduledPublishJob | null> {
  if (isSupabaseConfigured()) {
    const rows =
      assertSyncOk(
        await fetchRowsFromSupabase<SupabaseScheduledJobRow>('scheduled_jobs', ownerUid, undefined, {
          id: jobId,
        })
      ) || [];
    const row = rows[0];
    if (!row) return null;
    const idemRows =
      assertSyncOk(
        await fetchRowsFromSupabase<SupabaseIdempotencyRow>(
          'publish_idempotency',
          ownerUid,
          undefined,
          { workspace_id: row.workspace_id, post_id: row.post_id }
        )
      ) || [];
    return hydrateJobFromRow(row, idemRows);
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production to load scheduled jobs.',
      retriable: false,
      statusCode: 503,
    });
  }

  return devScheduledJobs.get(jobId) || null;
}

async function resolveJobMediaBuffers(
  job: ScheduledPublishJob
): Promise<Array<{ buffer: Buffer; mimeType: string; filename: string }>> {
  if (job.mediaItems && job.mediaItems.length > 0) {
    return job.mediaItems.map((m) => ({
      buffer: Buffer.from(m.base64Data, 'base64'),
      mimeType: m.mimeType,
      filename: m.filename,
    }));
  }

  if (job.mediaRefs && job.mediaRefs.length > 0 && isSupabaseConfigured()) {
    const resolved: Array<{ buffer: Buffer; mimeType: string; filename: string }> = [];
    for (const ref of job.mediaRefs) {
      const dl = await downloadStorageObjectToBuffer(ref.storageBucket || 'social-media', ref.objectPath);
      if (!dl.ok) {
        throw new Error(`Failed to fetch scheduled post media from Supabase Storage: ${dl.error}`);
      }
      resolved.push({
        buffer: dl.buffer,
        mimeType: ref.mimeType || dl.mimeType || 'application/octet-stream',
        filename: ref.filename,
      });
    }
    return resolved;
  }

  return [];
}

async function recordHistoryAuthoritative(
  ownerUid: string,
  entry: PublishHistoryEntry
): Promise<void> {
  if (isSupabaseConfigured()) {
    assertSyncOk(
      await syncRowsToSupabase(
        'publish_history',
        [
          {
            id: entry.id,
            owner_uid: ownerUid,
            workspace_id: entry.workspaceId,
            post_id: entry.postId,
            job_id: entry.jobId || null,
            title: entry.title,
            platform: entry.platform,
            mode: entry.mode,
            status: entry.status,
            platform_post_id: entry.platformPostId || null,
            result_url: entry.resultUrl || null,
            error: entry.error || null,
            timestamp: entry.timestamp,
          },
        ],
        'owner_uid,id'
      )
    );
    return;
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production to record publish history.',
      retriable: false,
      statusCode: 503,
    });
  }

  devPublishHistory.unshift(entry);
  if (devPublishHistory.length > 200) devPublishHistory.length = 200;
  saveVaultToDisk();
}

async function listPublishHistoryAuthoritative(
  ownerUid: string,
  workspaceId?: string
): Promise<PublishHistoryEntry[]> {
  if (isSupabaseConfigured()) {
    const rows =
      assertSyncOk(
        await fetchRowsFromSupabase<SupabasePublishHistoryRow>(
          'publish_history',
          ownerUid,
          { column: 'timestamp', ascending: false },
          workspaceId ? { workspace_id: workspaceId } : undefined
        )
      ) || [];
    return rows.map((h) => ({
      id: h.id,
      workspaceId: h.workspace_id,
      postId: h.post_id,
      jobId: h.job_id || undefined,
      title: h.title,
      platform: h.platform,
      mode: h.mode,
      status: h.status,
      platformPostId: h.platform_post_id || undefined,
      resultUrl: h.result_url || undefined,
      error: h.error || undefined,
      timestamp: h.timestamp,
    }));
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production to read publish history.',
      retriable: false,
      statusCode: 503,
    });
  }

  return devPublishHistory.filter((h) => !workspaceId || h.workspaceId === workspaceId);
}

function getAppBaseUrl(req?: Request): string {
  if (req) {
    const forwardedHost = (req.get('x-forwarded-host') || req.get('host') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (/^[a-z0-9.-]+\.run\.app$/.test(forwardedHost)) {
      const proto = (req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      return `${proto === 'http' ? 'http' : 'https'}://${forwardedHost}`;
    }
  }
  const envUrl = process.env.APP_URL;
  if (envUrl && envUrl !== 'MY_APP_URL' && envUrl.startsWith('http')) {
    return envUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}

function getInstagramEnv() {
  const appId = process.env.META_APP_ID?.trim() || '';
  const appSecret = process.env.META_APP_SECRET?.trim() || '';
  const configId = process.env.META_LOGIN_CONFIG_ID?.trim() || '';
  const missingVars: string[] = [];
  if (!appId) missingVars.push('META_APP_ID');
  if (!appSecret) missingVars.push('META_APP_SECRET');
  if (!configId) missingVars.push('META_LOGIN_CONFIG_ID');
  return {
    appId,
    appSecret,
    configId,
    missingVars,
    configured: missingVars.length === 0,
  };
}

function getYouTubeEnv() {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim() || '';
  const missingVars: string[] = [];
  if (!clientId) missingVars.push('YOUTUBE_CLIENT_ID');
  if (!clientSecret) missingVars.push('YOUTUBE_CLIENT_SECRET');
  return { clientId, clientSecret, missingVars, configured: missingVars.length === 0 };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function connKey(ownerUid: string, workspaceId: string, platform: ConnectedPlatform): string {
  return `${ownerUid}::${workspaceId}::${platform}`;
}

function resolveRequiredOwnerUid(req: Request): string {
  const ownerUid = (req as AuthenticatedRequest).operatorContext?.ownerScopeKey?.trim();
  if (!ownerUid) {
    const err = new Error('Authenticated owner identity could not be resolved.');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return ownerUid;
}

function hashOAuthState(rawState: string): string {
  return crypto.createHash('sha256').update(rawState, 'utf8').digest('hex');
}

function cleanupExpired() {
  const now = Date.now();
  for (const [k, v] of devFallbackStates.entries()) {
    if (v.expiresAt <= now) {
      devFallbackStates.delete(k);
    }
  }
  for (const [k, v] of devTempMediaStore.entries()) {
    if (now > v.expiresAt) devTempMediaStore.delete(k);
  }
}

export async function createAndPersistOAuthState(opts: {
  ownerUid: string;
  workspaceId: string;
  platform: ConnectedPlatform;
  redirectUri: string;
  ttlMs?: number;
}): Promise<string> {
  if (!opts.ownerUid || !opts.ownerUid.trim()) {
    throw new Error('Cannot create OAuth state without a verified owner identity.');
  }
  const ttlMs = Math.max(60_000, opts.ttlMs ?? 10 * 60 * 1000);
  const rawState = crypto.randomBytes(32).toString('hex');
  const stateHash = hashOAuthState(rawState);
  const expiresAtMs = Date.now() + ttlMs;
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  const supa = getSupabaseAdmin();
  if (supa) {
    const purgeCutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supa.from('oauth_states').delete().lt('expires_at', purgeCutoffIso);

    const { error } = await supa.from('oauth_states').insert({
      state_hash: stateHash,
      owner_uid: opts.ownerUid,
      workspace_id: opts.workspaceId,
      platform: opts.platform,
      redirect_uri: opts.redirectUri,
      expires_at: expiresAtIso,
    });
    if (error) {
      throw new Error(
        `Failed to persist OAuth state in Supabase (${error.message}). Ensure supabase/migrations/003_oauth_states.sql has been applied.`
      );
    }
    return rawState;
  }

  if (isProductionRuntime()) {
    throw new Error(
      'Supabase must be configured in production for OAuth state persistence.'
    );
  }

  cleanupExpired();
  devFallbackStates.set(stateHash, {
    ownerUid: opts.ownerUid,
    workspaceId: opts.workspaceId,
    platform: opts.platform,
    redirectUri: opts.redirectUri,
    createdAt: Date.now(),
    expiresAt: expiresAtMs,
  });
  return rawState;
}

export async function consumeOAuthState(
  rawState: string,
  expectedPlatform: ConnectedPlatform
): Promise<
  | {
      ok: true;
      ownerUid: string;
      workspaceId: string;
      platform: ConnectedPlatform;
      redirectUri: string;
    }
  | { ok: false; reason: string; statusCode?: number }
> {
  if (!rawState || typeof rawState !== 'string' || rawState.trim().length < 16) {
    return { ok: false, reason: 'Invalid or missing OAuth state.', statusCode: 400 };
  }
  const stateHash = hashOAuthState(rawState.trim());
  const supa = getSupabaseAdmin();

  if (supa) {
    const nowIso = new Date().toISOString();
    const { data, error } = await supa
      .from('oauth_states')
      .update({ consumed_at: nowIso })
      .eq('state_hash', stateHash)
      .eq('platform', expectedPlatform)
      .is('consumed_at', null)
      .gt('expires_at', nowIso)
      .select('owner_uid, workspace_id, platform, redirect_uri, expires_at, consumed_at');

    if (error) {
      throw new Error(`Failed to verify OAuth state in Supabase: ${error.message}`);
    }
    if (!Array.isArray(data) || data.length !== 1) {
      return {
        ok: false,
        reason: 'Invalid, expired, mismatched, or already-used OAuth state.',
        statusCode: 400,
      };
    }

    const row = data[0] as {
      owner_uid?: string;
      workspace_id?: string;
      platform?: string;
      redirect_uri?: string;
    };
    if (!row.owner_uid || !row.workspace_id || !row.redirect_uri || row.platform !== expectedPlatform) {
      return {
        ok: false,
        reason: 'OAuth state record is incomplete or mismatched.',
        statusCode: 400,
      };
    }
    return {
      ok: true,
      ownerUid: row.owner_uid,
      workspaceId: row.workspace_id,
      platform: expectedPlatform,
      redirectUri: row.redirect_uri,
    };
  }

  if (isProductionRuntime()) {
    return {
      ok: false,
      reason: 'Supabase is required in production to verify OAuth state.',
      statusCode: 503,
    };
  }

  const entry = devFallbackStates.get(stateHash);
  devFallbackStates.delete(stateHash);
  if (!entry || entry.platform !== expectedPlatform || entry.expiresAt <= Date.now()) {
    return {
      ok: false,
      reason: 'Invalid, expired, mismatched, or already-used OAuth state.',
      statusCode: 400,
    };
  }
  return {
    ok: true,
    ownerUid: entry.ownerUid,
    workspaceId: entry.workspaceId,
    platform: entry.platform,
    redirectUri: entry.redirectUri,
  };
}

export async function getConnectionForOwner(
  ownerUid: string,
  workspaceId: string,
  platform: ConnectedPlatform
): Promise<{
  connection: WorkspaceConnection | null;
  decryptionError?: string;
  encryptionErrorCode?: string;
}> {
  if (!ownerUid || !ownerUid.trim()) {
    throw new Error('Authenticated owner identity is required to read OAuth connections.');
  }
  const key = connKey(ownerUid, workspaceId, platform);
  const supa = getSupabaseAdmin();

  if (supa) {
    const { data, error } = await supa
      .from('oauth_connections')
      .select(
        'id, owner_uid, workspace_id, platform, account_id, account_name, account_handle, encrypted_access_token_json, encrypted_refresh_token_json, token_type, expires_at, last_error, connected_at, updated_at'
      )
      .eq('owner_uid', ownerUid)
      .eq('workspace_id', workspaceId)
      .eq('platform', platform)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read OAuth connection from Supabase: ${error.message}`);
    }

    if (data) {
      const row = data as {
        id: string;
        owner_uid: string;
        workspace_id: string;
        platform: ConnectedPlatform;
        account_id: string;
        account_name: string;
        account_handle?: string | null;
        encrypted_access_token_json: EncryptedPayload;
        encrypted_refresh_token_json?: EncryptedPayload | null;
        token_type?: WorkspaceConnection['tokenType'] | null;
        expires_at?: number | null;
        last_error?: string | null;
        connected_at: string;
        updated_at: string;
      };

      try {
        const accessToken = decryptSecret(row.encrypted_access_token_json);
        if (!accessToken || !accessToken.trim()) {
          throw new TokenCryptoError(
            'INVALID_CIPHERTEXT_ENVELOPE',
            'Decrypted access token is empty. Preserving database record untouched.'
          );
        }
        const refreshToken = row.encrypted_refresh_token_json
          ? decryptSecret(row.encrypted_refresh_token_json)
          : undefined;

        const hydrated: WorkspaceConnection = {
          ownerUid: row.owner_uid,
          workspaceId: row.workspace_id,
          platform: row.platform,
          accountId: row.account_id,
          accountName: row.account_name,
          accountHandle: row.account_handle || undefined,
          accessToken,
          refreshToken,
          tokenType: row.token_type || undefined,
          expiresAt: typeof row.expires_at === 'number' ? row.expires_at : undefined,
          lastError: row.last_error || undefined,
          connectedAt: row.connected_at,
          updatedAt: row.updated_at || row.connected_at,
        };
        connections.set(key, hydrated);
        connectionDecryptionErrors.delete(key);
        return { connection: hydrated };
      } catch (err) {
        const code = err instanceof TokenCryptoError ? err.code : 'DECRYPTION_FAILED';
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to decrypt stored OAuth token. Existing ciphertext preserved.';
        connections.delete(key);
        connectionDecryptionErrors.set(key, { code, message });
        return {
          connection: null,
          decryptionError: message,
          encryptionErrorCode: code,
        };
      }
    }

    const diskRec = legacyLocalConnections.get(`${workspaceId}:${platform}`);
    const ownerMatchesDisk =
      diskRec &&
      ((diskRec.ownerUid && diskRec.ownerUid === ownerUid) ||
        (!diskRec.ownerUid && !isProductionRuntime() && ownerUid === 'local-operator'));

    if (diskRec && ownerMatchesDisk && isValidEncryptedPayload(diskRec.encryptedAccessToken)) {
      try {
        const accessToken = decryptSecret(diskRec.encryptedAccessToken);
        const refreshToken = diskRec.encryptedRefreshToken
          ? decryptSecret(diskRec.encryptedRefreshToken)
          : undefined;
        if (accessToken && accessToken.trim()) {
          const imported: WorkspaceConnection = {
            ownerUid,
            workspaceId: diskRec.workspaceId,
            platform: diskRec.platform,
            accountId: diskRec.accountId,
            accountName: diskRec.accountName,
            accountHandle: diskRec.accountHandle,
            accessToken,
            refreshToken,
            tokenType: diskRec.tokenType,
            expiresAt: diskRec.expiresAt,
            lastError: diskRec.lastError,
            connectedAt: diskRec.connectedAt,
            updatedAt: diskRec.updatedAt || diskRec.connectedAt,
          };
          await upsertConnectionForOwner(ownerUid, imported);
          return { connection: imported };
        }
      } catch (err) {
        const code = err instanceof TokenCryptoError ? err.code : 'DECRYPTION_FAILED';
        const message = err instanceof Error ? err.message : 'Unable to decrypt local OAuth vault entry.';
        connectionDecryptionErrors.set(key, { code, message });
        return { connection: null, decryptionError: message, encryptionErrorCode: code };
      }
    }

    connections.delete(key);
    return { connection: null };
  }

  if (isProductionRuntime()) {
    throw new Error('Supabase must be configured in production to read OAuth connections.');
  }

  const cached = connections.get(key) || null;
  if (!cached) {
    const diskRec = legacyLocalConnections.get(`${workspaceId}:${platform}`);
    const ownerMatchesDisk =
      diskRec &&
      ((diskRec.ownerUid && diskRec.ownerUid === ownerUid) ||
        (!diskRec.ownerUid && ownerUid === 'local-operator'));
    if (diskRec && ownerMatchesDisk && isValidEncryptedPayload(diskRec.encryptedAccessToken)) {
      try {
        const accessToken = decryptSecret(diskRec.encryptedAccessToken);
        const refreshToken = diskRec.encryptedRefreshToken
          ? decryptSecret(diskRec.encryptedRefreshToken)
          : undefined;
        if (accessToken && accessToken.trim()) {
          const hydrated: WorkspaceConnection = {
            ownerUid,
            workspaceId: diskRec.workspaceId,
            platform: diskRec.platform,
            accountId: diskRec.accountId,
            accountName: diskRec.accountName,
            accountHandle: diskRec.accountHandle,
            accessToken,
            refreshToken,
            tokenType: diskRec.tokenType,
            expiresAt: diskRec.expiresAt,
            lastError: diskRec.lastError,
            connectedAt: diskRec.connectedAt,
            updatedAt: diskRec.updatedAt || diskRec.connectedAt,
          };
          connections.set(key, hydrated);
          return { connection: hydrated };
        }
      } catch (err) {
        const code = err instanceof TokenCryptoError ? err.code : 'DECRYPTION_FAILED';
        const message = err instanceof Error ? err.message : 'Unable to decrypt local OAuth connection.';
        connectionDecryptionErrors.set(key, { code, message });
        return { connection: null, decryptionError: message, encryptionErrorCode: code };
      }
    }
  }

  const errDiag = connectionDecryptionErrors.get(key);
  return {
    connection: cached,
    decryptionError: errDiag?.message,
    encryptionErrorCode: errDiag?.code,
  };
}

export async function upsertConnectionForOwner(
  ownerUid: string,
  conn: WorkspaceConnection
): Promise<void> {
  if (!ownerUid || !ownerUid.trim() || conn.ownerUid !== ownerUid) {
    throw new Error('Owner mismatch when persisting OAuth connection.');
  }
  if (!conn.accessToken || !conn.accessToken.trim()) {
    throw new Error('Refusing to persist OAuth connection with a blank access token.');
  }

  const key = connKey(ownerUid, conn.workspaceId, conn.platform);
  const encryptedAccessToken = encryptSecret(conn.accessToken);
  const encryptedRefreshToken =
    conn.refreshToken && conn.refreshToken.trim()
      ? encryptSecret(conn.refreshToken)
      : undefined;

  const supa = getSupabaseAdmin();
  if (supa) {
    const { data: existingRow, error: lookupErr } = await supa
      .from('oauth_connections')
      .select('id, encrypted_refresh_token_json')
      .eq('owner_uid', ownerUid)
      .eq('workspace_id', conn.workspaceId)
      .eq('platform', conn.platform)
      .maybeSingle();

    if (lookupErr) {
      throw new Error(`Failed to verify existing OAuth connection in Supabase: ${lookupErr.message}`);
    }

    const existingId = (existingRow as { id?: string } | null)?.id;
    const existingRefreshJson = (existingRow as { encrypted_refresh_token_json?: EncryptedPayload | null } | null)
      ?.encrypted_refresh_token_json;
    const preservedRefreshJson =
      encryptedRefreshToken ||
      (conn.platform === 'youtube' && isValidEncryptedPayload(existingRefreshJson)
        ? existingRefreshJson
        : null);

    const { error: upsertErr } = await supa.from('oauth_connections').upsert(
      [
        {
          id: existingId || `${conn.workspaceId}:${conn.platform}`,
          owner_uid: ownerUid,
          workspace_id: conn.workspaceId,
          platform: conn.platform,
          account_id: conn.accountId,
          account_name: conn.accountName,
          account_handle: conn.accountHandle || null,
          encrypted_access_token_json: encryptedAccessToken,
          encrypted_refresh_token_json: preservedRefreshJson,
          token_type: conn.tokenType || null,
          expires_at: typeof conn.expiresAt === 'number' ? conn.expiresAt : null,
          last_error: conn.lastError || null,
          connected_at: conn.connectedAt,
          updated_at: conn.updatedAt,
        },
      ],
      { onConflict: 'owner_uid,workspace_id,platform' }
    );

    if (upsertErr) {
      throw new Error(`Failed to persist OAuth connection in Supabase: ${upsertErr.message}`);
    }
  } else if (isProductionRuntime()) {
    throw new Error('Supabase must be configured in production to save OAuth connections.');
  }

  connections.set(key, conn);
  connectionDecryptionErrors.delete(key);
  if (!isProductionRuntime() && !isSupabaseConfigured()) {
    legacyLocalConnections.set(`${conn.workspaceId}:${conn.platform}`, {
      ownerUid,
      workspaceId: conn.workspaceId,
      platform: conn.platform,
      accountId: conn.accountId,
      accountName: conn.accountName,
      accountHandle: conn.accountHandle,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenType: conn.tokenType,
      expiresAt: conn.expiresAt,
      lastError: conn.lastError,
      connectedAt: conn.connectedAt,
      updatedAt: conn.updatedAt,
    });
    saveVaultToDisk();
  }
}

export async function deleteConnectionForOwner(
  ownerUid: string,
  workspaceId: string,
  platform: ConnectedPlatform
): Promise<void> {
  if (!ownerUid || !ownerUid.trim()) {
    throw new Error('Authenticated owner identity is required to disconnect.');
  }
  const key = connKey(ownerUid, workspaceId, platform);
  const supa = getSupabaseAdmin();
  if (supa) {
    const { error } = await supa
      .from('oauth_connections')
      .delete()
      .eq('owner_uid', ownerUid)
      .eq('workspace_id', workspaceId)
      .eq('platform', platform);
    if (error) {
      throw new Error(`Failed to remove OAuth connection from Supabase: ${error.message}`);
    }
  } else if (isProductionRuntime()) {
    throw new Error('Supabase must be configured in production to disconnect OAuth connections.');
  }

  connections.delete(key);
  connectionDecryptionErrors.delete(key);
  const legacyKey = `${workspaceId}:${platform}`;
  const diskRec = legacyLocalConnections.get(legacyKey);
  if (diskRec && (!diskRec.ownerUid || diskRec.ownerUid === ownerUid)) {
    legacyLocalConnections.delete(legacyKey);
  }
  if (!isProductionRuntime() && !isSupabaseConfigured()) {
    saveVaultToDisk();
  }
}

async function persistConnectionState(conn: WorkspaceConnection): Promise<void> {
  await upsertConnectionForOwner(conn.ownerUid, conn);
}

const youtubeRefreshLocks = new Map<string, Promise<string>>();

async function performYouTubeTokenRefresh(conn: WorkspaceConnection): Promise<string> {
  const yt = getYouTubeEnv();
  if (!conn.refreshToken) {
    const msg =
      'YouTube offline refresh token is missing. Click Reconnect to grant persistent offline access.';
    conn.lastError = msg;
    conn.updatedAt = new Date().toISOString();
    await persistConnectionState(conn).catch(() => {});
    throw new Error(msg);
  }
  if (!yt.configured) {
    throw new Error(
      `${yt.missingVars.join(' and ')} must be configured in Settings > Secrets to refresh YouTube authorization.`
    );
  }

  let res: globalThis.Response;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: yt.clientId,
        client_secret: yt.clientSecret,
        refresh_token: conn.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : 'Network error';
    throw new Error(`Temporary network failure contacting Google OAuth: ${msg}`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    const isRevoked =
      data.error === 'invalid_grant' ||
      data.error === 'unauthorized_client' ||
      res.status === 400 ||
      res.status === 401;

    if (isRevoked) {
      conn.lastError =
        'YouTube authorization was revoked or expired by Google. Click Reconnect to authorize again.';
      conn.updatedAt = new Date().toISOString();
      await persistConnectionState(conn).catch(() => {});
      throw new Error(conn.lastError);
    }

    throw new Error(
      data.error_description ||
        data.error ||
        `Temporary Google OAuth refresh error (HTTP ${res.status}).`
    );
  }

  conn.accessToken = data.access_token;
  conn.refreshToken = data.refresh_token || conn.refreshToken;
  conn.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  conn.lastError = undefined;
  conn.updatedAt = new Date().toISOString();
  await persistConnectionState(conn);
  return conn.accessToken;
}

async function ensureFreshYouTubeToken(
  conn: WorkspaceConnection,
  forceRefresh = false
): Promise<string> {
  const isExpiringSoon = !conn.expiresAt || Date.now() >= conn.expiresAt - 60_000;
  if (!forceRefresh && !isExpiringSoon && conn.accessToken && !conn.lastError) {
    return conn.accessToken;
  }

  if (!conn.refreshToken) {
    if (!forceRefresh && !isExpiringSoon && conn.accessToken) {
      return conn.accessToken;
    }
    const msg =
      'YouTube offline refresh token is missing. Click Reconnect to grant persistent offline access.';
    conn.lastError = msg;
    conn.updatedAt = new Date().toISOString();
    await persistConnectionState(conn).catch(() => {});
    throw new Error(msg);
  }

  const lockKey = connKey(conn.ownerUid, conn.workspaceId, 'youtube');
  const existingPromise = youtubeRefreshLocks.get(lockKey);
  if (existingPromise) {
    return existingPromise;
  }

  const refreshPromise = performYouTubeTokenRefresh(conn).finally(() => {
    youtubeRefreshLocks.delete(lockKey);
  });
  youtubeRefreshLocks.set(lockKey, refreshPromise);
  return refreshPromise;
}

async function verifyYouTubeTokenHealth(
  conn: WorkspaceConnection
): Promise<{ valid: boolean; error?: string }> {
  try {
    let token = await ensureFreshYouTubeToken(conn);
    let chanRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (chanRes.status === 401 && conn.refreshToken) {
      token = await ensureFreshYouTubeToken(conn, true);
      chanRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${token}` } }
      );
    }

    const chanData = (await chanRes.json().catch(() => ({}))) as {
      items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }>;
      error?: { message?: string };
    };

    if (chanRes.status === 401 || chanRes.status === 403) {
      const msg =
        chanData.error?.message ||
        'YouTube authorization was revoked or lacks required permissions. Click Reconnect to reauthorize.';
      conn.lastError = msg;
      conn.updatedAt = new Date().toISOString();
      await persistConnectionState(conn).catch(() => {});
      return { valid: false, error: msg };
    }

    const channel = chanData.items?.[0];
    if (chanRes.ok && channel) {
      conn.accountId = channel.id || conn.accountId;
      conn.accountName = channel.snippet?.title || conn.accountName;
      conn.accountHandle = channel.snippet?.customUrl || conn.accountHandle;
      conn.lastError = undefined;
      conn.updatedAt = new Date().toISOString();
      await persistConnectionState(conn).catch(() => {});
      return { valid: true };
    }

    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'YouTube verification failed.';
    return { valid: false, error: msg };
  }
}

async function verifyInstagramTokenHealth(conn: WorkspaceConnection): Promise<{ valid: boolean; error?: string }> {
  if (conn.expiresAt && Date.now() >= conn.expiresAt) {
    const msg = 'Instagram token expired. Reconnect Instagram in Connected Accounts.';
    conn.lastError = msg;
    conn.updatedAt = new Date().toISOString();
    await persistConnectionState(conn).catch(() => {});
    return { valid: false, error: msg };
  }

  try {
    const meRes = await fetch(
      `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(
        conn.accountId
      )}?fields=id,username,name`,
      {
        headers: { Authorization: `Bearer ${conn.accessToken}` },
      }
    );
    const meJson = (await meRes.json().catch(() => ({}))) as {
      id?: string;
      username?: string;
      name?: string;
      error?: { message?: string; code?: number };
    };

    if (!meRes.ok || meJson.error) {
      const msg =
        meJson.error?.message ||
        'Instagram token is no longer valid. Reconnect your Instagram account via Meta Unified Login.';
      conn.lastError = msg;
      conn.updatedAt = new Date().toISOString();
      await persistConnectionState(conn).catch(() => {});
      return { valid: false, error: msg };
    }

    if (meJson.username) {
      conn.accountHandle = meJson.username;
    }
    if (meJson.name) {
      conn.accountName = meJson.name;
    }

    conn.lastError = undefined;
    conn.updatedAt = new Date().toISOString();
    await persistConnectionState(conn).catch(() => {});
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

async function publishToYouTube(
  conn: WorkspaceConnection,
  opts: {
    title: string;
    description: string;
    tags: string[];
    videoBuffer: Buffer;
    mimeType: string;
    privacyStatus?: YouTubePrivacyStatus;
    onVideoId?: (videoId: string) => Promise<void> | void;
  }
): Promise<{ videoId: string; url: string }> {
  let token = await ensureFreshYouTubeToken(conn);
  const metadata = {
    snippet: {
      title: opts.title.slice(0, 100),
      description: opts.description.slice(0, 4900),
      tags: opts.tags.map((t) => t.replace(/^#/, '')).filter(Boolean).slice(0, 15),
      categoryId: '10',
    },
    status: {
      privacyStatus: opts.privacyStatus || 'public',
      selfDeclaredMadeForKids: false,
    },
  };

  const initiateResumableUpload = (bearerToken: string) =>
    fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(opts.videoBuffer.length),
          'X-Upload-Content-Type': opts.mimeType || 'video/mp4',
        },
        body: JSON.stringify(metadata),
      }
    );

  let initRes = await initiateResumableUpload(token);
  if (initRes.status === 401 && conn.refreshToken) {
    token = await ensureFreshYouTubeToken(conn, true);
    initRes = await initiateResumableUpload(token);
  }

  if (!initRes.ok) {
    const errText = await initRes.text();
    if (initRes.status === 401 || initRes.status === 403) {
      conn.lastError = 'YouTube authorization expired or missing upload permission.';
      conn.updatedAt = new Date().toISOString();
      await persistConnectionState(conn).catch(() => {});
    }
    throw new Error(`YouTube upload init failed (${initRes.status}): ${errText}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube did not return a resumable upload location.');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': opts.mimeType || 'video/mp4',
      'Content-Length': String(opts.videoBuffer.length),
    },
    body: new Uint8Array(opts.videoBuffer),
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`YouTube video transfer failed (${uploadRes.status}): ${errText}`);
  }

  const result = (await uploadRes.json()) as { id?: string };
  if (!result.id) {
    throw new Error('YouTube upload succeeded without returning a video ID.');
  }
  await opts.onVideoId?.(result.id);
  return {
    videoId: result.id,
    url: `https://youtube.com/shorts/${result.id}`,
  };
}

function getExtensionFromMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('quicktime') || lower.includes('mov')) return 'mov';
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  return 'jpg';
}

async function sweepStaleTempIgObjects(ownerUid: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const folder = `${getSafeStorageOwnerPrefix(ownerUid)}/temp-ig`;
    const listed = await listStorageObjects('social-media', folder, 100);
    if (!listed.ok || listed.items.length === 0) return;
    const cutoff = Date.now() - STALE_TEMP_IG_CUTOFF_MS;
    const stalePaths: string[] = [];
    for (const item of listed.items) {
      const ts = Date.parse(String(item.created_at || item.updated_at || ''));
      if (!Number.isNaN(ts) && ts < cutoff) {
        stalePaths.push(`${folder}/${item.name}`);
      }
    }
    if (stalePaths.length > 0) {
      await removeStorageObjects('social-media', stalePaths);
    }
  } catch {
    // Non-fatal best-effort sweep
  }
}

async function stageInstagramTempMedia(
  ownerUid: string,
  buffer: Buffer,
  mimeType: string,
  baseUrl?: string
): Promise<{ publicUrl: string; storageObjectPath?: string; devToken?: string }> {
  const lowerMime = (mimeType || '').toLowerCase();
  if (lowerMime.includes('webm')) {
    throw new Error('Instagram Reels and Video posts require an H.264/AAC MP4 file, not WebM.');
  }

  if (isSupabaseConfigured()) {
    const token = crypto.randomBytes(20).toString('hex');
    const ext = getExtensionFromMime(lowerMime);
    const relativePath = `temp-ig/${token}.${ext}`;
    const uploaded = await uploadToSupabaseBucket({
      bucket: 'social-media',
      ownerUid,
      relativePath,
      buffer,
      contentType: mimeType || 'application/octet-stream',
      signedUrlTtlSeconds: TEMP_IG_MEDIA_TTL_SECONDS,
      upsert: true,
    });
    if (!uploaded.ok || !uploaded.signedUrl) {
      throw new Error(
        `Failed to stage Instagram media in private Supabase Storage: ${uploaded.ok ? 'Missing signed URL' : uploaded.error}`
      );
    }
    return {
      publicUrl: uploaded.signedUrl,
      storageObjectPath: uploaded.path,
    };
  }

  if (isProductionRuntime()) {
    throw new Error('Supabase Storage must be configured in production for Instagram media ingestion.');
  }

  const token = crypto.randomBytes(20).toString('hex');
  devTempMediaStore.set(token, {
    buffer,
    mimeType,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  return {
    publicUrl: `${(baseUrl || getAppBaseUrl()).replace(/\/+$/, '')}/api/temp-media/${token}`,
    devToken: token,
  };
}

async function waitForInstagramContainer(
  creationId: string,
  accessToken: string,
  maxAttempts = 40
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const statusRes = await fetch(
      `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(
        creationId
      )}?fields=status_code,status`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = (await statusRes.json()) as {
      status_code?: string;
      status?: string;
      error?: { message?: string };
    };
    if (data.status_code === 'FINISHED' || data.status_code === 'PUBLISHED') return;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`Instagram media container failed: ${data.status || data.status_code}`);
    }
    if (data.error?.message) {
      throw new Error(`Instagram container status error: ${data.error.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Instagram media processing timed out.');
}

async function fetchInstagramPermalink(
  mediaId: string,
  accessToken: string,
  fallbackHandle?: string
): Promise<string> {
  try {
    const res = await fetch(
      `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(
        mediaId
      )}?fields=id,permalink`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const json = (await res.json()) as { permalink?: string };
    if (res.ok && json.permalink) {
      return json.permalink;
    }
  } catch {
    // fallback safely below
  }
  return `https://www.instagram.com/${fallbackHandle || ''}`;
}

async function publishToInstagram(
  conn: WorkspaceConnection,
  opts: {
    platform: 'instagram-reel' | 'instagram-carousel' | 'instagram-feed';
    caption: string;
    mediaItems: Array<{ buffer: Buffer; mimeType: string }>;
    baseUrl?: string;
    onCreationId?: (creationId: string) => Promise<void> | void;
  }
): Promise<{ mediaId: string; url: string }> {
  const health = await verifyInstagramTokenHealth(conn);
  if (!health.valid) {
    throw new Error(health.error || 'Instagram authorization invalid. Reconnect your account.');
  }

  const igUserId = conn.accountId;
  const token = conn.accessToken;

  if (opts.mediaItems.length === 0) {
    throw new Error('At least one image or video file is required for Instagram publishing.');
  }

  // Opportunistic sweep of orphaned temp-ig files older than 90m
  void sweepStaleTempIgObjects(conn.ownerUid);

  const stagedStoragePaths: string[] = [];
  const stagedDevTokens: string[] = [];

  try {
    let creationId = '';

    if (opts.platform === 'instagram-reel') {
      const staged = await stageInstagramTempMedia(
        conn.ownerUid,
        opts.mediaItems[0].buffer,
        opts.mediaItems[0].mimeType,
        opts.baseUrl
      );
      if (staged.storageObjectPath) stagedStoragePaths.push(staged.storageObjectPath);
      if (staged.devToken) stagedDevTokens.push(staged.devToken);

      const res = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            media_type: 'REELS',
            video_url: staged.publicUrl,
            caption: opts.caption,
          }),
        }
      );
      const data = (await res.json()) as { id?: string; error?: { message: string } };
      if (!res.ok || !data.id) {
        throw new Error(data.error?.message || 'Failed to create Instagram Reel container.');
      }
      creationId = data.id;
      await opts.onCreationId?.(creationId);
      await waitForInstagramContainer(creationId, token);
    } else if (opts.platform === 'instagram-carousel' && opts.mediaItems.length > 1) {
      const childIds: string[] = [];
      for (const item of opts.mediaItems.slice(0, 10)) {
        const staged = await stageInstagramTempMedia(
          conn.ownerUid,
          item.buffer,
          item.mimeType,
          opts.baseUrl
        );
        if (staged.storageObjectPath) stagedStoragePaths.push(staged.storageObjectPath);
        if (staged.devToken) stagedDevTokens.push(staged.devToken);

        const isVid = item.mimeType.startsWith('video/');
        const childRes = await fetch(
          `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              is_carousel_item: true,
              ...(isVid ? { media_type: 'VIDEO', video_url: staged.publicUrl } : { image_url: staged.publicUrl }),
            }),
          }
        );
        const childData = (await childRes.json()) as { id?: string; error?: { message: string } };
        if (!childRes.ok || !childData.id) {
          throw new Error(childData.error?.message || 'Failed to upload Instagram carousel item.');
        }
        if (isVid) {
          await waitForInstagramContainer(childData.id, token);
        }
        childIds.push(childData.id);
      }

      const parentRes = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            media_type: 'CAROUSEL',
            children: childIds,
            caption: opts.caption,
          }),
        }
      );
      const parentData = (await parentRes.json()) as { id?: string; error?: { message: string } };
      if (!parentRes.ok || !parentData.id) {
        throw new Error(parentData.error?.message || 'Failed to create Instagram carousel container.');
      }
      creationId = parentData.id;
      await opts.onCreationId?.(creationId);
      await waitForInstagramContainer(creationId, token);
    } else {
      const first = opts.mediaItems[0];
      const isVid = first.mimeType.startsWith('video/');
      const staged = await stageInstagramTempMedia(
        conn.ownerUid,
        first.buffer,
        first.mimeType,
        opts.baseUrl
      );
      if (staged.storageObjectPath) stagedStoragePaths.push(staged.storageObjectPath);
      if (staged.devToken) stagedDevTokens.push(staged.devToken);

      const res = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...(isVid ? { media_type: 'REELS', video_url: staged.publicUrl } : { image_url: staged.publicUrl }),
            caption: opts.caption,
          }),
        }
      );
      const data = (await res.json()) as { id?: string; error?: { message: string } };
      if (!res.ok || !data.id) {
        throw new Error(data.error?.message || 'Failed to create Instagram media container.');
      }
      creationId = data.id;
      await opts.onCreationId?.(creationId);
      await waitForInstagramContainer(creationId, token);
    }

    const pubRes = await fetch(
      `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media_publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          creation_id: creationId,
        }),
      }
    );
    const pubData = (await pubRes.json()) as { id?: string; error?: { message: string } };
    if (!pubRes.ok || !pubData.id) {
      throw new Error(pubData.error?.message || 'Failed to publish Instagram container.');
    }

    const permalink = await fetchInstagramPermalink(pubData.id, token, conn.accountHandle);

    return {
      mediaId: pubData.id,
      url: permalink,
    };
  } finally {
    if (stagedStoragePaths.length > 0) {
      await removeStorageObjects('social-media', stagedStoragePaths).catch(() => {});
    }
    for (const tok of stagedDevTokens) {
      devTempMediaStore.delete(tok);
    }
  }
}

async function reconcileDestinationOnPlatform(
  ownerUid: string,
  job: ScheduledPublishJob,
  dest: DestinationPublishState
): Promise<{ reconciledPublished: boolean; indeterminate?: boolean; detail: string }> {
  const lockPostId = job.postId || job.id;
  let inFlightId = dest.inFlightId;

  if (!inFlightId && isSupabaseConfigured()) {
    const rows =
      assertSyncOk(
        await fetchRowsFromSupabase<SupabaseIdempotencyRow>(
          'publish_idempotency',
          ownerUid,
          undefined,
          { workspace_id: job.workspaceId, post_id: lockPostId, platform: dest.platform }
        )
      ) || [];
    if (rows[0]?.status === 'published') {
      dest.status = 'published';
      dest.platformPostId = rows[0].platform_post_id || dest.platformPostId;
      dest.resultUrl = rows[0].result_url || dest.resultUrl;
      dest.publishedAt = rows[0].published_at || dest.publishedAt || new Date().toISOString();
      dest.needsReconciliation = false;
      dest.error = undefined;
      return {
        reconciledPublished: true,
        detail: `${dest.platform} was already confirmed published in durable lock ledger.`,
      };
    }
    inFlightId = rows[0]?.in_flight_id || undefined;
    if (inFlightId) dest.inFlightId = inFlightId;
  }

  if (!inFlightId) {
    if (isSupabaseConfigured()) {
      const rpcRes = await callSupabaseRpc<{ ok?: boolean; code?: string; error?: string }>(
        'reconcile_publish_destination',
        {
          p_owner_uid: ownerUid,
          p_workspace_id: job.workspaceId,
          p_post_id: lockPostId,
          p_platform: dest.platform,
          p_reconciled_published: false,
          p_platform_post_id: null,
          p_result_url: null,
          p_detail: 'No in-flight upload ID recorded. Destination is safe to retry.',
        }
      );
      const data = assertSyncOk(rpcRes);
      if (!data?.ok) {
        return {
          reconciledPublished: false,
          indeterminate: true,
          detail: data?.error || 'Reconciliation blocked while an active publish lease is still running.',
        };
      }
    }
    dest.needsReconciliation = false;
    return {
      reconciledPublished: false,
      detail: 'No in-flight upload ID recorded. Destination is safe to retry.',
    };
  }

  if (dest.platform === 'instagram') {
    const connRes = await getConnectionForOwner(ownerUid, job.workspaceId, 'instagram');
    const conn = connRes.connection;
    if (!conn) {
      return {
        reconciledPublished: false,
        indeterminate: true,
        detail:
          connRes.decryptionError ||
          'Instagram account not connected; reconnect account before reconciling.',
      };
    }
    try {
      const containerRes = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/${encodeURIComponent(
          inFlightId
        )}?fields=status_code,status`,
        { headers: { Authorization: `Bearer ${conn.accessToken}` } }
      );
      const containerJson = (await containerRes.json()) as {
        status_code?: string;
        status?: string;
        error?: { message?: string };
      };
      if (!containerRes.ok && containerJson.error) {
        // Keep needsReconciliation=true if platform returned API/transient error
        return {
          reconciledPublished: false,
          indeterminate: true,
          detail: `Instagram status check returned an error (${containerJson.error.message || containerRes.status}); lock preserved to prevent duplicate publish.`,
        };
      }
      if (containerJson.status_code === 'PUBLISHED') {
        const resultUrl = dest.resultUrl || `https://www.instagram.com/${conn.accountHandle || ''}`;
        if (isSupabaseConfigured()) {
          assertSyncOk(
            await callSupabaseRpc('reconcile_publish_destination', {
              p_owner_uid: ownerUid,
              p_workspace_id: job.workspaceId,
              p_post_id: lockPostId,
              p_platform: dest.platform,
              p_reconciled_published: true,
              p_platform_post_id: inFlightId,
              p_result_url: resultUrl,
              p_detail: 'Instagram confirmed container was already PUBLISHED.',
            })
          );
        }
        dest.status = 'published';
        dest.platformPostId = dest.platformPostId || inFlightId;
        dest.publishedAt = dest.publishedAt || new Date().toISOString();
        dest.needsReconciliation = false;
        dest.error = undefined;
        dest.resultUrl = resultUrl;
        return {
          reconciledPublished: true,
          detail: 'Instagram confirmed the interrupted container was already PUBLISHED.',
        };
      }

      if (containerJson.status_code === 'ERROR' || containerJson.status_code === 'EXPIRED' || containerJson.status_code === 'FINISHED') {
        const detail = `Container state: ${containerJson.status_code} (not published). Safe to retry.`;
        if (isSupabaseConfigured()) {
          const rpc = assertSyncOk(
            await callSupabaseRpc<{ ok?: boolean; error?: string }>('reconcile_publish_destination', {
              p_owner_uid: ownerUid,
              p_workspace_id: job.workspaceId,
              p_post_id: lockPostId,
              p_platform: dest.platform,
              p_reconciled_published: false,
              p_platform_post_id: null,
              p_result_url: null,
              p_detail: detail,
            })
          );
          if (!rpc?.ok) {
            return { reconciledPublished: false, indeterminate: true, detail: rpc?.error || 'Reconciliation blocked.' };
          }
        }
        dest.needsReconciliation = false;
        dest.inFlightId = undefined;
        dest.error = detail;
        return { reconciledPublished: false, detail };
      }

      return {
        reconciledPublished: false,
        indeterminate: true,
        detail: `Instagram container is still in state "${containerJson.status_code || 'UNKNOWN'}". Keeping reconciliation lock until status settles.`,
      };
    } catch {
      // NEVER clear needsReconciliation when Meta Graph cannot be reached!
      return {
        reconciledPublished: false,
        indeterminate: true,
        detail: 'Could not reach Instagram to verify container status; keeping lock intact to prevent duplicate publish.',
      };
    }
  } else {
    const connRes = await getConnectionForOwner(ownerUid, job.workspaceId, 'youtube');
    const conn = connRes.connection;
    if (!conn) {
      return {
        reconciledPublished: false,
        indeterminate: true,
        detail:
          connRes.decryptionError ||
          'YouTube account not connected; reconnect channel before reconciling.',
      };
    }
    try {
      const token = await ensureFreshYouTubeToken(conn);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(
          inFlightId
        )}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = (await res.json()) as { items?: Array<{ id: string }>; error?: { message?: string } };
      if (!res.ok) {
        return {
          reconciledPublished: false,
          indeterminate: true,
          detail: `YouTube verification returned HTTP ${res.status}; keeping lock intact to prevent duplicate upload.`,
        };
      }
      if (data.items && data.items.length > 0) {
        const resultUrl = `https://youtube.com/shorts/${inFlightId}`;
        if (isSupabaseConfigured()) {
          assertSyncOk(
            await callSupabaseRpc('reconcile_publish_destination', {
              p_owner_uid: ownerUid,
              p_workspace_id: job.workspaceId,
              p_post_id: lockPostId,
              p_platform: dest.platform,
              p_reconciled_published: true,
              p_platform_post_id: inFlightId,
              p_result_url: resultUrl,
              p_detail: `YouTube confirmed video ${inFlightId} is already uploaded.`,
            })
          );
        }
        dest.status = 'published';
        dest.platformPostId = inFlightId;
        dest.resultUrl = resultUrl;
        dest.publishedAt = dest.publishedAt || new Date().toISOString();
        dest.needsReconciliation = false;
        dest.error = undefined;
        return {
          reconciledPublished: true,
          detail: `YouTube confirmed video ${inFlightId} is already uploaded.`,
        };
      }

      const detail = 'No uploaded YouTube video found for interrupted attempt. Safe to retry.';
      if (isSupabaseConfigured()) {
        const rpc = assertSyncOk(
          await callSupabaseRpc<{ ok?: boolean; error?: string }>('reconcile_publish_destination', {
            p_owner_uid: ownerUid,
            p_workspace_id: job.workspaceId,
            p_post_id: lockPostId,
            p_platform: dest.platform,
            p_reconciled_published: false,
            p_platform_post_id: null,
            p_result_url: null,
            p_detail: detail,
          })
        );
        if (!rpc?.ok) {
          return { reconciledPublished: false, indeterminate: true, detail: rpc?.error || 'Reconciliation blocked.' };
        }
      }
      dest.needsReconciliation = false;
      dest.inFlightId = undefined;
      dest.error = detail;
      return { reconciledPublished: false, detail };
    } catch {
      // NEVER clear needsReconciliation when YouTube cannot be reached!
      return {
        reconciledPublished: false,
        indeterminate: true,
        detail: 'Could not reach YouTube to verify upload; keeping lock intact to prevent duplicate video.',
      };
    }
  }
}

async function sendSingleDestination(
  ownerUid: string,
  job: ScheduledPublishJob,
  dest: DestinationPublishState,
  mode: PublishHistoryEntry['mode'],
  baseUrl?: string,
  persistJobRecord = true
): Promise<{
  ok: boolean;
  conflict?: boolean;
  statusCode?: number;
  code?: string;
  error?: string;
  resultUrl?: string;
  platformPostId?: string;
}> {
  if (dest.status === 'published') {
    return {
      ok: false,
      conflict: true,
      statusCode: 409,
      code: 'ALREADY_PUBLISHED',
      error: `${dest.platform} is already published (${dest.resultUrl || dest.platformPostId || 'done'}). Duplication prevented.`,
      resultUrl: dest.resultUrl,
      platformPostId: dest.platformPostId,
    };
  }

  const lockPostId = job.postId && job.postId !== 'immediate' ? job.postId : job.id;
  const supabaseEnabled = isSupabaseConfigured();
  const lockToken = crypto.randomBytes(16).toString('hex');
  const devLockKey = `${ownerUid}:${job.workspaceId}:${lockPostId}:${dest.platform}`;
  let lockHeld = false;
  let recordedInFlightId: string | undefined = dest.inFlightId;

  if (supabaseEnabled) {
    const lockRes = await callSupabaseRpc<{
      ok?: boolean;
      outcome?: string;
      lock_token?: string;
      in_flight_id?: string;
      platform_post_id?: string;
      result_url?: string;
      published_at?: string;
      last_error?: string;
      error?: string;
    }>('acquire_publish_destination_lock', {
      p_owner_uid: ownerUid,
      p_workspace_id: job.workspaceId,
      p_post_id: lockPostId,
      p_platform: dest.platform,
      p_job_id: job.id.startsWith('pub-') ? null : job.id,
      p_lock_token: lockToken,
      p_lease_seconds: 600,
    });
    const lockData = assertSyncOk(lockRes);
    if (!lockData?.ok) {
      if (lockData?.outcome === 'already_published') {
        dest.status = 'published';
        dest.platformPostId = lockData.platform_post_id || dest.platformPostId;
        dest.resultUrl = lockData.result_url || dest.resultUrl;
        dest.publishedAt = lockData.published_at || dest.publishedAt;
        dest.needsReconciliation = false;
        dest.error = undefined;
        return {
          ok: false,
          conflict: true,
          statusCode: 409,
          code: 'ALREADY_PUBLISHED',
          error: `${dest.platform} was already published (${lockData.result_url || lockData.platform_post_id || 'done'}). Duplication prevented.`,
          resultUrl: lockData.result_url,
          platformPostId: lockData.platform_post_id,
        };
      }
      if (lockData?.outcome === 'in_progress') {
        return {
          ok: false,
          conflict: true,
          statusCode: 409,
          code: 'PUBLISH_IN_PROGRESS',
          error: `${dest.platform} publish is already in progress. Duplicate request blocked.`,
        };
      }
      if (lockData?.outcome === 'needs_reconciliation') {
        dest.status = 'failed';
        dest.needsReconciliation = true;
        dest.inFlightId = lockData.in_flight_id || dest.inFlightId;
        dest.error =
          lockData.last_error ||
          `Previous ${dest.platform} publish was interrupted with in-flight ID "${lockData.in_flight_id || ''}". Reconcile platform status before retrying.`;
        if (persistJobRecord) {
          await persistScheduledJobAuthoritative(ownerUid, job).catch(() => {});
        }
        return {
          ok: false,
          conflict: true,
          statusCode: 409,
          code: 'NEEDS_RECONCILIATION',
          error: dest.error,
        };
      }
      return {
        ok: false,
        statusCode: 400,
        error: lockData?.error || 'Could not acquire publishing lock.',
      };
    }
    lockHeld = true;
  } else {
    if (isProductionRuntime()) {
      throw new SupabasePersistenceError({
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: 'Supabase must be configured in production for publishing locks.',
        retriable: false,
        statusCode: 503,
      });
    }
    const priorDirect = devPublishedDirectKeys.get(`${job.workspaceId}:${lockPostId}:${dest.platform}`);
    if (priorDirect) {
      return {
        ok: false,
        conflict: true,
        statusCode: 409,
        code: 'ALREADY_PUBLISHED',
        error: `${dest.platform} was already published (${priorDirect.resultUrl || priorDirect.platformPostId || 'done'}). Duplication prevented.`,
      };
    }
    if (devActivePublishingKeys.has(devLockKey)) {
      return {
        ok: false,
        conflict: true,
        statusCode: 409,
        code: 'PUBLISH_IN_PROGRESS',
        error: `${dest.platform} publish is already in progress for this post.`,
      };
    }
    if (dest.needsReconciliation) {
      return {
        ok: false,
        conflict: true,
        statusCode: 409,
        code: 'NEEDS_RECONCILIATION',
        error: `Previous ${dest.platform} publish requires reconciliation before retrying.`,
      };
    }
    devActivePublishingKeys.add(devLockKey);
    lockHeld = true;
  }

  dest.status = 'publishing';
  dest.attempts = (dest.attempts || 0) + 1;
  dest.error = undefined;
  job.attempts = (job.attempts || 0) + 1;
  job.status = 'publishing';
  job.updatedAt = new Date().toISOString();
  if (persistJobRecord) {
    await persistScheduledJobAuthoritative(ownerUid, job);
  } else if (!supabaseEnabled && !isProductionRuntime()) {
    saveVaultToDisk();
  }

  const recordInFlight = async (inFlightId: string) => {
    recordedInFlightId = inFlightId;
    dest.inFlightId = inFlightId;
    if (supabaseEnabled) {
      const recRes = await callSupabaseRpc<{ ok?: boolean; code?: string; error?: string }>(
        'record_publish_in_flight_id',
        {
          p_owner_uid: ownerUid,
          p_workspace_id: job.workspaceId,
          p_post_id: lockPostId,
          p_platform: dest.platform,
          p_lock_token: lockToken,
          p_in_flight_id: inFlightId,
        }
      );
      const recData = assertSyncOk(recRes);
      if (!recData?.ok) {
        throw new Error(recData?.error || 'Publish lock lost before completing upload.');
      }
    }
    if (persistJobRecord) {
      await persistScheduledJobAuthoritative(ownerUid, job).catch(() => {});
    } else if (!supabaseEnabled && !isProductionRuntime()) {
      saveVaultToDisk();
    }
  };

  try {
    const resolvedMedia = await resolveJobMediaBuffers(job);

    if (dest.platform === 'youtube') {
      const connRes = await getConnectionForOwner(ownerUid, job.workspaceId, 'youtube');
      const conn = connRes.connection;
      if (!conn) {
        throw new Error(
          connRes.decryptionError ||
            `No YouTube account connected for workspace "${job.workspaceId}".`
        );
      }
      const videoItem = resolvedMedia.find((m) => m.mimeType.startsWith('video/')) || resolvedMedia[0];
      if (!videoItem) {
        throw new Error('YouTube Shorts requires a rendered MP4 video file.');
      }
      const tags = dest.youtubeTags && dest.youtubeTags.length > 0 ? dest.youtubeTags : job.hashtags;
      const rawDesc = dest.youtubeDescription !== undefined ? dest.youtubeDescription : job.caption;
      const fullDesc = `${rawDesc}\n\n${tags.join(' ')}`.trim();

      const ytRes = await publishToYouTube(conn, {
        title: (dest.youtubeTitle || job.title || '74 STUDIO Release').trim(),
        description: fullDesc,
        tags,
        videoBuffer: videoItem.buffer,
        mimeType: videoItem.mimeType,
        privacyStatus: dest.youtubePrivacyStatus || job.youtubePrivacyStatus || 'public',
        onVideoId: recordInFlight,
      });

      const publishedIso = new Date().toISOString();
      if (supabaseEnabled) {
        const compRes = await callSupabaseRpc<{ ok?: boolean; error?: string }>(
          'complete_publish_destination_success',
          {
            p_owner_uid: ownerUid,
            p_workspace_id: job.workspaceId,
            p_post_id: lockPostId,
            p_platform: 'youtube',
            p_lock_token: lockToken,
            p_platform_post_id: ytRes.videoId,
            p_result_url: ytRes.url,
            p_published_at: publishedIso,
          }
        );
        const comp = assertSyncOk(compRes);
        if (!comp?.ok) {
          throw new Error(comp?.error || 'Publish lock token mismatch on completion.');
        }
      } else {
        devPublishedDirectKeys.set(`${job.workspaceId}:${lockPostId}:youtube`, {
          platformPostId: ytRes.videoId,
          resultUrl: ytRes.url,
          publishedAt: publishedIso,
        });
      }
      lockHeld = false;

      dest.status = 'published';
      dest.publishedAt = publishedIso;
      dest.platformPostId = ytRes.videoId;
      dest.resultUrl = ytRes.url;
      dest.error = undefined;
      dest.needsReconciliation = false;
      job.publishedAt = dest.publishedAt;
      job.platformPostId = ytRes.videoId;
      job.resultUrl = ytRes.url;
    } else {
      const connRes = await getConnectionForOwner(ownerUid, job.workspaceId, 'instagram');
      const conn = connRes.connection;
      if (!conn) {
        throw new Error(
          connRes.decryptionError ||
            `No Instagram Professional account connected for workspace "${job.workspaceId}".`
        );
      }
      const rawCaption = dest.instagramCaption !== undefined ? dest.instagramCaption : job.caption;
      const fullCaption = `${rawCaption}\n\n${job.hashtags.join(' ')}`.trim();
      const igFormat = dest.format === 'youtube-shorts' ? 'instagram-reel' : dest.format;

      const igRes = await publishToInstagram(conn, {
        platform: igFormat,
        caption: fullCaption,
        mediaItems: resolvedMedia.map((m) => ({ buffer: m.buffer, mimeType: m.mimeType })),
        baseUrl: baseUrl || job.publicBaseUrl,
        onCreationId: recordInFlight,
      });

      const publishedIso = new Date().toISOString();
      if (supabaseEnabled) {
        const compRes = await callSupabaseRpc<{ ok?: boolean; error?: string }>(
          'complete_publish_destination_success',
          {
            p_owner_uid: ownerUid,
            p_workspace_id: job.workspaceId,
            p_post_id: lockPostId,
            p_platform: 'instagram',
            p_lock_token: lockToken,
            p_platform_post_id: igRes.mediaId,
            p_result_url: igRes.url,
            p_published_at: publishedIso,
          }
        );
        const comp = assertSyncOk(compRes);
        if (!comp?.ok) {
          throw new Error(comp?.error || 'Publish lock token mismatch on completion.');
        }
      } else {
        devPublishedDirectKeys.set(`${job.workspaceId}:${lockPostId}:instagram`, {
          platformPostId: igRes.mediaId,
          resultUrl: igRes.url,
          publishedAt: publishedIso,
        });
      }
      lockHeld = false;

      dest.status = 'published';
      dest.publishedAt = publishedIso;
      dest.platformPostId = igRes.mediaId;
      dest.resultUrl = igRes.url;
      dest.error = undefined;
      dest.needsReconciliation = false;
      job.publishedAt = dest.publishedAt;
      job.platformPostId = igRes.mediaId;
      job.resultUrl = igRes.url;
    }

    await recordHistoryAuthoritative(ownerUid, {
      id: `hist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      workspaceId: job.workspaceId,
      postId: job.postId,
      jobId: job.id.startsWith('pub-') ? undefined : job.id,
      title: job.title,
      platform: dest.format,
      mode,
      status: 'published',
      platformPostId: dest.platformPostId,
      resultUrl: dest.resultUrl,
      timestamp: new Date().toISOString(),
    });

    return {
      ok: true,
      resultUrl: dest.resultUrl,
      platformPostId: dest.platformPostId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const requiresReconciliation = Boolean(recordedInFlightId);
    if (supabaseEnabled && lockHeld) {
      await callSupabaseRpc('fail_publish_destination', {
        p_owner_uid: ownerUid,
        p_workspace_id: job.workspaceId,
        p_post_id: lockPostId,
        p_platform: dest.platform,
        p_lock_token: lockToken,
        p_error: msg,
        p_requires_reconciliation: requiresReconciliation,
      }).catch(() => {});
      lockHeld = false;
    }
    dest.status = 'failed';
    dest.error = msg;
    dest.needsReconciliation = requiresReconciliation;

    await recordHistoryAuthoritative(ownerUid, {
      id: `hist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      workspaceId: job.workspaceId,
      postId: job.postId,
      jobId: job.id.startsWith('pub-') ? undefined : job.id,
      title: job.title,
      platform: dest.format,
      mode,
      status: 'failed',
      error: msg,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return { ok: false, error: msg };
  } finally {
    if (!supabaseEnabled) {
      devActivePublishingKeys.delete(devLockKey);
    }
    job.status = computeEffectiveStatus(job);
    const failedMessages = job.destinations
      .filter((d) => d.status === 'failed' && d.error)
      .map((d) => `${d.platform.toUpperCase()}: ${d.error}`);
    job.error = failedMessages.length > 0 ? failedMessages.join(' | ') : undefined;
    job.updatedAt = new Date().toISOString();
    if (persistJobRecord) {
      await persistScheduledJobAuthoritative(ownerUid, job).catch(() => {});
    } else if (!supabaseEnabled && !isProductionRuntime()) {
      saveVaultToDisk();
    }
  }
}

export function registerSocialIntegrations(app: Express) {
  const socialAuthGuard = requireServerOperator('ws-behind-the-release');

  // Local non-production fallback endpoint ONLY when Supabase Storage is not configured.
  app.get('/api/temp-media/:token', (req: Request, res: Response) => {
    if (isProductionRuntime() || isSupabaseConfigured()) {
      return res.status(404).send('Not found');
    }
    const token = String(req.params.token || '');
    const entry = devTempMediaStore.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      devTempMediaStore.delete(token);
      return res.status(404).send('Media expired or not found');
    }
    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Content-Length', String(entry.buffer.length));
    return res.send(entry.buffer);
  });

  app.get('/api/integrations/status', socialAuthGuard, integrationReadLimiter, async (req: Request, res: Response) => {
    let ownerUid: string;
    try {
      ownerUid = resolveRequiredOwnerUid(req);
    } catch (authErr) {
      return res.status(401).json({
        error: authErr instanceof Error ? authErr.message : 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }

    const workspaceId = String(req.query.workspaceId || '').trim();
    const shouldVerify = req.query.verify === 'true';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }

    let ytLookup: Awaited<ReturnType<typeof getConnectionForOwner>>;
    let igLookup: Awaited<ReturnType<typeof getConnectionForOwner>>;
    try {
      [ytLookup, igLookup] = await Promise.all([
        getConnectionForOwner(ownerUid, workspaceId, 'youtube'),
        getConnectionForOwner(ownerUid, workspaceId, 'instagram'),
      ]);
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Unable to query OAuth persistence store.',
      });
    }

    const yt = ytLookup.connection;
    const ig = igLookup.connection;

    if (yt) {
      const needsAutoRefresh =
        !yt.expiresAt ||
        Date.now() >= yt.expiresAt - 60_000 ||
        Boolean(yt.lastError && yt.refreshToken);
      if (shouldVerify) {
        await verifyYouTubeTokenHealth(yt);
      } else if (needsAutoRefresh) {
        await ensureFreshYouTubeToken(yt).catch(() => {});
      }
    }

    if (shouldVerify && ig) {
      await verifyInstagramTokenHealth(ig);
    }

    const baseUrl = getAppBaseUrl(req);
    const ytEnv = getYouTubeEnv();
    const igEnv = getInstagramEnv();
    const cryptoDiag = getTokenCryptoDiagnostics();
    const ytNeedsReconnect = Boolean(
      yt &&
        (yt.lastError ||
          (!yt.refreshToken && (!yt.expiresAt || Date.now() >= yt.expiresAt - 60_000)))
    );

    return res.json({
      appBaseUrl: baseUrl,
      persistence: {
        storageBackend: isSupabaseConfigured() ? 'supabase' : 'local-vault',
        ownerScoped: true,
        encryptionKeyConfigured: cryptoDiag.encryptionKeyConfigured,
        usingEphemeralDevKeyring: cryptoDiag.usingEphemeralDevKeyring,
      },
      youtube: {
        configured: ytEnv.configured,
        missingVars: ytEnv.missingVars,
        connected: Boolean(yt),
        hasRefreshToken: Boolean(yt?.refreshToken),
        needsReconnect: ytNeedsReconnect,
        encryptionError: ytLookup.decryptionError,
        encryptionErrorCode: ytLookup.encryptionErrorCode,
        accountId: yt?.accountId,
        accountName: yt?.accountName,
        accountHandle: yt?.accountHandle,
        tokenType: yt?.tokenType || 'GOOGLE_OAUTH',
        expiresAt: yt?.expiresAt,
        lastError: yt?.lastError || ytLookup.decryptionError,
        connectedAt: yt?.connectedAt,
        callbackUrl: `${baseUrl}/api/auth/youtube/callback`,
      },
      instagram: {
        configured: igEnv.configured,
        missingVars: igEnv.missingVars,
        authMode: 'unified-login',
        configuredOAuthCredentials: Boolean(igEnv.appId && igEnv.appSecret),
        configuredUnifiedConfigId: Boolean(igEnv.configId),
        connected: Boolean(ig),
        needsReconnect: Boolean(ig?.lastError),
        encryptionError: igLookup.decryptionError,
        encryptionErrorCode: igLookup.encryptionErrorCode,
        accountId: ig?.accountId,
        accountName: ig?.accountName,
        accountHandle: ig?.accountHandle,
        tokenType: ig?.tokenType,
        expiresAt: ig?.expiresAt,
        lastError: ig?.lastError || igLookup.decryptionError,
        connectedAt: ig?.connectedAt,
        callbackUrl: `${baseUrl}/api/auth/instagram/callback`,
      },
    });
  });

  app.get('/api/auth/youtube/url', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    let ownerUid: string;
    try {
      ownerUid = resolveRequiredOwnerUid(req);
    } catch (authErr) {
      return res.status(401).json({
        error: authErr instanceof Error ? authErr.message : 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }

    const workspaceId = String(req.query.workspaceId || '').trim();
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }
    const ytEnv = getYouTubeEnv();
    if (!ytEnv.configured) {
      return res.status(400).json({
        error: `${ytEnv.missingVars.join(' and ')} must be configured in Settings > Secrets.`,
        code: 'MISSING_YOUTUBE_OAUTH',
      });
    }

    const redirectUri = `${getAppBaseUrl(req)}/api/auth/youtube/callback`;
    let state: string;
    try {
      state = await createAndPersistOAuthState({
        ownerUid,
        workspaceId,
        platform: 'youtube',
        redirectUri,
      });
    } catch (stateErr) {
      return res.status(503).json({
        error: stateErr instanceof Error ? stateErr.message : 'Failed to initialize OAuth state.',
      });
    }

    const existingLookup = await getConnectionForOwner(ownerUid, workspaceId, 'youtube').catch(() => ({
      connection: null,
    }));
    const existingConn = existingLookup.connection;
    const forceConsent =
      req.query.forceConsent === 'true' ||
      !existingConn?.refreshToken ||
      Boolean(existingConn?.lastError);

    const params = new URLSearchParams({
      client_id: ytEnv.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: forceConsent ? 'consent' : 'select_account',
      state,
    });

    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  });

  const handleYouTubeCallback = async (req: Request, res: Response) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const errParam = String(req.query.error || '');

    if (errParam) {
      const displayErr =
        errParam === 'access_denied'
          ? 'access_denied (If Google OAuth Consent Screen is in Testing mode, add this Google account under Audience / Test users in Google Cloud Console, or publish & verify the app.)'
          : errParam;
      return res.status(400).send(
        `<html><body style="background:#09090b;color:#fafafa;font-family:sans-serif;padding:24px;"><p>YouTube authorization declined: ${escapeHtml(displayErr)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'youtube',error:${JSON.stringify(displayErr)}},'*');window.close();}</script></body></html>`
      );
    }

    let consumed: Awaited<ReturnType<typeof consumeOAuthState>>;
    try {
      consumed = await consumeOAuthState(state, 'youtube');
    } catch (stateErr) {
      const msg = stateErr instanceof Error ? stateErr.message : 'Failed to validate YouTube OAuth state.';
      return res.status(503).send(escapeHtml(msg));
    }
    if (consumed.ok === false || !code) {
      return res
        .status(consumed.ok === false ? consumed.statusCode || 400 : 400)
        .send(consumed.ok === false ? consumed.reason : 'Invalid or expired YouTube OAuth state.');
    }
    const stateEntry = consumed;

    const ytEnv = getYouTubeEnv();
    if (!ytEnv.configured) {
      return res.status(500).send('YouTube OAuth secrets are not configured on the server.');
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: ytEnv.clientId,
          client_secret: ytEnv.clientSecret,
          redirect_uri: stateEntry.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
      };

      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || 'Failed to exchange YouTube code.');
      }

      const chanRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );
      const chanData = (await chanRes.json()) as {
        items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }>;
      };
      const channel = chanData.items?.[0];
      if (!channel) {
        throw new Error('No YouTube channel found on this Google account.');
      }

      const accountName = channel.snippet?.title || 'Connected YouTube Channel';
      const accountId = channel.id;
      const prevLookup = await getConnectionForOwner(stateEntry.ownerUid, stateEntry.workspaceId, 'youtube').catch(
        () => ({ connection: null })
      );
      const prev = prevLookup.connection;
      const nowIso = new Date().toISOString();
      const mergedRefreshToken = tokenData.refresh_token || prev?.refreshToken;

      await upsertConnectionForOwner(stateEntry.ownerUid, {
        ownerUid: stateEntry.ownerUid,
        workspaceId: stateEntry.workspaceId,
        platform: 'youtube',
        accountId,
        accountName,
        accountHandle: channel.snippet?.customUrl,
        accessToken: tokenData.access_token,
        refreshToken: mergedRefreshToken,
        tokenType: 'GOOGLE_OAUTH',
        expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
        lastError: mergedRefreshToken
          ? undefined
          : 'Connected without an offline refresh token. Click Reconnect to grant permanent offline access.',
        connectedAt: prev?.connectedAt || nowIso,
        updatedAt: nowIso,
      });

      const payload = JSON.stringify({
        type: 'OAUTH_AUTH_SUCCESS',
        platform: 'youtube',
        workspaceId: stateEntry.workspaceId,
        accountName,
      });

      return res.send(
        `<html><body style="background:#09090b;color:#fafafa;font-family:sans-serif;padding:24px;"><p>YouTube connected for ${escapeHtml(accountName)}. Closing window...</p><script>if(window.opener){window.opener.postMessage(${payload},'*');window.close();}</script></body></html>`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'YouTube OAuth failed.';
      return res.status(500).send(
        `<html><body><p>${escapeHtml(msg)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'youtube',error:${JSON.stringify(msg)}},'*');}</script></body></html>`
      );
    }
  };
  app.get(['/api/auth/youtube/callback', '/api/auth/youtube/callback/'], handleYouTubeCallback);

  app.get('/api/auth/instagram/url', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    let ownerUid: string;
    try {
      ownerUid = resolveRequiredOwnerUid(req);
    } catch (authErr) {
      return res.status(401).json({
        error: authErr instanceof Error ? authErr.message : 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }

    const workspaceId = String(req.query.workspaceId || '').trim();
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }
    const igEnv = getInstagramEnv();
    if (!igEnv.configured) {
      return res.status(400).json({
        error: `Missing Meta Unified Login secret(s): ${igEnv.missingVars.join(', ')}. Configure them in Settings > Secrets.`,
        code: 'MISSING_META_UNIFIED_LOGIN',
      });
    }

    const redirectUri = `${getAppBaseUrl(req)}/api/auth/instagram/callback`;
    let state: string;
    try {
      state = await createAndPersistOAuthState({
        ownerUid,
        workspaceId,
        platform: 'instagram',
        redirectUri,
      });
    } catch (stateErr) {
      return res.status(503).json({
        error: stateErr instanceof Error ? stateErr.message : 'Failed to initialize OAuth state.',
      });
    }

    const params = new URLSearchParams({
      client_id: igEnv.appId,
      redirect_uri: redirectUri,
      config_id: igEnv.configId,
      override_default_response_type: 'true',
      response_type: 'code',
      state,
    });

    return res.json({
      url: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`,
    });
  });

  const handleInstagramCallback = async (req: Request, res: Response) => {
    const rawCode = String(req.query.code || '');
    const code = rawCode.replace(/#_$/, '').trim();
    const state = String(req.query.state || '').trim();
    const errParam = String(req.query.error_description || req.query.error || req.query.error_reason || '');

    if (errParam) {
      return res.status(400).send(
        `<html><body><p>Instagram authorization declined: ${escapeHtml(errParam)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'instagram',error:${JSON.stringify(errParam)}},'*');window.close();}</script></body></html>`
      );
    }

    let consumed: Awaited<ReturnType<typeof consumeOAuthState>>;
    try {
      consumed = await consumeOAuthState(state, 'instagram');
    } catch (stateErr) {
      const msg = stateErr instanceof Error ? stateErr.message : 'Failed to validate Instagram OAuth state.';
      return res.status(503).send(escapeHtml(msg));
    }
    if (consumed.ok === false || !code) {
      return res
        .status(consumed.ok === false ? consumed.statusCode || 400 : 400)
        .send(consumed.ok === false ? consumed.reason : 'Invalid or expired Instagram OAuth state.');
    }
    const stateEntry = consumed;

    const igEnv = getInstagramEnv();
    if (!igEnv.configured) {
      return res.status(500).send('META_APP_ID, META_APP_SECRET, and META_LOGIN_CONFIG_ID are not configured on the server.');
    }

    try {
      const exchangeParams = new URLSearchParams({
        client_id: igEnv.appId,
        client_secret: igEnv.appSecret,
        redirect_uri: stateEntry.redirectUri,
        code,
      });
      const tokenRes = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/oauth/access_token?${exchangeParams.toString()}`
      );
      const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: { message?: string };
      };

      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(
          tokenJson.error?.message || 'Failed to exchange Meta Unified Login authorization code.'
        );
      }

      let finalToken = tokenJson.access_token;
      let resolvedTokenType: 'SYSTEM_USER' | 'USER' = 'USER';
      let expiresAt: number | undefined =
        typeof tokenJson.expires_in === 'number' && tokenJson.expires_in > 0
          ? Date.now() + tokenJson.expires_in * 1000
          : undefined;

      try {
        const debugParams = new URLSearchParams({
          input_token: finalToken,
          access_token: `${igEnv.appId}|${igEnv.appSecret}`,
        });
        const debugRes = await fetch(
          `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/debug_token?${debugParams.toString()}`
        );
        const debugJson = (await debugRes.json().catch(() => ({}))) as {
          data?: {
            type?: string;
            expires_at?: number;
            is_valid?: boolean;
          };
        };

        const tokenTypeUpper = String(debugJson.data?.type || '').toUpperCase();
        const debugExpiresAt = Number(debugJson.data?.expires_at || 0);

        if (tokenTypeUpper === 'SYSTEM_USER') {
          resolvedTokenType = 'SYSTEM_USER';
          expiresAt = debugExpiresAt > 0 ? debugExpiresAt * 1000 : undefined;
        } else if (debugExpiresAt === 0 && !tokenJson.expires_in) {
          resolvedTokenType = 'USER';
          expiresAt = undefined;
        }
      } catch {
        // Proceed with standard exchange fallback below if debug_token is unavailable
      }

      if (resolvedTokenType === 'USER' && expiresAt !== undefined) {
        const llParams = new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: igEnv.appId,
          client_secret: igEnv.appSecret,
          fb_exchange_token: finalToken,
        });
        const llRes = await fetch(
          `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/oauth/access_token?${llParams.toString()}`
        );
        const llData = (await llRes.json().catch(() => ({}))) as {
          access_token?: string;
          expires_in?: number;
        };
        if (llRes.ok && llData.access_token) {
          finalToken = llData.access_token;
          expiresAt = Date.now() + (llData.expires_in || 60 * 86400) * 1000;
        }
      }

      let igAccount: { id: string; username?: string; name?: string } | null = null;

      const assignedRes = await fetch(
        `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/me/assigned_instagram_accounts?fields=id,username,name`,
        {
          headers: { Authorization: `Bearer ${finalToken}` },
        }
      );
      if (assignedRes.ok) {
        const assignedData = (await assignedRes.json().catch(() => ({}))) as {
          data?: Array<{ id?: string; username?: string; name?: string }>;
        };
        const firstAssigned = assignedData.data?.find((item) => Boolean(item?.id));
        if (firstAssigned?.id) {
          igAccount = {
            id: String(firstAssigned.id),
            username: firstAssigned.username,
            name: firstAssigned.name,
          };
        }
      }

      if (!igAccount) {
        const pagesRes = await fetch(
          `${META_GRAPH_HOST}/${META_GRAPH_VERSION}/me/accounts?fields=id,name,instagram_business_account{id,username,name}`,
          {
            headers: { Authorization: `Bearer ${finalToken}` },
          }
        );
        const pagesData = (await pagesRes.json().catch(() => ({}))) as {
          data?: Array<{
            id?: string;
            name?: string;
            instagram_business_account?: { id?: string; username?: string; name?: string };
          }>;
          error?: { message?: string };
        };
        if (!pagesRes.ok && pagesData.error?.message) {
          throw new Error(pagesData.error.message);
        }
        const pageWithIg = pagesData.data?.find((p) => Boolean(p.instagram_business_account?.id));
        if (pageWithIg?.instagram_business_account?.id) {
          igAccount = {
            id: String(pageWithIg.instagram_business_account.id),
            username: pageWithIg.instagram_business_account.username,
            name: pageWithIg.instagram_business_account.name || pageWithIg.name,
          };
        }
      }

      if (!igAccount) {
        throw new Error(
          'No Instagram Professional (Business or Creator) account was returned by Meta Unified Login. Confirm the Instagram account is linked to your Business portfolio or Facebook Page and selected during login.'
        );
      }

      const accountName = igAccount.name || (igAccount.username ? `@${igAccount.username}` : igAccount.id);
      const nowIso = new Date().toISOString();
      const prevLookup = await getConnectionForOwner(stateEntry.ownerUid, stateEntry.workspaceId, 'instagram').catch(
        () => ({ connection: null })
      );

      await upsertConnectionForOwner(stateEntry.ownerUid, {
        ownerUid: stateEntry.ownerUid,
        workspaceId: stateEntry.workspaceId,
        platform: 'instagram',
        accountId: igAccount.id,
        accountName,
        accountHandle: igAccount.username,
        accessToken: finalToken,
        tokenType: resolvedTokenType,
        expiresAt,
        lastError: undefined,
        connectedAt: prevLookup.connection?.connectedAt || nowIso,
        updatedAt: nowIso,
      });

      const payload = JSON.stringify({
        type: 'OAUTH_AUTH_SUCCESS',
        platform: 'instagram',
        workspaceId: stateEntry.workspaceId,
        accountName,
      });

      return res.send(
        `<html><body style="background:#09090b;color:#fafafa;font-family:sans-serif;padding:24px;"><p>Instagram connected (${escapeHtml(
          igAccount.username ? `@${igAccount.username}` : accountName
        )}). Closing window...</p><script>if(window.opener){window.opener.postMessage(${payload},'*');window.close();}</script></body></html>`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Instagram OAuth failed.';
      return res.status(500).send(
        `<html><body><p>${escapeHtml(msg)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'instagram',error:${JSON.stringify(
          msg
        )}},'*');}</script></body></html>`
      );
    }
  };
  app.get(['/api/auth/instagram/callback', '/api/auth/instagram/callback/'], handleInstagramCallback);

  app.post('/api/integrations/disconnect', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    let ownerUid: string;
    try {
      ownerUid = resolveRequiredOwnerUid(req);
    } catch (authErr) {
      return res.status(401).json({
        error: authErr instanceof Error ? authErr.message : 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }
    const { workspaceId, platform } = req.body as {
      workspaceId: string;
      platform: ConnectedPlatform;
    };
    if (!workspaceId || (platform !== 'youtube' && platform !== 'instagram')) {
      return res.status(400).json({ error: 'Valid workspaceId and platform are required.' });
    }
    try {
      await deleteConnectionForOwner(ownerUid, workspaceId, platform);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Failed to disconnect integration.',
      });
    }
  });

  // Immediate Direct Send Endpoint (protected by Supabase publish_idempotency RPC when postId is supplied)
  app.post('/api/publish/now', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    let ownerUid: string;
    try {
      ownerUid = resolveRequiredOwnerUid(req);
    } catch (authErr) {
      return res.status(401).json({
        error: authErr instanceof Error ? authErr.message : 'Authentication required.',
        code: 'AUTH_REQUIRED',
      });
    }

    try {
      const {
        workspaceId,
        postId,
        platform,
        title,
        caption,
        hashtags,
        youtubePrivacyStatus,
        mediaItems,
      } = req.body as {
        workspaceId: string;
        postId?: string;
        platform: SocialFormat;
        title: string;
        caption: string;
        hashtags: string[];
        youtubePrivacyStatus?: YouTubePrivacyStatus;
        mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>;
      };

      if (!workspaceId || !platform) {
        return res.status(400).json({ error: 'workspaceId and platform are required.' });
      }

      const destPlatform: ConnectedPlatform = platform === 'youtube-shorts' ? 'youtube' : 'instagram';
      const resolvedId = postId ? `job-${postId}` : `pub-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

      const tempJob: ScheduledPublishJob = {
        id: resolvedId,
        workspaceId,
        postId: postId || 'immediate',
        title: title || 'Untitled Post',
        platform,
        platforms: [destPlatform],
        destinations: buildDefaultDestinations({
          platform,
          title: title || 'Untitled Post',
          caption: caption || '',
          hashtags: hashtags || [],
          youtubePrivacyStatus,
          scheduledIso: new Date().toISOString(),
        }),
        caption: caption || '',
        hashtags: hashtags || [],
        youtubePrivacyStatus,
        scheduledIso: new Date().toISOString(),
        timezone: 'Africa/Lagos',
        publicBaseUrl: getAppBaseUrl(req),
        mediaItems: mediaItems || [],
        status: 'ready-to-send',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const targetDest = tempJob.destinations[0];
      const outcome = await sendSingleDestination(
        ownerUid,
        tempJob,
        targetDest,
        'immediate',
        getAppBaseUrl(req),
        false
      );
      if (!outcome.ok) {
        return res.status(outcome.statusCode || (outcome.conflict ? 409 : 400)).json({
          error: outcome.error || 'Publishing failed.',
          code: outcome.code,
        });
      }
      return res.json({
        ok: true,
        resultUrl: outcome.resultUrl,
        platformPostId: outcome.platformPostId,
        publishedAt: targetDest.publishedAt,
      });
    } catch (err) {
      return handleSocialError(res, err, 'Publishing failed.');
    }
  });

  app.get('/api/scheduled-jobs', socialAuthGuard, integrationReadLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const workspaceId = String(req.query.workspaceId || '').trim();
      const jobs = await listScheduledJobsAuthoritative(ownerUid, workspaceId || undefined);
      const list = await Promise.all(jobs.map(serializeJobSummary));
      return res.json({ jobs: list });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to load scheduled jobs.');
    }
  });

  // Authenticated fallback preview endpoint (no static process-local HMAC key)
  app.get(
    '/api/scheduled-jobs/:id/media/:index',
    socialAuthGuard,
    integrationReadLimiter,
    async (req: Request, res: Response) => {
      try {
        const ownerUid = resolveRequiredOwnerUid(req);
        const id = String(req.params.id || '');
        const index = Number(req.params.index || 0);
        const job = await getScheduledJobAuthoritative(ownerUid, id);
        if (!job || Number.isNaN(index) || index < 0) {
          return res.status(404).send('Media preview not found.');
        }
        if (job.workspaceId !== 'ws-behind-the-release') {
          return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
        }

        if (job.mediaRefs && job.mediaRefs[index] && isSupabaseConfigured()) {
          const ref = job.mediaRefs[index];
          const dl = await downloadStorageObjectToBuffer(ref.storageBucket || 'social-media', ref.objectPath);
          if (!dl.ok) {
            return res.status(404).send('Media preview not found in cloud storage.');
          }
          res.setHeader('Content-Type', ref.mimeType || dl.mimeType || 'application/octet-stream');
          res.setHeader('Content-Length', String(dl.buffer.length));
          return res.send(dl.buffer);
        }

        if (index >= job.mediaItems.length) {
          return res.status(404).send('Media preview not found.');
        }
        const item = job.mediaItems[index];
        const buf = Buffer.from(item.base64Data, 'base64');
        res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(buf.length));
        return res.send(buf);
      } catch (err) {
        return handleSocialError(res, err, 'Failed to stream scheduled job media.');
      }
    }
  );

  app.get('/api/publish-history', socialAuthGuard, integrationReadLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const workspaceId = String(req.query.workspaceId || '').trim();
      const history = await listPublishHistoryAuthoritative(ownerUid, workspaceId || undefined);
      return res.json({ history });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to load publish history.');
    }
  });

  app.post('/api/scheduled-jobs', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const body = req.body as {
        workspaceId: string;
        postId: string;
        title: string;
        platform: SocialFormat;
        platforms?: ConnectedPlatform[];
        destinations?: DestinationPublishState[];
        caption: string;
        hashtags: string[];
        youtubePrivacyStatus?: YouTubePrivacyStatus;
        scheduledIso: string;
        timezone?: string;
        campaignId?: string;
        mediaAssetIds?: string[];
        preservedMediaCount?: number;
        status?: JobLifecycleStatus;
        attempts?: number;
        publishedAt?: string;
        platformPostId?: string;
        resultUrl?: string;
        error?: string;
        mediaItems?: Array<{ filename: string; mimeType: string; base64Data: string }>;
      };

      if (!body.workspaceId || !body.postId || !body.scheduledIso || !body.platform) {
        return res.status(400).json({ error: 'Missing required scheduled post fields.' });
      }

      const id = `job-${body.postId}`;
      const existing = await getScheduledJobAuthoritative(ownerUid, id);
      if (existing && (existing.status === 'publishing' || existing.status === 'published')) {
        return res.status(409).json({
          error: `Job ${id} is already ${existing.status} and cannot be overwritten.`,
        });
      }

      const defaultDests = buildDefaultDestinations({
        platform: body.platform,
        platforms: body.platforms,
        title: body.title || 'Scheduled Post',
        caption: body.caption || '',
        hashtags: body.hashtags || [],
        youtubePrivacyStatus: body.youtubePrivacyStatus,
        scheduledIso: body.scheduledIso,
        statusHint: body.status,
      });

      const sourceDests =
        existing?.destinations && existing.destinations.length > 0
          ? existing.destinations
          : body.destinations && body.destinations.length > 0
            ? body.destinations
            : [];

      const destinations: DestinationPublishState[] = defaultDests.map((defDest) => {
        const prior = sourceDests.find((d) => d.platform === defDest.platform);
        if (!prior) return defDest;
        if (prior.status === 'published') {
          return {
            ...defDest,
            ...prior,
            status: 'published',
          };
        }
        return {
          ...defDest,
          attempts: prior.attempts ?? defDest.attempts,
          status:
            body.status === 'cancelled'
              ? 'cancelled'
              : prior.status === 'publishing'
                ? 'failed'
                : prior.status || defDest.status,
          error: prior.error,
          inFlightId: prior.inFlightId,
          needsReconciliation: prior.needsReconciliation,
        };
      });

      const now = new Date().toISOString();
      const incomingMediaItems =
        body.mediaItems && body.mediaItems.length > 0 ? body.mediaItems : [];
      const resolvedMediaItems =
        incomingMediaItems.length > 0
          ? incomingMediaItems
          : existing?.mediaItems || [];
      const preservedMediaCount =
        resolvedMediaItems.length > 0
          ? resolvedMediaItems.length
          : existing?.mediaRefs && existing.mediaRefs.length > 0
            ? existing.mediaRefs.length
            : Math.max(Number(body.preservedMediaCount || 0), existing?.preservedMediaCount || 0);

      const initialStatus: JobLifecycleStatus =
        body.status === 'draft'
          ? 'draft'
          : body.status === 'cancelled'
            ? 'cancelled'
            : isDueNow(body.scheduledIso)
              ? 'ready-to-send'
              : 'scheduled';

      const job: ScheduledPublishJob = {
        id,
        workspaceId: body.workspaceId,
        postId: body.postId,
        title: body.title || 'Scheduled Post',
        platform: body.platform,
        platforms:
          body.platforms && body.platforms.length > 0
            ? Array.from(new Set(body.platforms))
            : [body.platform === 'youtube-shorts' ? 'youtube' : 'instagram'],
        destinations,
        caption: body.caption || '',
        hashtags: body.hashtags || [],
        youtubePrivacyStatus: body.youtubePrivacyStatus || 'public',
        scheduledIso: body.scheduledIso,
        timezone: body.timezone || 'Africa/Lagos',
        campaignId: body.campaignId,
        mediaAssetIds: body.mediaAssetIds || existing?.mediaAssetIds || [],
        preservedMediaCount,
        publicBaseUrl: getAppBaseUrl(req),
        mediaRefs: incomingMediaItems.length > 0 ? undefined : existing?.mediaRefs,
        mediaItems: resolvedMediaItems,
        status: initialStatus,
        attempts: Math.max(Number(body.attempts || 0), existing?.attempts || 0),
        publishedAt: body.publishedAt || existing?.publishedAt,
        platformPostId: body.platformPostId || existing?.platformPostId,
        resultUrl: body.resultUrl || existing?.resultUrl,
        error: body.error || existing?.error,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };

      const persisted = await persistScheduledJobAuthoritative(ownerUid, job);
      return res.json({
        ok: true,
        job: await serializeJobSummary(persisted),
      });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to save scheduled post.');
    }
  });

  app.patch('/api/scheduled-jobs/:id', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (!job) {
        return res.status(404).json({ error: 'Scheduled post not found.' });
      }
      if (job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }
      if (job.status === 'publishing' || job.status === 'published') {
        return res.status(409).json({ error: `Cannot edit a ${job.status} post.` });
      }

      const patch = req.body as Partial<{
        title: string;
        caption: string;
        hashtags: string[];
        scheduledIso: string;
        timezone: string;
        platform: SocialFormat;
        platforms: ConnectedPlatform[];
        youtubePrivacyStatus: YouTubePrivacyStatus;
        status: 'draft' | 'scheduled';
        mediaAssetIds: string[];
        mediaItems: Array<{ filename: string; mimeType: string; base64Data: string }>;
      }>;

      if (patch.title !== undefined) {
        job.title = patch.title;
        for (const d of job.destinations) {
          if (d.platform === 'youtube' && d.status !== 'published') d.youtubeTitle = patch.title;
        }
      }
      if (patch.caption !== undefined) {
        job.caption = patch.caption;
        for (const d of job.destinations) {
          if (d.status !== 'published') {
            if (d.platform === 'instagram') d.instagramCaption = patch.caption;
            if (d.platform === 'youtube') d.youtubeDescription = patch.caption;
          }
        }
      }
      if (patch.hashtags !== undefined) {
        job.hashtags = patch.hashtags;
        for (const d of job.destinations) {
          if (d.platform === 'youtube' && d.status !== 'published') d.youtubeTags = patch.hashtags;
        }
      }
      if (patch.youtubePrivacyStatus !== undefined) {
        job.youtubePrivacyStatus = patch.youtubePrivacyStatus;
        for (const d of job.destinations) {
          if (d.platform === 'youtube' && d.status !== 'published') {
            d.youtubePrivacyStatus = patch.youtubePrivacyStatus;
          }
        }
      }
      if (patch.timezone !== undefined) job.timezone = patch.timezone;
      if (patch.mediaAssetIds !== undefined) job.mediaAssetIds = patch.mediaAssetIds;
      if (patch.mediaItems !== undefined && patch.mediaItems.length > 0) {
        job.mediaItems = patch.mediaItems;
        job.mediaRefs = undefined;
      }
      if (patch.platform !== undefined) {
        job.platform = patch.platform;
        for (const d of job.destinations) {
          if (d.platform === 'instagram' && d.status !== 'published' && patch.platform !== 'youtube-shorts') {
            d.format = patch.platform;
          }
        }
      }
      if (patch.scheduledIso !== undefined) {
        job.scheduledIso = patch.scheduledIso;
        if (job.status !== 'draft') {
          const nextDestState: DestinationPublishState['status'] = isDueNow(patch.scheduledIso)
            ? 'ready-to-send'
            : 'scheduled';
          for (const d of job.destinations) {
            if (d.status !== 'published') {
              d.status = nextDestState;
              d.error = undefined;
            }
          }
          job.status = nextDestState;
          job.error = undefined;
        }
      }
      if (patch.status === 'draft') {
        job.status = 'draft';
      } else if (patch.status === 'scheduled' && job.status === 'draft') {
        job.status = isDueNow(job.scheduledIso) ? 'ready-to-send' : 'scheduled';
      }

      const persisted = await persistScheduledJobAuthoritative(ownerUid, job);
      return res.json({
        ok: true,
        job: await serializeJobSummary(persisted),
      });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to update scheduled post.');
    }
  });

  app.post('/api/scheduled-jobs/:id/send', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (!job) {
        return res.status(404).json({ error: 'Scheduled post not found.' });
      }
      if (job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }
      if (job.status === 'cancelled') {
        return res.status(409).json({ error: 'Cancelled posts must be rescheduled before sending.' });
      }

      const body = (req.body || {}) as {
        targets?: ConnectedPlatform[];
        instagramCaption?: string;
        instagramFormat?: 'instagram-reel' | 'instagram-carousel' | 'instagram-feed';
        youtubeTitle?: string;
        youtubeDescription?: string;
        youtubeTags?: string[];
        youtubePrivacyStatus?: YouTubePrivacyStatus;
        mediaItems?: Array<{ filename: string; mimeType: string; base64Data: string }>;
      };

      if (body.mediaItems && body.mediaItems.length > 0 && job.mediaItems.length === 0 && (!job.mediaRefs || job.mediaRefs.length === 0)) {
        job.mediaItems = body.mediaItems;
      }

      const requestedTargets =
        body.targets && body.targets.length > 0
          ? Array.from(new Set(body.targets))
          : job.destinations.filter((d) => d.status !== 'published' && d.status !== 'cancelled').map((d) => d.platform);

      if (requestedTargets.length === 0) {
        return res.status(409).json({
          error: 'All selected destinations have already been published.',
          job: await serializeJobSummary(job),
        });
      }

      for (const target of requestedTargets) {
        const dest = job.destinations.find((d) => d.platform === target);
        if (!dest) {
          return res.status(400).json({ error: `Destination "${target}" is not configured on this post.` });
        }
        if (dest.status === 'published') {
          return res.status(409).json({
            error: `${target} is already published (${dest.resultUrl || dest.platformPostId || 'done'}). Duplication prevented.`,
            job: await serializeJobSummary(job),
          });
        }
      }

      for (const target of requestedTargets) {
        const dest = job.destinations.find((d) => d.platform === target)!;
        if (target === 'instagram') {
          if (body.instagramCaption !== undefined) dest.instagramCaption = body.instagramCaption;
          if (body.instagramFormat) dest.format = body.instagramFormat;
        } else if (target === 'youtube') {
          if (body.youtubeTitle !== undefined) dest.youtubeTitle = body.youtubeTitle;
          if (body.youtubeDescription !== undefined) dest.youtubeDescription = body.youtubeDescription;
          if (body.youtubeTags !== undefined) dest.youtubeTags = body.youtubeTags;
          if (body.youtubePrivacyStatus) dest.youtubePrivacyStatus = body.youtubePrivacyStatus;
        }
      }

      const baseUrl = getAppBaseUrl(req);
      const results: Record<
        string,
        { ok: boolean; conflict?: boolean; statusCode?: number; code?: string; resultUrl?: string; platformPostId?: string; error?: string }
      > = {};

      for (const target of requestedTargets) {
        const dest = job.destinations.find((d) => d.platform === target)!;
        const mode: PublishHistoryEntry['mode'] = dest.attempts > 0 ? 'retry' : 'manual-send';
        results[target] = await sendSingleDestination(ownerUid, job, dest, mode, baseUrl, true);
      }

      const summary = await serializeJobSummary(job);
      const anySucceeded = Object.values(results).some((r) => r.ok);
      const allSucceeded = Object.values(results).every((r) => r.ok);

      if (!anySucceeded) {
        const firstFail = Object.values(results).find((r) => !r.ok);
        const status = firstFail?.statusCode || (firstFail?.conflict ? 409 : 400);
        return res.status(status).json({
          ok: false,
          error: firstFail?.error || 'Publishing failed.',
          code: firstFail?.code,
          results,
          job: summary,
        });
      }

      return res.json({
        ok: allSucceeded,
        partial: !allSucceeded && anySucceeded,
        results,
        job: summary,
        resultUrl: summary.resultUrl,
        status: summary.status,
      });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to publish scheduled post.');
    }
  });

  app.post('/api/scheduled-jobs/:id/reconcile', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (!job) {
        return res.status(404).json({ error: 'Scheduled post not found.' });
      }
      if (job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }
      const platform = req.body?.platform as ConnectedPlatform | undefined;
      const targets = job.destinations.filter(
        (d) => (!platform || d.platform === platform) && (d.needsReconciliation || d.status === 'failed' || d.status === 'publishing')
      );

      const outcomes: Record<string, { reconciledPublished: boolean; indeterminate?: boolean; detail: string }> = {};
      for (const dest of targets) {
        outcomes[dest.platform] = await reconcileDestinationOnPlatform(ownerUid, job, dest);
      }

      const persisted = await persistScheduledJobAuthoritative(ownerUid, job);
      return res.json({
        ok: true,
        outcomes,
        job: await serializeJobSummary(persisted),
      });
    } catch (err) {
      return handleSocialError(res, err, 'Reconciliation check failed.');
    }
  });

  app.post('/api/scheduled-jobs/:id/retry', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (!job) {
        return res.status(404).json({ error: 'Scheduled post not found.' });
      }
      if (job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }
      if (job.status === 'published' || job.status === 'publishing') {
        return res.status(409).json({ error: `Job is already ${job.status}.` });
      }

      const targets = (req.body?.targets as ConnectedPlatform[] | undefined) ||
        job.destinations.filter((d) => d.status !== 'published' && d.status !== 'cancelled').map((d) => d.platform);

      const baseUrl = getAppBaseUrl(req);
      const results: Record<string, { ok: boolean; statusCode?: number; code?: string; resultUrl?: string; error?: string }> = {};
      for (const target of targets) {
        const dest = job.destinations.find((d) => d.platform === target);
        if (dest && dest.status !== 'published') {
          results[target] = await sendSingleDestination(ownerUid, job, dest, 'retry', baseUrl, true);
        }
      }

      const summary = await serializeJobSummary(job);
      const anyFailed = Object.values(results).some((r) => !r.ok);
      const allFailed = Object.values(results).every((r) => !r.ok);
      if (allFailed) {
        const firstFail = Object.values(results).find((r) => !r.ok);
        return res.status(firstFail?.statusCode || 400).json({
          error: firstFail?.error || summary.error || 'Retry failed.',
          code: firstFail?.code,
          job: summary,
        });
      }
      return res.json({
        ok: !anyFailed,
        partial: anyFailed,
        resultUrl: summary.resultUrl,
        status: summary.status,
        job: summary,
      });
    } catch (err) {
      return handleSocialError(res, err, 'Retry failed.');
    }
  });

  app.post('/api/scheduled-jobs/:id/cancel', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (!job) {
        return res.status(404).json({ error: 'Scheduled post not found.' });
      }
      if (job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }
      if (job.status === 'published' || job.status === 'publishing') {
        return res.status(409).json({ error: `Cannot cancel a ${job.status} post.` });
      }
      for (const d of job.destinations) {
        if (d.status !== 'published') {
          d.status = 'cancelled';
        }
      }
      job.status = job.destinations.some((d) => d.status === 'published') ? 'partially-published' : 'cancelled';
      const persisted = await persistScheduledJobAuthoritative(ownerUid, job);
      return res.json({ ok: true, status: persisted.status, job: await serializeJobSummary(persisted) });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to cancel scheduled post.');
    }
  });

  app.delete('/api/scheduled-jobs/:id', socialAuthGuard, authAndIntegrationMutationLimiter, async (req: Request, res: Response) => {
    try {
      const ownerUid = resolveRequiredOwnerUid(req);
      const id = String(req.params.id || '');
      const job = await getScheduledJobAuthoritative(ownerUid, id);
      if (job && job.workspaceId !== 'ws-behind-the-release') {
        return res.status(403).json({ error: 'Cross-workspace access denied.', code: 'WORKSPACE_ISOLATION_VIOLATION' });
      }

      if (isSupabaseConfigured()) {
        assertSyncOk(await deleteRowFromSupabase('scheduled_jobs', ownerUid, id));
        if (job?.mediaRefs && job.mediaRefs.length > 0) {
          await removeStorageObjects(
            'social-media',
            job.mediaRefs.map((r) => r.objectPath)
          ).catch(() => {});
        }
      } else if (isProductionRuntime()) {
        return res.status(503).json({
          error: 'Supabase must be configured in production to delete scheduled posts.',
          code: 'SUPABASE_NOT_CONFIGURED',
        });
      } else {
        devScheduledJobs.delete(id);
        saveVaultToDisk();
      }
      return res.json({ ok: true });
    } catch (err) {
      return handleSocialError(res, err, 'Failed to delete scheduled post.');
    }
  });
}
