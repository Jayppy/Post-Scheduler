import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import { decryptSecret, EncryptedPayload, encryptSecret, getDataDirPath } from './tokenCrypto';

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

interface OAuthStateEntry {
  workspaceId: string;
  platform: ConnectedPlatform;
  redirectUri: string;
  createdAt: number;
}

export interface WorkspaceConnection {
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

const META_GRAPH_VERSION = 'v21.0';
const VAULT_FILE = path.join(getDataDirPath(), 'integrations-vault.json');

// Server-side stores backed by encrypted disk snapshot (OAuth tokens never leave the server)
const pendingStates = new Map<string, OAuthStateEntry>();
const connections = new Map<string, WorkspaceConnection>(); // key: `${workspaceId}:${platform}`
const tempMediaStore = new Map<string, TempMediaEntry>();
const scheduledJobs = new Map<string, ScheduledPublishJob>();
const publishHistory: PublishHistoryEntry[] = [];
const publishedDirectKeys = new Map<string, DirectPublishedRecord>(); // key: `${workspaceId}:${postId}:${platform}`
const activePublishingKeys = new Set<string>(); // Prevents concurrent duplicate publishing per `${jobId}:${platform}`

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

function serializeJobSummary(job: ScheduledPublishJob) {
  const nowMs = Date.now();
  const destinations = normalizeDestinationsForRead(job, nowMs);
  const status = computeEffectiveStatus({ ...job, destinations }, nowMs);
  const { mediaItems, ...rest } = job;
  return {
    ...rest,
    status,
    destinations,
    mediaCount: mediaItems.length > 0 ? mediaItems.length : (job.preservedMediaCount ?? 0),
    mediaPreviews: mediaItems.map((m, index) => ({
      index,
      filename: m.filename,
      mimeType: m.mimeType,
      url: `/api/scheduled-jobs/${encodeURIComponent(job.id)}/media/${index}`,
    })),
  };
}

function loadVaultFromDisk() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return;
    const raw = fs.readFileSync(VAULT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VaultSnapshot>;

    if (parsed.connections) {
      for (const [key, rec] of Object.entries(parsed.connections)) {
        try {
          const accessToken = decryptSecret(rec.encryptedAccessToken);
          const refreshToken = rec.encryptedRefreshToken
            ? decryptSecret(rec.encryptedRefreshToken)
            : undefined;
          connections.set(key, {
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
        } catch (err) {
          console.warn(`Could not decrypt stored connection ${key}:`, err);
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
        scheduledJobs.set(id, normalizedJob);
      }
    }

    if (Array.isArray(parsed.publishHistory)) {
      publishHistory.push(...parsed.publishHistory.slice(0, 200));
    }

    if (parsed.pendingStates) {
      const now = Date.now();
      for (const [k, v] of Object.entries(parsed.pendingStates)) {
        if (now - v.createdAt <= 15 * 60 * 1000) {
          pendingStates.set(k, v);
        }
      }
    }

    if (parsed.publishedDirectKeys) {
      for (const [k, v] of Object.entries(parsed.publishedDirectKeys)) {
        publishedDirectKeys.set(k, v);
      }
    }
  } catch (err) {
    console.warn('Failed to load integrations vault from disk:', err);
  }
}

function saveVaultToDisk() {
  try {
    const connObj: Record<string, StoredConnectionRecord> = {};
    for (const [key, conn] of connections.entries()) {
      connObj[key] = {
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
    }

    const jobsObj: Record<string, ScheduledPublishJob> = {};
    for (const [id, job] of scheduledJobs.entries()) {
      jobsObj[id] = job;
    }

    const statesObj: Record<string, OAuthStateEntry> = {};
    for (const [k, v] of pendingStates.entries()) {
      statesObj[k] = v;
    }

    const directObj: Record<string, DirectPublishedRecord> = {};
    for (const [k, v] of publishedDirectKeys.entries()) {
      directObj[k] = v;
    }

    const snapshot: VaultSnapshot = {
      connections: connObj,
      scheduledJobs: jobsObj,
      publishHistory: publishHistory.slice(0, 200),
      pendingStates: statesObj,
      publishedDirectKeys: directObj,
    };

    const tmpPath = `${VAULT_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(tmpPath, VAULT_FILE);
  } catch (err) {
    console.warn('Failed to persist integrations vault:', err);
  }
}

// Hydrate stored state immediately on module import
loadVaultFromDisk();

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
  return { appId, appSecret, configId, missingVars, configured: missingVars.length === 0 };
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

function connKey(workspaceId: string, platform: ConnectedPlatform): string {
  return `${workspaceId}:${platform}`;
}

function cleanupExpired() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of pendingStates.entries()) {
    if (now - v.createdAt > 15 * 60 * 1000) {
      pendingStates.delete(k);
      changed = true;
    }
  }
  for (const [k, v] of tempMediaStore.entries()) {
    if (now > v.expiresAt) tempMediaStore.delete(k);
  }
  if (changed) saveVaultToDisk();
}

function recordHistory(entry: PublishHistoryEntry) {
  publishHistory.unshift(entry);
  if (publishHistory.length > 200) publishHistory.length = 200;
  saveVaultToDisk();
}

async function ensureFreshYouTubeToken(conn: WorkspaceConnection): Promise<string> {
  if (!conn.expiresAt || Date.now() < conn.expiresAt - 60_000) {
    return conn.accessToken;
  }
  const yt = getYouTubeEnv();
  if (!conn.refreshToken || !yt.configured) {
    return conn.accessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: yt.clientId,
      client_secret: yt.clientSecret,
      refresh_token: conn.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    conn.lastError =
      data.error_description ||
      data.error ||
      'YouTube authorization expired. Reconnect YouTube in Connected Accounts.';
    conn.updatedAt = new Date().toISOString();
    saveVaultToDisk();
    throw new Error(conn.lastError);
  }

  conn.accessToken = data.access_token;
  conn.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  conn.lastError = undefined;
  conn.updatedAt = new Date().toISOString();
  saveVaultToDisk();
  return conn.accessToken;
}

async function verifyInstagramTokenHealth(conn: WorkspaceConnection): Promise<{ valid: boolean; error?: string }> {
  if (conn.expiresAt && Date.now() >= conn.expiresAt) {
    const msg = 'Instagram token expired. Reconnect Instagram in Connected Accounts.';
    conn.lastError = msg;
    conn.updatedAt = new Date().toISOString();
    saveVaultToDisk();
    return { valid: false, error: msg };
  }

  const igEnv = getInstagramEnv();
  if (!igEnv.appId || !igEnv.appSecret) {
    return { valid: true };
  }

  try {
    const appAccessToken = `${igEnv.appId}|${igEnv.appSecret}`;
    const res = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(
        conn.accessToken
      )}&access_token=${encodeURIComponent(appAccessToken)}`
    );
    const json = (await res.json()) as {
      data?: {
        is_valid?: boolean;
        expires_at?: number;
        error?: { message?: string };
      };
    };
    if (json.data && json.data.is_valid === false) {
      const msg =
        json.data.error?.message ||
        'Instagram token is no longer valid. Reconnect your Instagram Professional account.';
      conn.lastError = msg;
      conn.updatedAt = new Date().toISOString();
      saveVaultToDisk();
      return { valid: false, error: msg };
    }
    if (json.data?.expires_at && json.data.expires_at > 0) {
      conn.expiresAt = json.data.expires_at * 1000;
    }

    // Proactively refresh non-System-User long-lived USER tokens if expiring within 7 days
    if (
      conn.tokenType === 'USER' &&
      conn.expiresAt &&
      conn.expiresAt - Date.now() < 7 * 86400 * 1000
    ) {
      const llParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: igEnv.appId,
        client_secret: igEnv.appSecret,
        fb_exchange_token: conn.accessToken,
      });
      const llRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${llParams.toString()}`
      );
      const llData = (await llRes.json()) as { access_token?: string; expires_in?: number };
      if (llData.access_token) {
        conn.accessToken = llData.access_token;
        conn.expiresAt = Date.now() + (llData.expires_in || 60 * 86400) * 1000;
      }
    }

    conn.lastError = undefined;
    conn.updatedAt = new Date().toISOString();
    saveVaultToDisk();
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
    onVideoId?: (videoId: string) => void;
  }
): Promise<{ videoId: string; url: string }> {
  const token = await ensureFreshYouTubeToken(conn);
  const metadata = {
    snippet: {
      title: opts.title.slice(0, 100),
      description: opts.description.slice(0, 4900),
      tags: opts.tags.map((t) => t.replace(/^#/, '')).filter(Boolean).slice(0, 15),
      categoryId: '10', // Music
    },
    status: {
      privacyStatus: opts.privacyStatus || 'public',
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(opts.videoBuffer.length),
        'X-Upload-Content-Type': opts.mimeType || 'video/mp4',
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    if (initRes.status === 401 || initRes.status === 403) {
      conn.lastError = 'YouTube authorization expired or missing upload permission.';
      saveVaultToDisk();
    }
    throw new Error(`YouTube upload init failed (${initRes.status}): ${errText}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube did not return a resumable upload location.');
  }

  // Step 2: Upload video bytes
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
  opts.onVideoId?.(result.id);
  return {
    videoId: result.id,
    url: `https://youtube.com/shorts/${result.id}`,
  };
}

function registerTempMedia(buffer: Buffer, mimeType: string, baseUrl?: string): string {
  const token = crypto.randomBytes(20).toString('hex');
  tempMediaStore.set(token, {
    buffer,
    mimeType,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  return `${(baseUrl || getAppBaseUrl()).replace(/\/+$/, '')}/api/temp-media/${token}`;
}

async function waitForInstagramContainer(
  creationId: string,
  accessToken: string,
  maxAttempts = 40
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const statusRes = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(
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
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(
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
    onCreationId?: (creationId: string) => void;
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

  let creationId = '';

  if (opts.platform === 'instagram-reel') {
    const videoUrl = registerTempMedia(opts.mediaItems[0].buffer, opts.mediaItems[0].mimeType, opts.baseUrl);
    const res = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          media_type: 'REELS',
          video_url: videoUrl,
          caption: opts.caption,
        }),
      }
    );
    const data = (await res.json()) as { id?: string; error?: { message: string } };
    if (!res.ok || !data.id) {
      throw new Error(data.error?.message || 'Failed to create Instagram Reel container.');
    }
    creationId = data.id;
    opts.onCreationId?.(creationId);
    await waitForInstagramContainer(creationId, token);
  } else if (opts.platform === 'instagram-carousel' && opts.mediaItems.length > 1) {
    const childIds: string[] = [];
    for (const item of opts.mediaItems.slice(0, 10)) {
      const url = registerTempMedia(item.buffer, item.mimeType, opts.baseUrl);
      const isVid = item.mimeType.startsWith('video/');
      const childRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            is_carousel_item: true,
            ...(isVid ? { media_type: 'VIDEO', video_url: url } : { image_url: url }),
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
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
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
    opts.onCreationId?.(creationId);
    await waitForInstagramContainer(creationId, token);
  } else {
    const first = opts.mediaItems[0];
    const isVid = first.mimeType.startsWith('video/');
    const mediaUrl = registerTempMedia(first.buffer, first.mimeType, opts.baseUrl);
    const res = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...(isVid ? { media_type: 'REELS', video_url: mediaUrl } : { image_url: mediaUrl }),
          caption: opts.caption,
        }),
      }
    );
    const data = (await res.json()) as { id?: string; error?: { message: string } };
    if (!res.ok || !data.id) {
      throw new Error(data.error?.message || 'Failed to create Instagram media container.');
    }
    creationId = data.id;
    opts.onCreationId?.(creationId);
    await waitForInstagramContainer(creationId, token);
  }

  // Publish container
  const pubRes = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igUserId)}/media_publish`,
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
}

async function reconcileDestinationOnPlatform(
  job: ScheduledPublishJob,
  dest: DestinationPublishState
): Promise<{ reconciledPublished: boolean; detail: string }> {
  if (!dest.inFlightId) {
    dest.needsReconciliation = false;
    saveVaultToDisk();
    return {
      reconciledPublished: false,
      detail: 'No in-flight upload ID recorded. Destination is safe to retry.',
    };
  }

  if (dest.platform === 'instagram') {
    const conn = connections.get(connKey(job.workspaceId, 'instagram'));
    if (!conn) {
      return {
        reconciledPublished: false,
        detail: 'Instagram account not connected; reconnect account before reconciling.',
      };
    }
    try {
      const containerRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(
          dest.inFlightId
        )}?fields=status_code,status`,
        { headers: { Authorization: `Bearer ${conn.accessToken}` } }
      );
      const containerJson = (await containerRes.json()) as { status_code?: string; status?: string };
      if (containerJson.status_code === 'PUBLISHED') {
        dest.status = 'published';
        dest.publishedAt = dest.publishedAt || new Date().toISOString();
        dest.needsReconciliation = false;
        dest.error = undefined;
        dest.resultUrl = dest.resultUrl || `https://www.instagram.com/${conn.accountHandle || ''}`;
        saveVaultToDisk();
        return {
          reconciledPublished: true,
          detail: 'Instagram confirmed the interrupted container was already PUBLISHED.',
        };
      }
      dest.needsReconciliation = false;
      dest.error = `Container state: ${containerJson.status_code || 'not published'}. Safe to retry.`;
      saveVaultToDisk();
      return {
        reconciledPublished: false,
        detail: dest.error,
      };
    } catch {
      dest.needsReconciliation = false;
      saveVaultToDisk();
      return {
        reconciledPublished: false,
        detail: 'Could not query container status; destination unlocked for manual retry.',
      };
    }
  } else {
    const conn = connections.get(connKey(job.workspaceId, 'youtube'));
    if (!conn) {
      return {
        reconciledPublished: false,
        detail: 'YouTube account not connected; reconnect channel before reconciling.',
      };
    }
    try {
      const token = await ensureFreshYouTubeToken(conn);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(
          dest.inFlightId
        )}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = (await res.json()) as { items?: Array<{ id: string }> };
      if (res.ok && data.items && data.items.length > 0) {
        dest.status = 'published';
        dest.platformPostId = dest.inFlightId;
        dest.resultUrl = `https://youtube.com/shorts/${dest.inFlightId}`;
        dest.publishedAt = dest.publishedAt || new Date().toISOString();
        dest.needsReconciliation = false;
        dest.error = undefined;
        saveVaultToDisk();
        return {
          reconciledPublished: true,
          detail: `YouTube confirmed video ${dest.inFlightId} is already uploaded.`,
        };
      }
      dest.needsReconciliation = false;
      dest.error = 'No uploaded YouTube video found for interrupted attempt. Safe to retry.';
      saveVaultToDisk();
      return {
        reconciledPublished: false,
        detail: dest.error,
      };
    } catch {
      dest.needsReconciliation = false;
      saveVaultToDisk();
      return {
        reconciledPublished: false,
        detail: 'Could not verify YouTube upload; unlocked for manual retry.',
      };
    }
  }
}

async function sendSingleDestination(
  job: ScheduledPublishJob,
  dest: DestinationPublishState,
  mode: PublishHistoryEntry['mode'],
  baseUrl?: string
): Promise<{ ok: boolean; error?: string; resultUrl?: string; platformPostId?: string }> {
  const lockKey = `${job.id}:${dest.platform}`;
  if (activePublishingKeys.has(lockKey)) {
    throw new Error(`Publishing to ${dest.platform} is already in progress for this post.`);
  }
  if (dest.status === 'published') {
    return {
      ok: true,
      resultUrl: dest.resultUrl,
      platformPostId: dest.platformPostId,
    };
  }
  if (dest.needsReconciliation) {
    const rec = await reconcileDestinationOnPlatform(job, dest);
    if (rec.reconciledPublished) {
      return {
        ok: true,
        resultUrl: dest.resultUrl,
        platformPostId: dest.platformPostId,
      };
    }
  }

  activePublishingKeys.add(lockKey);
  dest.status = 'publishing';
  dest.attempts = (dest.attempts || 0) + 1;
  dest.error = undefined;
  job.attempts = (job.attempts || 0) + 1;
  job.status = 'publishing';
  job.updatedAt = new Date().toISOString();
  saveVaultToDisk();

  try {
    if (dest.platform === 'youtube') {
      const conn = connections.get(connKey(job.workspaceId, 'youtube'));
      if (!conn) {
        throw new Error(`No YouTube account connected for workspace "${job.workspaceId}".`);
      }
      const videoItem = job.mediaItems.find((m) => m.mimeType.startsWith('video/')) || job.mediaItems[0];
      if (!videoItem) {
        throw new Error('YouTube Shorts requires a rendered MP4 video file.');
      }
      const buffer = Buffer.from(videoItem.base64Data, 'base64');
      const tags = dest.youtubeTags && dest.youtubeTags.length > 0 ? dest.youtubeTags : job.hashtags;
      const rawDesc = dest.youtubeDescription !== undefined ? dest.youtubeDescription : job.caption;
      const fullDesc = `${rawDesc}\n\n${tags.join(' ')}`.trim();

      const ytRes = await publishToYouTube(conn, {
        title: (dest.youtubeTitle || job.title || '74 STUDIO Release').trim(),
        description: fullDesc,
        tags,
        videoBuffer: buffer,
        mimeType: videoItem.mimeType,
        privacyStatus: dest.youtubePrivacyStatus || job.youtubePrivacyStatus || 'public',
        onVideoId: (videoId) => {
          dest.inFlightId = videoId;
          saveVaultToDisk();
        },
      });

      dest.status = 'published';
      dest.publishedAt = new Date().toISOString();
      dest.platformPostId = ytRes.videoId;
      dest.resultUrl = ytRes.url;
      dest.error = undefined;
      dest.needsReconciliation = false;
      job.publishedAt = dest.publishedAt;
      job.platformPostId = ytRes.videoId;
      job.resultUrl = ytRes.url;
    } else {
      const conn = connections.get(connKey(job.workspaceId, 'instagram'));
      if (!conn) {
        throw new Error(`No Instagram Professional account connected for workspace "${job.workspaceId}".`);
      }
      const items = job.mediaItems.map((m) => ({
        buffer: Buffer.from(m.base64Data, 'base64'),
        mimeType: m.mimeType,
      }));
      const rawCaption = dest.instagramCaption !== undefined ? dest.instagramCaption : job.caption;
      const fullCaption = `${rawCaption}\n\n${job.hashtags.join(' ')}`.trim();
      const igFormat =
        dest.format === 'youtube-shorts' ? 'instagram-reel' : dest.format;

      const igRes = await publishToInstagram(conn, {
        platform: igFormat,
        caption: fullCaption,
        mediaItems: items,
        baseUrl: baseUrl || job.publicBaseUrl,
        onCreationId: (creationId) => {
          dest.inFlightId = creationId;
          saveVaultToDisk();
        },
      });

      dest.status = 'published';
      dest.publishedAt = new Date().toISOString();
      dest.platformPostId = igRes.mediaId;
      dest.resultUrl = igRes.url;
      dest.error = undefined;
      dest.needsReconciliation = false;
      job.publishedAt = dest.publishedAt;
      job.platformPostId = igRes.mediaId;
      job.resultUrl = igRes.url;
    }

    recordHistory({
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
    dest.status = 'failed';
    dest.error = msg;
    recordHistory({
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
    });
    return { ok: false, error: msg };
  } finally {
    activePublishingKeys.delete(lockKey);
    job.status = computeEffectiveStatus(job);
    const failedMessages = job.destinations
      .filter((d) => d.status === 'failed' && d.error)
      .map((d) => `${d.platform.toUpperCase()}: ${d.error}`);
    job.error = failedMessages.length > 0 ? failedMessages.join(' | ') : undefined;
    job.updatedAt = new Date().toISOString();
    saveVaultToDisk();
  }
}

export function registerSocialIntegrations(app: Express) {
  // Temporary public media endpoint for Instagram Graph API container ingestion
  app.get('/api/temp-media/:token', (req: Request, res: Response) => {
    const token = String(req.params.token || '');
    const entry = tempMediaStore.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      tempMediaStore.delete(token);
      return res.status(404).send('Media expired or not found');
    }
    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Content-Length', String(entry.buffer.length));
    return res.send(entry.buffer);
  });

  // Status of OAuth credentials and workspace connections (never exposes tokens)
  app.get('/api/integrations/status', async (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspaceId || '').trim();
    const shouldVerify = req.query.verify === 'true';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }

    const yt = connections.get(connKey(workspaceId, 'youtube'));
    const ig = connections.get(connKey(workspaceId, 'instagram'));

    if (shouldVerify) {
      if (ig) {
        await verifyInstagramTokenHealth(ig);
      }
      if (yt) {
        await ensureFreshYouTubeToken(yt).catch(() => {});
      }
    }

    const baseUrl = getAppBaseUrl(req);
    const ytEnv = getYouTubeEnv();
    const igEnv = getInstagramEnv();

    return res.json({
      appBaseUrl: baseUrl,
      youtube: {
        configured: ytEnv.configured,
        missingVars: ytEnv.missingVars,
        connected: Boolean(yt),
        accountId: yt?.accountId,
        accountName: yt?.accountName,
        accountHandle: yt?.accountHandle,
        tokenType: yt?.tokenType || 'GOOGLE_OAUTH',
        expiresAt: yt?.expiresAt,
        lastError: yt?.lastError,
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
        accountId: ig?.accountId,
        accountName: ig?.accountName,
        accountHandle: ig?.accountHandle,
        tokenType: ig?.tokenType,
        expiresAt: ig?.expiresAt,
        lastError: ig?.lastError,
        connectedAt: ig?.connectedAt,
        callbackUrl: `${baseUrl}/api/auth/instagram/callback`,
      },
    });
  });

  // 1A. YouTube OAuth URL generator
  app.get('/api/auth/youtube/url', (req: Request, res: Response) => {
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

    cleanupExpired();
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = `${getAppBaseUrl(req)}/api/auth/youtube/callback`;
    pendingStates.set(state, {
      workspaceId,
      platform: 'youtube',
      redirectUri,
      createdAt: Date.now(),
    });
    saveVaultToDisk();

    const params = new URLSearchParams({
      client_id: ytEnv.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  });

  // 1B. YouTube OAuth Callback
  const handleYouTubeCallback = async (req: Request, res: Response) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const errParam = String(req.query.error || '');

    if (errParam) {
      return res.status(400).send(
        `<html><body><p>YouTube authorization declined: ${escapeHtml(errParam)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'youtube',error:${JSON.stringify(errParam)}},'*');window.close();}</script></body></html>`
      );
    }

    const stateEntry = pendingStates.get(state);
    pendingStates.delete(state);
    saveVaultToDisk();
    if (!stateEntry || stateEntry.platform !== 'youtube' || !code) {
      return res.status(400).send('Invalid or expired YouTube OAuth state.');
    }

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
      const prev = connections.get(connKey(stateEntry.workspaceId, 'youtube'));
      const nowIso = new Date().toISOString();

      connections.set(connKey(stateEntry.workspaceId, 'youtube'), {
        workspaceId: stateEntry.workspaceId,
        platform: 'youtube',
        accountId,
        accountName,
        accountHandle: channel.snippet?.customUrl,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || prev?.refreshToken,
        tokenType: 'GOOGLE_OAUTH',
        expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
        lastError: undefined,
        connectedAt: nowIso,
        updatedAt: nowIso,
      });
      saveVaultToDisk();

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

  // 2A. Instagram Unified Login (Facebook Login for Business) OAuth URL generator
  app.get('/api/auth/instagram/url', (req: Request, res: Response) => {
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

    cleanupExpired();
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = `${getAppBaseUrl(req)}/api/auth/instagram/callback`;
    pendingStates.set(state, {
      workspaceId,
      platform: 'instagram',
      redirectUri,
      createdAt: Date.now(),
    });
    saveVaultToDisk();

    const params = new URLSearchParams({
      client_id: igEnv.appId,
      redirect_uri: redirectUri,
      config_id: igEnv.configId,
      response_type: 'code',
      override_default_response_type: 'true',
      state,
    });

    return res.json({
      url: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`,
    });
  });

  // 2B. Instagram Unified Login OAuth Callback
  const handleInstagramCallback = async (req: Request, res: Response) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const errParam = String(req.query.error_description || req.query.error || '');

    if (errParam) {
      return res.status(400).send(
        `<html><body><p>Instagram authorization declined: ${escapeHtml(errParam)}</p><script>if(window.opener){window.opener.postMessage({type:'OAUTH_AUTH_ERROR',platform:'instagram',error:${JSON.stringify(errParam)}},'*');window.close();}</script></body></html>`
      );
    }

    const stateEntry = pendingStates.get(state);
    pendingStates.delete(state);
    saveVaultToDisk();
    if (!stateEntry || stateEntry.platform !== 'instagram' || !code) {
      return res.status(400).send('Invalid or expired Instagram OAuth state.');
    }

    const igEnv = getInstagramEnv();
    if (!igEnv.appId || !igEnv.appSecret) {
      return res.status(500).send('META_APP_ID and META_APP_SECRET are not configured on the server.');
    }

    try {
      const exchangeCode = async (includeRedirectUri: boolean) => {
        const params = new URLSearchParams({
          client_id: igEnv.appId,
          client_secret: igEnv.appSecret,
          code,
        });
        if (includeRedirectUri) {
          params.set('redirect_uri', stateEntry.redirectUri);
        }
        const r = await fetch(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${params.toString()}`
        );
        const json = (await r.json()) as {
          access_token?: string;
          expires_in?: number;
          token_type?: string;
          error?: { message?: string; code?: number };
        };
        return { ok: r.ok, json };
      };

      let tokenExchange = await exchangeCode(true);
      if (!tokenExchange.ok && tokenExchange.json.error?.message?.toLowerCase().includes('redirect_uri')) {
        tokenExchange = await exchangeCode(false);
      }

      if (!tokenExchange.ok || !tokenExchange.json.access_token) {
        throw new Error(
          tokenExchange.json.error?.message || 'Failed to exchange Instagram authorization code.'
        );
      }

      let finalToken = tokenExchange.json.access_token;
      let tokenType: WorkspaceConnection['tokenType'] = 'SYSTEM_USER';
      let expiresAt: number | undefined = tokenExchange.json.expires_in
        ? Date.now() + tokenExchange.json.expires_in * 1000
        : undefined;

      const appAccessToken = `${igEnv.appId}|${igEnv.appSecret}`;
      const debugRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(
          finalToken
        )}&access_token=${encodeURIComponent(appAccessToken)}`
      );
      const debugJson = (await debugRes.json()) as {
        data?: {
          is_valid?: boolean;
          type?: string;
          expires_at?: number;
          scopes?: string[];
          granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
          error?: { message?: string };
        };
      };

      if (debugJson.data) {
        if (debugJson.data.is_valid === false) {
          throw new Error(debugJson.data.error?.message || 'Meta returned an invalid access token.');
        }

        const metaType = (debugJson.data.type || '').toUpperCase();
        if (metaType === 'SYSTEM_USER') {
          tokenType = 'SYSTEM_USER';
          expiresAt =
            debugJson.data.expires_at && debugJson.data.expires_at > 0
              ? debugJson.data.expires_at * 1000
              : undefined;
        } else {
          tokenType = 'USER';
          const remainingSec = debugJson.data.expires_at
            ? debugJson.data.expires_at - Math.floor(Date.now() / 1000)
            : tokenExchange.json.expires_in || 0;

          if (remainingSec > 0 && remainingSec < 7 * 86400) {
            const llParams = new URLSearchParams({
              grant_type: 'fb_exchange_token',
              client_id: igEnv.appId,
              client_secret: igEnv.appSecret,
              fb_exchange_token: finalToken,
            });
            const llRes = await fetch(
              `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${llParams.toString()}`
            );
            const llData = (await llRes.json()) as { access_token?: string; expires_in?: number };
            if (llData.access_token) {
              finalToken = llData.access_token;
              expiresAt = llData.expires_in
                ? Date.now() + llData.expires_in * 1000
                : Date.now() + 60 * 86400 * 1000;
            }
          } else if (debugJson.data.expires_at && debugJson.data.expires_at > 0) {
            expiresAt = debugJson.data.expires_at * 1000;
          }
        }
      }

      let igAccount: { id: string; username?: string; name?: string } | undefined;

      const assignedRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/me/assigned_instagram_accounts?fields=id,username,name`,
        {
          headers: { Authorization: `Bearer ${finalToken}` },
        }
      );
      const assignedData = (await assignedRes.json()) as {
        data?: Array<{ id: string; username?: string; name?: string }>;
      };
      if (assignedRes.ok && assignedData.data && assignedData.data.length > 0) {
        igAccount = assignedData.data[0];
      }

      if (!igAccount && debugJson.data?.granular_scopes) {
        const publishScope = debugJson.data.granular_scopes.find(
          (g) =>
            (g.scope === 'instagram_content_publish' || g.scope === 'instagram_basic') &&
            Array.isArray(g.target_ids) &&
            g.target_ids.length > 0
        );
        const candidateId = publishScope?.target_ids?.[0];
        if (candidateId) {
          const igNodeRes = await fetch(
            `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(
              candidateId
            )}?fields=id,username,name`,
            {
              headers: { Authorization: `Bearer ${finalToken}` },
            }
          );
          const igNode = (await igNodeRes.json()) as { id?: string; username?: string; name?: string };
          if (igNodeRes.ok && igNode.id) {
            igAccount = { id: igNode.id, username: igNode.username, name: igNode.name };
          }
        }
      }

      if (!igAccount) {
        const pagesRes = await fetch(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?fields=name,instagram_business_account{id,username,name}`,
          {
            headers: { Authorization: `Bearer ${finalToken}` },
          }
        );
        const pagesData = (await pagesRes.json()) as {
          data?: Array<{
            name: string;
            instagram_business_account?: { id: string; username?: string; name?: string };
          }>;
        };
        igAccount = pagesData.data?.find((p) => p.instagram_business_account)?.instagram_business_account;
      }

      if (!igAccount) {
        throw new Error(
          'No Instagram Professional (Business or Creator) account was shared during Unified Login. Ensure the Instagram account is selected in the Meta consent prompt and assigned in your Business Portfolio.'
        );
      }

      const accountName = igAccount.name || (igAccount.username ? `@${igAccount.username}` : igAccount.id);
      const nowIso = new Date().toISOString();

      connections.set(connKey(stateEntry.workspaceId, 'instagram'), {
        workspaceId: stateEntry.workspaceId,
        platform: 'instagram',
        accountId: igAccount.id,
        accountName,
        accountHandle: igAccount.username,
        accessToken: finalToken,
        tokenType,
        expiresAt,
        lastError: undefined,
        connectedAt: nowIso,
        updatedAt: nowIso,
      });
      saveVaultToDisk();

      const payload = JSON.stringify({
        type: 'OAUTH_AUTH_SUCCESS',
        platform: 'instagram',
        workspaceId: stateEntry.workspaceId,
        accountName,
      });

      return res.send(
        `<html><body style="background:#09090b;color:#fafafa;font-family:sans-serif;padding:24px;"><p>Instagram connected (@${escapeHtml(
          igAccount.username || accountName
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

  // Disconnect workspace integration
  app.post('/api/integrations/disconnect', (req: Request, res: Response) => {
    const { workspaceId, platform } = req.body as {
      workspaceId: string;
      platform: ConnectedPlatform;
    };
    if (!workspaceId || (platform !== 'youtube' && platform !== 'instagram')) {
      return res.status(400).json({ error: 'Valid workspaceId and platform are required.' });
    }
    connections.delete(connKey(workspaceId, platform));
    saveVaultToDisk();
    return res.json({ ok: true });
  });

  // Immediate Direct Send Endpoint (manual Send Now from Composer without prior schedule)
  app.post('/api/publish/now', async (req: Request, res: Response) => {
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
    const directKey = postId ? `${workspaceId}:${postId}:${destPlatform}` : null;
    if (directKey) {
      const priorDirect = publishedDirectKeys.get(directKey);
      if (priorDirect) {
        return res.status(409).json({
          error: `${destPlatform} was already published for this post (${priorDirect.resultUrl || priorDirect.platformPostId || 'done'}). Duplication prevented.`,
        });
      }
      const existingJob = scheduledJobs.get(`job-${postId}`);
      const existingDest = existingJob?.destinations.find((d) => d.platform === destPlatform);
      if (existingDest?.status === 'published') {
        return res.status(409).json({
          error: `${destPlatform} is already published (${existingDest.resultUrl || existingDest.platformPostId || 'done'}). Duplication prevented.`,
        });
      }
      if (
        activePublishingKeys.has(`job-${postId}:${destPlatform}`) ||
        activePublishingKeys.has(`${postId}:${destPlatform}`)
      ) {
        return res.status(409).json({
          error: `${destPlatform} publish is already in progress. Duplicate request blocked.`,
        });
      }
    }

    const tempJob: ScheduledPublishJob = {
      id: postId ? `job-${postId}` : `pub-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
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
    const outcome = await sendSingleDestination(tempJob, targetDest, 'immediate', getAppBaseUrl(req));
    if (!outcome.ok) {
      return res.status(400).json({ error: outcome.error || 'Publishing failed.' });
    }
    if (directKey) {
      publishedDirectKeys.set(directKey, {
        platformPostId: outcome.platformPostId,
        resultUrl: outcome.resultUrl,
        publishedAt: targetDest.publishedAt || new Date().toISOString(),
      });
      saveVaultToDisk();
    }
    return res.json({
      ok: true,
      resultUrl: outcome.resultUrl,
      platformPostId: outcome.platformPostId,
      publishedAt: targetDest.publishedAt,
    });
  });

  // Scheduled Queue & History Management (NO automatic background publishing)
  app.get('/api/scheduled-jobs', (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspaceId || '').trim();
    const list = Array.from(scheduledJobs.values())
      .filter((j) => !workspaceId || j.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(serializeJobSummary);
    return res.json({ jobs: list });
  });

  // Serve stored media preview for confirmation modal
  app.get('/api/scheduled-jobs/:id/media/:index', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const index = Number(req.params.index || 0);
    const job = scheduledJobs.get(id);
    if (!job || Number.isNaN(index) || index < 0 || index >= job.mediaItems.length) {
      return res.status(404).send('Media preview not found.');
    }
    const item = job.mediaItems[index];
    const buf = Buffer.from(item.base64Data, 'base64');
    res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    return res.send(buf);
  });

  app.get('/api/publish-history', (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspaceId || '').trim();
    const history = publishHistory.filter((h) => !workspaceId || h.workspaceId === workspaceId);
    return res.json({ history });
  });

  // Create or Update a Scheduled / Draft / Rehydrated post in the authoritative Schedule & Send queue
  app.post('/api/scheduled-jobs', (req: Request, res: Response) => {
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
    const existing = scheduledJobs.get(id);
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
    const resolvedMediaItems =
      body.mediaItems && body.mediaItems.length > 0
        ? body.mediaItems
        : existing?.mediaItems || [];
    const preservedMediaCount =
      resolvedMediaItems.length > 0
        ? resolvedMediaItems.length
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
    job.status = computeEffectiveStatus(job);
    scheduledJobs.set(id, job);
    saveVaultToDisk();

    return res.json({
      ok: true,
      job: serializeJobSummary(job),
    });
  });

  app.patch('/api/scheduled-jobs/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const job = scheduledJobs.get(id);
    if (!job) {
      return res.status(404).json({ error: 'Scheduled post not found.' });
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

    job.status = computeEffectiveStatus(job);
    job.updatedAt = new Date().toISOString();
    saveVaultToDisk();

    return res.json({
      ok: true,
      job: serializeJobSummary(job),
    });
  });

  // Explicit Manual Send Now endpoint (supports independent or dual-platform publishing)
  app.post('/api/scheduled-jobs/:id/send', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const job = scheduledJobs.get(id);
    if (!job) {
      return res.status(404).json({ error: 'Scheduled post not found.' });
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

    if (body.mediaItems && body.mediaItems.length > 0 && job.mediaItems.length === 0) {
      job.mediaItems = body.mediaItems;
    }

    const requestedTargets =
      body.targets && body.targets.length > 0
        ? Array.from(new Set(body.targets))
        : job.destinations.filter((d) => d.status !== 'published' && d.status !== 'cancelled').map((d) => d.platform);

    if (requestedTargets.length === 0) {
      return res.status(409).json({
        error: 'All selected destinations have already been published.',
        job: serializeJobSummary(job),
      });
    }

    // Check duplicate in-flight lock or already-published state before doing any work
    for (const target of requestedTargets) {
      const dest = job.destinations.find((d) => d.platform === target);
      if (!dest) {
        return res.status(400).json({ error: `Destination "${target}" is not configured on this post.` });
      }
      if (dest.status === 'published') {
        return res.status(409).json({
          error: `${target} is already published (${dest.resultUrl || dest.platformPostId || 'done'}). Duplication prevented.`,
          job: serializeJobSummary(job),
        });
      }
      if (activePublishingKeys.has(`${job.id}:${target}`) || dest.status === 'publishing') {
        return res.status(409).json({
          error: `${target} publish is already in progress. Duplicate request blocked.`,
        });
      }
    }

    // Apply confirmation dialog edits cleanly before sending
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
    const results: Record<string, { ok: boolean; resultUrl?: string; platformPostId?: string; error?: string }> = {};

    for (const target of requestedTargets) {
      const dest = job.destinations.find((d) => d.platform === target)!;
      const mode: PublishHistoryEntry['mode'] = dest.attempts > 0 ? 'retry' : 'manual-send';
      results[target] = await sendSingleDestination(job, dest, mode, baseUrl);
    }

    const summary = serializeJobSummary(job);
    const anySucceeded = Object.values(results).some((r) => r.ok);
    const allSucceeded = Object.values(results).every((r) => r.ok);

    if (!anySucceeded) {
      const firstErr = Object.values(results).find((r) => r.error)?.error || 'Publishing failed.';
      return res.status(400).json({
        ok: false,
        error: firstErr,
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
  });

  // Explicit Reconciliation Endpoint when a network disconnect happened mid-publish
  app.post('/api/scheduled-jobs/:id/reconcile', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const job = scheduledJobs.get(id);
    if (!job) {
      return res.status(404).json({ error: 'Scheduled post not found.' });
    }
    const platform = req.body?.platform as ConnectedPlatform | undefined;
    const targets = job.destinations.filter(
      (d) => (!platform || d.platform === platform) && (d.needsReconciliation || d.status === 'failed' || d.status === 'publishing')
    );

    const outcomes: Record<string, { reconciledPublished: boolean; detail: string }> = {};
    for (const dest of targets) {
      outcomes[dest.platform] = await reconcileDestinationOnPlatform(job, dest);
    }
    job.status = computeEffectiveStatus(job);
    job.updatedAt = new Date().toISOString();
    saveVaultToDisk();

    return res.json({
      ok: true,
      outcomes,
      job: serializeJobSummary(job),
    });
  });

  // Backwards-compatible retry endpoint delegating cleanly to manual non-duplicating send
  app.post('/api/scheduled-jobs/:id/retry', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const job = scheduledJobs.get(id);
    if (!job) {
      return res.status(404).json({ error: 'Scheduled post not found.' });
    }
    if (job.status === 'published' || job.status === 'publishing') {
      return res.status(409).json({ error: `Job is already ${job.status}.` });
    }

    const targets = (req.body?.targets as ConnectedPlatform[] | undefined) ||
      job.destinations.filter((d) => d.status !== 'published' && d.status !== 'cancelled').map((d) => d.platform);

    const baseUrl = getAppBaseUrl(req);
    const results: Record<string, { ok: boolean; resultUrl?: string; error?: string }> = {};
    for (const target of targets) {
      const dest = job.destinations.find((d) => d.platform === target);
      if (dest && dest.status !== 'published') {
        results[target] = await sendSingleDestination(job, dest, 'retry', baseUrl);
      }
    }

    const summary = serializeJobSummary(job);
    const anyFailed = Object.values(results).some((r) => !r.ok);
    const allFailed = Object.values(results).every((r) => !r.ok);
    if (allFailed) {
      return res.status(400).json({ error: summary.error || 'Retry failed.', job: summary });
    }
    return res.json({
      ok: !anyFailed,
      partial: anyFailed,
      resultUrl: summary.resultUrl,
      status: summary.status,
      job: summary,
    });
  });

  app.post('/api/scheduled-jobs/:id/cancel', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const job = scheduledJobs.get(id);
    if (!job) {
      return res.status(404).json({ error: 'Scheduled post not found.' });
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
    job.updatedAt = new Date().toISOString();
    saveVaultToDisk();
    return res.json({ ok: true, status: job.status, job: serializeJobSummary(job) });
  });

  app.delete('/api/scheduled-jobs/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    scheduledJobs.delete(id);
    saveVaultToDisk();
    return res.json({ ok: true });
  });
}
