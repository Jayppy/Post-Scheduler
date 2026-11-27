import crypto from 'crypto';
import express, { type Express, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Type } from '@google/genai';
import type {
  CartoonBackgroundPreset,
  CartoonCharacterId,
  CartoonPropId,
  MotionChartType,
  SceneTransitionType,
  StickmanAction,
  VideoGenerationProviderStatus,
  VideoProject,
  VideoRenderRecord,
  VideoScene,
  VideoStyle,
} from '../src/types/videoStudio';
import {
  type AuthenticatedRequest,
  isProductionRuntime,
  requireServerOperator,
} from './aiProviders/authMiddleware';
import { executeAiTask } from './aiProviders/providerManager';
import { getDataDirPath } from './tokenCrypto';
import {
  assertSyncOk,
  callSupabaseRpc,
  deleteRowFromSupabase,
  fetchRowsFromSupabase,
  SupabasePersistenceError,
  syncRowsToSupabase,
} from './supabase/syncHelper';
import {
  createSignedStorageUrl,
  downloadStorageObjectToFile,
  getLegacySafeStorageOwnerPrefix,
  getSafeStorageOwnerPrefix,
  getSupabaseAdmin,
  getSupabaseConfigDiagnostics,
  inspectStorageObjectMetadata,
  isLosslessLegacyPrefixOwner,
  isSupabaseConfigured,
  removeStorageObjects,
  uploadToSupabaseBucket,
} from './supabase/client';
import { probeAndValidateMp4 } from './videoTranscoder';
import { aiGenerationLimiter, videoUploadLimiter } from './rateLimiters';

function getScopeKey(req: AuthenticatedRequest): string {
  const uid = req.operatorContext?.ownerScopeKey?.trim();
  if (!uid) {
    throw Object.assign(new Error('Authenticated owner identity could not be resolved.'), {
      statusCode: 401,
    });
  }
  return uid;
}

const DATA_DIR = getDataDirPath();
const MAX_SUPABASE_RENDER_BYTES = 100 * 1024 * 1024; // Matches video-studio bucket fileSizeLimit
const MAX_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB max per chunk
const MAX_CONCURRENT_UPLOADS_PER_OWNER = 3;
const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

interface DevChunkUploadSession {
  uploadId: string;
  ownerScopeKey: string;
  projectId: string;
  renderId: string;
  format: 'mp4' | 'webm';
  mimeType: string;
  totalChunks: number;
  totalBytes: number;
  expectedSha256?: string;
  workDir: string;
  receivedChunks: Map<number, { size: number; sha256: string }>;
  status: 'active' | 'completing' | 'completed';
  storagePath?: string;
  storageBucket?: string;
  bytesUploaded?: number;
  createdAt: number;
  updatedAt: number;
}

// Local dev fallback ONLY when Supabase is unconfigured in non-production runtime
const devChunkUploadSessions = new Map<string, DevChunkUploadSession>();
const DEV_UPLOAD_SESSIONS_ROOT = path.join(DATA_DIR, 'video-studio-uploads');

export function cleanupExpiredUploadSessions(nowMs: number = Date.now()): void {
  const cutoff = nowMs - UPLOAD_SESSION_TTL_MS;
  const protectedDirs = new Set<string>();
  for (const [id, sess] of devChunkUploadSessions.entries()) {
    if (sess.status === 'completing') {
      protectedDirs.add(path.resolve(sess.workDir));
      continue;
    }
    if (sess.updatedAt < cutoff) {
      fs.rmSync(sess.workDir, { recursive: true, force: true });
      devChunkUploadSessions.delete(id);
    } else {
      protectedDirs.add(path.resolve(sess.workDir));
    }
  }

  try {
    if (fs.existsSync(DEV_UPLOAD_SESSIONS_ROOT)) {
      for (const entry of fs.readdirSync(DEV_UPLOAD_SESSIONS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const fullDir = path.resolve(DEV_UPLOAD_SESSIONS_ROOT, entry.name);
        if (protectedDirs.has(fullDir)) continue;
        const stat = fs.statSync(fullDir);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullDir, { recursive: true, force: true });
        }
      }
    }
  } catch {
    // Best-effort dev cleanup
  }
}

function handleRouteError(res: Response, err: unknown, fallbackMsg: string) {
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

interface SupabaseVideoProjectRow {
  id: string;
  owner_uid: string;
  workspace_id: string;
  title: string;
  topic: string;
  audience: string;
  destination?: VideoProject['destination'] | null;
  workflow_stage?: VideoProject['workflowStage'] | null;
  visual_style: VideoStyle;
  aspect_ratio?: string;
  target_duration_sec: number;
  fps?: number;
  status: VideoProject['status'];
  script_approved: boolean;
  storyboard_json?: VideoScene[] | null;
  audio_config_json?: VideoProject['audio'] | null;
  settings_json?: VideoProject['captionStyle'] | null;
  created_at: string;
  updated_at: string;
}

interface SupabaseVideoScriptRow {
  id: string;
  owner_uid: string;
  project_id: string;
  hook_line?: string | null;
  full_script?: string | null;
  closing_cta?: string | null;
  provider_id?: string | null;
  model?: string | null;
  was_fallback?: boolean | null;
  approved?: boolean | null;
  meta_json?: {
    bodySummary?: string;
    educationalTakeaway?: string;
    suggestedCaption?: string;
    hashtags?: string[];
    estimatedDurationSeconds?: number;
    targetDurationSeconds?: number;
  } | null;
  created_at?: string;
  updated_at?: string;
}

interface SupabaseVideoSceneRow {
  id: string;
  owner_uid: string;
  project_id: string;
  scene_order: number;
  visual_style: VideoStyle;
  duration_sec: number;
  narration_text: string;
  on_screen_text?: string;
  stickman_config_json?: VideoScene['stickman'];
  cartoon_config_json?: VideoScene['cartoon'];
  motion_config_json?: VideoScene['motion'];
  subtitle_words_json?: string[];
  transition_type?: SceneTransitionType;
  background_preset?: CartoonBackgroundPreset;
}

interface SupabaseVideoRenderRow {
  id: string;
  owner_uid: string;
  project_id: string;
  format: 'mp4' | 'webm';
  width: number;
  height: number;
  fps: number;
  duration_sec: number;
  status: VideoRenderRecord['status'];
  progress_pct: number;
  checkpoint_json?: {
    engine?: VideoRenderRecord['engine'];
    lastCheckpointFrame?: number;
  } | null;
  storage_path?: string | null;
  storage_bucket?: string | null;
  sha256?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

interface SupabaseUploadSessionRow {
  upload_id: string;
  owner_uid: string;
  workspace_id: string;
  project_id: string;
  render_id: string;
  format: 'mp4' | 'webm';
  mime_type: string;
  total_chunks: number;
  total_bytes: number;
  expected_sha256?: string | null;
  assembled_sha256?: string | null;
  storage_bucket: string;
  storage_path?: string | null;
  bytes_uploaded?: number | null;
  received_chunks_json: Record<string, { size: number; sha256: string; objectPath: string; uploadedAt?: string }>;
  status: 'active' | 'completing' | 'completed' | 'expired' | 'failed';
  completion_lease_token?: string | null;
  completion_lease_expires_at?: string | null;
  chunks_cleaned_at?: string | null;
  error_message?: string | null;
  expires_at: string;
}

function hydrateRenderRow(r: SupabaseVideoRenderRow): VideoRenderRecord {
  const resStr = `${Number(r.width) || 1080}x${Number(r.height) || 1920}`;
  const validResolution: VideoRenderRecord['resolution'] =
    resStr === '540x960' || resStr === '1920x1080' ? resStr : '1080x1920';
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status || 'completed',
    format: r.format === 'webm' ? 'webm' : 'mp4',
    resolution: validResolution,
    fps: Number(r.fps) || 30,
    durationSeconds: Number(r.duration_sec) || 75,
    engine: r.checkpoint_json?.engine || 'remotion-web',
    storagePath: r.storage_path || undefined,
    storageBucket: r.storage_path ? r.storage_bucket || 'video-studio' : undefined,
    progress: Number(r.progress_pct ?? 100),
    lastCheckpointFrame: r.checkpoint_json?.lastCheckpointFrame,
    error: r.error_message || undefined,
    createdAt: r.created_at,
  };
}

function hydrateProjectFromSupabaseRows(
  p: SupabaseVideoProjectRow,
  scriptRow: SupabaseVideoScriptRow | undefined,
  sceneRows: SupabaseVideoSceneRow[],
  renderRows: SupabaseVideoRenderRow[]
): VideoProject {
  const scenesFromJson = Array.isArray(p.storyboard_json) && p.storyboard_json.length > 0 ? p.storyboard_json : null;
  const scenes: VideoScene[] = scenesFromJson
    ? scenesFromJson
    : [...sceneRows]
        .sort((a, b) => (a.scene_order ?? 0) - (b.scene_order ?? 0))
        .map((sc, idx) => ({
          id: sc.id,
          orderIndex: sc.scene_order ?? idx,
          title: sc.on_screen_text || `Scene ${idx + 1}`,
          durationSeconds: Number(sc.duration_sec) || 7,
          style: sc.visual_style || p.visual_style || 'hybrid',
          narrationText: sc.narration_text || '',
          subtitleText: Array.isArray(sc.subtitle_words_json)
            ? sc.subtitle_words_json.join(' ')
            : sc.narration_text || '',
          visualDirection: '',
          stickman: sc.stickman_config_json || {
            enabled: true,
            action: 'explaining',
            bodyColor: '#f4f4f5',
            outlineColor: '#18181b',
            headShape: 'circle',
            headScale: 1,
            limbThickness: 8,
            expression: 'focused',
            accessories: [],
            positionX: 50,
            positionY: 62,
            scale: 1,
          },
          cartoon: sc.cartoon_config_json || {
            enabled: false,
            backgroundPreset: sc.background_preset || 'recording-studio',
            characterId: 'artist',
            characterColor: '#e4e4e7',
            accentColor: '#f59e0b',
            props: ['condenser-mic'],
          },
          motion: sc.motion_config_json || {
            headline: sc.on_screen_text || `Scene ${idx + 1}`,
            highlightWords: [],
            chartType: 'none',
            transition: sc.transition_type || 'crossfade',
            accentColor: '#f59e0b',
            backgroundColor: '#09090b',
          },
        }));

  const fullNarration =
    scriptRow?.full_script || scenes.map((s) => s.narrationText).filter(Boolean).join(' ');
  const meta = scriptRow?.meta_json || {};
  const targetDur = Number(p.target_duration_sec) || 75;

  const inferredStage: VideoProject['workflowStage'] =
    p.workflow_stage ||
    (p.status === 'rendered' ? 'export' : p.script_approved ? 'storyboard' : 'script');

  return {
    id: p.id,
    workspaceId: 'ws-behind-the-release',
    title: p.title,
    topic: p.topic || p.title,
    audience: p.audience || 'Independent recording artists and producers',
    destination: p.destination || 'both',
    primaryStyle: p.visual_style || 'hybrid',
    targetDurationSeconds: targetDur,
    workflowStage: inferredStage,
    approvedForRender: Boolean(p.script_approved),
    status: p.status || 'script-ready',
    script: {
      id: scriptRow?.id || `scr_${p.id}`,
      hook: scriptRow?.hook_line || scenes[0]?.narrationText || '',
      bodySummary: meta.bodySummary || '',
      closingCta: scriptRow?.closing_cta || scenes[scenes.length - 1]?.narrationText || '',
      fullNarration,
      estimatedDurationSeconds: meta.estimatedDurationSeconds || targetDur,
      targetDurationSeconds: meta.targetDurationSeconds || targetDur,
      educationalTakeaway: meta.educationalTakeaway || p.topic || '',
      suggestedCaption: meta.suggestedCaption || `${p.title} — Behind The Release`,
      hashtags: Array.isArray(meta.hashtags) && meta.hashtags.length > 0
        ? meta.hashtags
        : ['#behindtherelease', '#independentartist'],
      providerId: (scriptRow?.provider_id as VideoProject['script']['providerId']) || 'fallback',
      model: scriptRow?.model || undefined,
      wasFallback: Boolean(scriptRow?.was_fallback),
    },
    scenes,
    audio: p.audio_config_json || {
      narrationVolume: 1,
      bgmVolume: 0.25,
      sfxEnabled: true,
      sfxVolume: 0.4,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 1.0,
      trimStartSeconds: 0,
    },
    captionStyle: p.settings_json || {
      position: 'bottom',
      highlightColor: '#f59e0b',
      fontSize: 44,
      showProgressBar: true,
      showBrandWatermark: true,
    },
    renders: [...renderRows]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map(hydrateRenderRow),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

async function listProjectsAuthoritative(scopeKey: string): Promise<VideoProject[]> {
  if (isSupabaseConfigured()) {
    const [projRows, scriptRows, sceneRows, renderRows] = await Promise.all([
      fetchRowsFromSupabase<SupabaseVideoProjectRow>(
        'video_projects',
        scopeKey,
        { column: 'updated_at', ascending: false },
        { workspace_id: 'ws-behind-the-release' }
      ).then((r) => assertSyncOk(r) || []),
      fetchRowsFromSupabase<SupabaseVideoScriptRow>('video_scripts', scopeKey).then(
        (r) => assertSyncOk(r) || []
      ),
      fetchRowsFromSupabase<SupabaseVideoSceneRow>('video_scenes', scopeKey).then(
        (r) => assertSyncOk(r) || []
      ),
      fetchRowsFromSupabase<SupabaseVideoRenderRow>('video_renders', scopeKey).then(
        (r) => assertSyncOk(r) || []
      ),
    ]);

    const scriptsByProject = new Map<string, SupabaseVideoScriptRow>();
    for (const sr of scriptRows) scriptsByProject.set(sr.project_id, sr);

    const scenesByProject = new Map<string, SupabaseVideoSceneRow[]>();
    for (const sc of sceneRows) {
      const list = scenesByProject.get(sc.project_id) || [];
      list.push(sc);
      scenesByProject.set(sc.project_id, list);
    }

    const rendersByProject = new Map<string, SupabaseVideoRenderRow[]>();
    for (const rn of renderRows) {
      const list = rendersByProject.get(rn.project_id) || [];
      list.push(rn);
      rendersByProject.set(rn.project_id, list);
    }

    return projRows.map((p) =>
      hydrateProjectFromSupabaseRows(
        p,
        scriptsByProject.get(p.id),
        scenesByProject.get(p.id) || [],
        rendersByProject.get(p.id) || []
      )
    );
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production for Video Studio persistence.',
      retriable: false,
      statusCode: 503,
    });
  }

  const store = loadStore(scopeKey);
  return [...store.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function getProjectAuthoritative(scopeKey: string, projectId: string): Promise<VideoProject | null> {
  if (isSupabaseConfigured()) {
    const [projRows, scriptRows, sceneRows, renderRows] = await Promise.all([
      fetchRowsFromSupabase<SupabaseVideoProjectRow>('video_projects', scopeKey, undefined, {
        id: projectId,
        workspace_id: 'ws-behind-the-release',
      }).then((r) => assertSyncOk(r) || []),
      fetchRowsFromSupabase<SupabaseVideoScriptRow>('video_scripts', scopeKey, undefined, {
        project_id: projectId,
      }).then((r) => assertSyncOk(r) || []),
      fetchRowsFromSupabase<SupabaseVideoSceneRow>('video_scenes', scopeKey, undefined, {
        project_id: projectId,
      }).then((r) => assertSyncOk(r) || []),
      fetchRowsFromSupabase<SupabaseVideoRenderRow>('video_renders', scopeKey, undefined, {
        project_id: projectId,
      }).then((r) => assertSyncOk(r) || []),
    ]);

    const p = projRows[0];
    if (!p) return null;
    return hydrateProjectFromSupabaseRows(p, scriptRows[0], sceneRows, renderRows);
  }

  if (isProductionRuntime()) {
    throw new SupabasePersistenceError({
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: 'Supabase must be configured in production for Video Studio persistence.',
      retriable: false,
      statusCode: 503,
    });
  }

  const store = loadStore(scopeKey);
  return (
    store.projects.find((p) => p.id === projectId && p.workspaceId === 'ws-behind-the-release') || null
  );
}

async function verifyVideoProjectOwnership(
  scopeKey: string,
  projectId: string
): Promise<{ project: VideoProject | null; owned: boolean }> {
  const project = await getProjectAuthoritative(scopeKey, projectId);
  return { project, owned: Boolean(project) };
}

async function findExistingStorageRenderObject(
  ownerUid: string,
  projectId: string,
  renderId: string,
  format: 'mp4' | 'webm',
  expectedBytes?: number,
  knownStoragePath?: string
): Promise<{ exists: boolean; objectPath: string; size?: number; signedUrl?: string }> {
  const client = getSupabaseAdmin();
  const safeOwner = getSafeStorageOwnerPrefix(ownerUid);
  const fileName = `${renderId}.${format}`;
  const canonicalObjectPath = `${safeOwner}/${projectId}/${fileName}`;
  if (!client) {
    return { exists: false, objectPath: canonicalObjectPath };
  }

  const candidates: string[] = [];
  if (knownStoragePath && !candidates.includes(knownStoragePath)) {
    candidates.push(knownStoragePath);
  }

  // DB-record-first resolution for any pre-Phase-1.5 object path belonging strictly to this ownerUid
  const { data: renderRow } = await client
    .from('video_renders')
    .select('storage_path')
    .eq('owner_uid', ownerUid)
    .eq('project_id', projectId)
    .eq('id', renderId)
    .maybeSingle();
  const dbPath = (renderRow as { storage_path?: string | null } | null)?.storage_path;
  if (dbPath && !candidates.includes(dbPath)) {
    candidates.push(dbPath);
  }

  if (!candidates.includes(canonicalObjectPath)) {
    candidates.push(canonicalObjectPath);
  }

  // Read-only legacy prefix check ONLY when ownerUid maps losslessly without collision risk
  if (isLosslessLegacyPrefixOwner(ownerUid)) {
    const legacyPath = `${getLegacySafeStorageOwnerPrefix(ownerUid)}/${projectId}/${fileName}`;
    if (!candidates.includes(legacyPath)) {
      candidates.push(legacyPath);
    }
  }

  for (const candidatePath of candidates) {
    const meta = await inspectStorageObjectMetadata('video-studio', candidatePath);
    if (!meta.exists) continue;
    if (
      typeof expectedBytes === 'number' &&
      expectedBytes > 0 &&
      typeof meta.size === 'number' &&
      meta.size > 0 &&
      meta.size !== expectedBytes
    ) {
      continue;
    }
    const signed = await createSignedStorageUrl('video-studio', candidatePath, 3600);
    return {
      exists: true,
      objectPath: candidatePath,
      size: meta.size || expectedBytes,
      signedUrl: signed.ok ? signed.signedUrl : undefined,
    };
  }

  return { exists: false, objectPath: canonicalObjectPath };
}

const STICKMAN_ACTIONS: StickmanAction[] = [
  'idle',
  'walking',
  'pointing',
  'thinking',
  'celebrating',
  'explaining',
  'typing',
  'presenting',
  'head-shake',
  'nodding',
  'holding-mic',
  'working-at-desk',
  'looking-at-phone',
  'showing-chart',
  'reacting-surprised',
  'crossed-arms',
  'thumbs-up',
  'waving',
];

const CARTOON_BACKGROUNDS: CartoonBackgroundPreset[] = [
  'recording-studio',
  'vocal-booth',
  'desk-setup',
  'stage-spotlight',
  'mobile-analytics',
  'minimal-dark',
];

const CARTOON_CHARACTERS: CartoonCharacterId[] = [
  'artist',
  'producer',
  'engineer',
  'creator',
  'none',
];

const CARTOON_PROPS: CartoonPropId[] = [
  'condenser-mic',
  'studio-monitors',
  'laptop-daw',
  'vinyl-record',
  'waveform',
  'stream-counter',
  'phone-ui',
  'cash-stack',
];

const TRANSITIONS: SceneTransitionType[] = [
  'cut',
  'crossfade',
  'slide-up',
  'zoom-punch',
  'flash',
];

interface VideoStudioStore {
  projects: VideoProject[];
  updatedAt: string;
}

function getStorePath(scopeKey: string): string {
  const safe = scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = safe === 'local-preview' ? '' : `-${safe}`;
  return path.join(DATA_DIR, `video-studio${suffix}.json`);
}

function loadStore(scopeKey: string): VideoStudioStore {
  const filePath = getStorePath(scopeKey);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<VideoStudioStore>;
      if (Array.isArray(parsed.projects)) {
        return {
          projects: parsed.projects,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn('Could not read video studio store:', err);
  }
  return { projects: [], updatedAt: new Date().toISOString() };
}

function saveStore(scopeKey: string, store: VideoStudioStore): void {
  store.updatedAt = new Date().toISOString();
  const filePath = getStorePath(scopeKey);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, filePath);
}

function clampDuration60To90(raw: number | undefined): number {
  const num = Number(raw) || 75;
  return Math.max(60, Math.min(90, Math.round(num)));
}

function sanitizeAction(raw: string | undefined, fallback: StickmanAction = 'explaining'): StickmanAction {
  if (raw && STICKMAN_ACTIONS.includes(raw as StickmanAction)) {
    return raw as StickmanAction;
  }
  return fallback;
}

function sanitizeBackground(raw: string | undefined): CartoonBackgroundPreset {
  if (raw && CARTOON_BACKGROUNDS.includes(raw as CartoonBackgroundPreset)) {
    return raw as CartoonBackgroundPreset;
  }
  return 'recording-studio';
}

function sanitizeCharacter(raw: string | undefined): CartoonCharacterId {
  if (raw && CARTOON_CHARACTERS.includes(raw as CartoonCharacterId)) {
    return raw as CartoonCharacterId;
  }
  return 'artist';
}

function sanitizeProps(raw: unknown): CartoonPropId[] {
  if (!Array.isArray(raw)) return ['condenser-mic', 'waveform'];
  const valid = raw.filter((p): p is CartoonPropId =>
    typeof p === 'string' && CARTOON_PROPS.includes(p as CartoonPropId)
  );
  return valid.length > 0 ? valid.slice(0, 4) : ['condenser-mic'];
}

function sanitizeStyle(raw: string | undefined, primary: VideoStyle): VideoStyle {
  if (raw === 'stickman' || raw === 'cartoon-2d' || raw === 'motion-graphics' || raw === 'hybrid') {
    return raw;
  }
  return primary;
}

function normalizeSceneDurations(scenes: VideoScene[], targetDurationSeconds: number): VideoScene[] {
  if (scenes.length === 0) return scenes;
  const target = clampDuration60To90(targetDurationSeconds);
  const rawTotal = scenes.reduce((acc, s) => acc + Math.max(4, Number(s.durationSeconds) || 7), 0);
  const factor = target / rawTotal;
  const scaled = scenes.map((s) => ({
    ...s,
    durationSeconds: Math.max(4, Math.min(18, Math.round((Math.max(4, Number(s.durationSeconds) || 7) * factor) * 2) / 2)),
  }));
  const currentTotal = scaled.reduce((acc, s) => acc + s.durationSeconds, 0);
  const diff = Number((target - currentTotal).toFixed(1));
  if (Math.abs(diff) >= 0.5 && scaled.length > 0) {
    const lastIdx = scaled.length - 1;
    scaled[lastIdx].durationSeconds = Math.max(4, Number((scaled[lastIdx].durationSeconds + diff).toFixed(1)));
  }
  return scaled.map((s, idx) => ({ ...s, orderIndex: idx }));
}

function buildDeterministicFallbackProject(input: {
  topic: string;
  audience: string;
  style: VideoStyle;
  targetDurationSeconds: number;
  destination: VideoProject['destination'];
}): VideoProject {
  const target = clampDuration60To90(input.targetDurationSeconds);
  const id = `vid_${crypto.randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  const baseTopic = input.topic.trim() || 'How Independent Artists Structure a 4-Week Release Rollout';

  const templateBeats: Array<{
    title: string;
    action: StickmanAction;
    bg: CartoonBackgroundPreset;
    chart: MotionChartType;
    headline: string;
    subheadline: string;
    narration: string;
    kpiValue?: string;
    kpiLabel?: string;
    highlightWords: string[];
  }> = [
    {
      title: 'Hook — The Drop Mistake',
      action: 'reacting-surprised',
      bg: 'recording-studio',
      chart: 'none',
      headline: 'Stop Dropping Singles Cold',
      subheadline: baseTopic,
      narration: 'Most independent artists spend months perfecting the mix and then upload the song on Friday with zero runway.',
      highlightWords: ['Stop', 'Friday', 'zero'],
    },
    {
      title: 'Problem Breakdown',
      action: 'head-shake',
      bg: 'mobile-analytics',
      chart: 'bar',
      headline: 'Day-One Spike vs Flatline',
      subheadline: 'Why algorithmic momentum stalls without pre-release signals',
      narration: 'When listeners hear about a track for the first time on release day, saves and repeat streams lag behind platform triggers.',
      kpiValue: '-68%',
      kpiLabel: 'Week-2 retention drop',
      highlightWords: ['release day', 'saves', 'platform'],
    },
    {
      title: 'The 4-Week Framework',
      action: 'presenting',
      bg: 'desk-setup',
      chart: 'timeline',
      headline: 'Four Intentional Checkpoints',
      subheadline: 'Turn one master track into 14 pieces of native storytelling',
      narration: 'Instead, map your release into four focused weeks: master prep, story teaser, pre-save proof, and post-drop momentum.',
      highlightWords: ['four', 'master', 'momentum'],
    },
    {
      title: 'Step 1 — Mix & Sonic Identity',
      action: 'holding-mic',
      bg: 'vocal-booth',
      chart: 'none',
      headline: 'Lock Mastering & Stem Snippets',
      subheadline: 'Export clean 15s hook cuts alongside final 24-bit masters',
      narration: 'Week one starts in the studio: pull acapella hooks, instrumental breakdowns, and voice-memo stories while the mix is fresh.',
      highlightWords: ['Week one', 'hooks', 'fresh'],
    },
    {
      title: 'Step 2 — Visual World',
      action: 'explaining',
      bg: 'recording-studio',
      chart: 'comparison',
      headline: 'Template Promo vs Story Narrative',
      subheadline: 'Give listeners a reason to care before the link drops',
      narration: 'Skip generic cover-art slideshows. Show the chord progression, the lyric tension, and what almost stayed off the record.',
      highlightWords: ['generic', 'tension', 'record'],
    },
    {
      title: 'Step 3 — Short-Form Engine',
      action: 'showing-chart',
      bg: 'mobile-analytics',
      chart: 'line',
      headline: 'Compound Watch-Time Signals',
      subheadline: 'Consistent hooks train discovery feeds before release Friday',
      narration: 'Publish three educational or behind-the-scenes clips ahead of drop week so warm fans recognize the chorus immediately.',
      kpiValue: '3.2x',
      kpiLabel: 'Pre-save conversion lift',
      highlightWords: ['three', 'chorus', 'warm'],
    },
    {
      title: 'Step 4 — Release Week Focus',
      action: 'working-at-desk',
      bg: 'desk-setup',
      chart: 'flowchart',
      headline: 'Route Attention To One Action',
      subheadline: 'Every caption & comment points to one listening link',
      narration: 'On launch week, simplify your ask. Send viewers to one primary streaming link or full mix breakdown without clutter.',
      highlightWords: ['simplify', 'one', 'link'],
    },
    {
      title: 'Week 2+ Sustain',
      action: 'celebrating',
      bg: 'stage-spotlight',
      chart: 'none',
      headline: 'Extend The Release Shelf Life',
      subheadline: 'Acoustic cuts, lyric annotations & studio commentary',
      narration: 'Your release does not end on Sunday. Repurpose studio sessions and fan reactions across weeks two and three.',
      highlightWords: ['Sunday', 'Repurpose', 'three'],
    },
    {
      title: 'Takeaway & Call to Action',
      action: 'pointing',
      bg: 'minimal-dark',
      chart: 'none',
      headline: 'Save This Release Blueprint',
      subheadline: 'Behind The Release — Artist Education Series',
      narration: 'Save this breakdown before your next drop and follow Behind The Release for full production playbooks.',
      highlightWords: ['Save', 'Behind The Release'],
    },
  ];

  const perScene = Number((target / templateBeats.length).toFixed(1));
  const rawScenes: VideoScene[] = templateBeats.map((b, idx) => ({
    id: `sc_${crypto.randomBytes(4).toString('hex')}`,
    orderIndex: idx,
    title: b.title,
    durationSeconds: perScene,
    style:
      input.style === 'hybrid'
        ? idx % 3 === 0
          ? 'stickman'
          : idx % 3 === 1
            ? 'cartoon-2d'
            : 'motion-graphics'
        : input.style,
    narrationText: b.narration,
    subtitleText: b.narration,
    visualDirection: `${b.title}: ${b.subheadline}`,
    stickman: {
      enabled: input.style === 'stickman' || input.style === 'hybrid' || idx === 0,
      action: b.action,
      bodyColor: '#f4f4f5',
      outlineColor: '#18181b',
      headShape: 'circle',
      headScale: 1,
      limbThickness: 8,
      expression: idx === 0 ? 'surprised' : idx === 7 ? 'happy' : 'focused',
      accessories: idx % 2 === 0 ? ['headphones'] : ['cap'],
      positionX: input.style === 'hybrid' ? 28 : 50,
      positionY: 62,
      scale: 1,
      flipped: idx % 2 === 1,
    },
    cartoon: {
      enabled: input.style === 'cartoon-2d' || input.style === 'hybrid',
      backgroundPreset: b.bg,
      characterId: idx % 2 === 0 ? 'artist' : 'producer',
      characterColor: '#e4e4e7',
      accentColor: '#f59e0b',
      props: idx % 2 === 0 ? ['condenser-mic', 'waveform'] : ['laptop-daw', 'studio-monitors'],
    },
    motion: {
      headline: b.headline,
      subheadline: b.subheadline,
      kicker: `Step 0${idx + 1}`,
      highlightWords: b.highlightWords,
      kpiValue: b.kpiValue,
      kpiLabel: b.kpiLabel,
      chartType: b.chart,
      chartData:
        b.chart === 'bar' || b.chart === 'line'
          ? [
              { label: 'Wk 1', value: 42 },
              { label: 'Wk 2', value: 68 },
              { label: 'Wk 3', value: 84 },
              { label: 'Drop', value: 96 },
            ]
          : undefined,
      comparisonLeft:
        b.chart === 'comparison'
          ? { label: 'Cold Drop', points: ['Zero context', 'Generic cover video', 'Fast drop-off'] }
          : undefined,
      comparisonRight:
        b.chart === 'comparison'
          ? { label: 'Story Rollout', points: ['Studio hook demos', 'Clear lyric thesis', '3x saves'] }
          : undefined,
      timelineSteps:
        b.chart === 'timeline' || b.chart === 'flowchart'
          ? [
              { step: 'Week 1', detail: 'Masters + hook cuts' },
              { step: 'Week 2', detail: 'Story clips' },
              { step: 'Launch', detail: 'Single clear link' },
            ]
          : undefined,
      calloutBadge: b.kpiValue ? `${b.kpiValue} ${b.kpiLabel || ''}`.trim() : undefined,
      transition: TRANSITIONS[idx % TRANSITIONS.length],
      accentColor: '#f59e0b',
      backgroundColor: '#09090b',
    },
  }));

  const normalizedScenes = normalizeSceneDurations(rawScenes, target);
  const fullNarration = normalizedScenes.map((s) => s.narrationText).join(' ');

  return {
    id,
    workspaceId: 'ws-behind-the-release',
    title: baseTopic.slice(0, 80),
    topic: baseTopic,
    audience: input.audience || 'Independent recording artists and producers',
    destination: input.destination || 'both',
    primaryStyle: input.style,
    targetDurationSeconds: target,
    workflowStage: 'script',
    approvedForRender: false,
    status: 'script-ready',
    script: {
      id: `scr_${crypto.randomBytes(4).toString('hex')}`,
      hook: normalizedScenes[0]?.narrationText || '',
      bodySummary: normalizedScenes.slice(1, -1).map((s) => s.title).join(' -> '),
      closingCta: normalizedScenes[normalizedScenes.length - 1]?.narrationText || '',
      fullNarration,
      estimatedDurationSeconds: target,
      targetDurationSeconds: target,
      educationalTakeaway: 'Structure release storytelling over four checkpoints before drop day.',
      suggestedCaption: `${baseTopic} — save this playbook for your next release.`,
      hashtags: ['#behindtherelease', '#independentartist', '#musicmarketing', '#musicianlife'],
      providerId: 'fallback',
      model: 'local-template',
      wasFallback: true,
    },
    scenes: normalizedScenes,
    audio: {
      narrationVolume: 1,
      bgmVolume: 0.25,
      sfxEnabled: true,
      sfxVolume: 0.4,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 1.0,
      trimStartSeconds: 0,
    },
    captionStyle: {
      position: 'bottom',
      highlightColor: '#f59e0b',
      fontSize: 44,
      showProgressBar: true,
      showBrandWatermark: true,
    },
    renders: [],
    createdAt: now,
    updatedAt: now,
  };
}

function getVideoGenerationProviders(): VideoGenerationProviderStatus[] {
  const hfConfigured = Boolean(process.env.HUGGINGFACE_TOKEN?.trim());
  const repConfigured = Boolean(process.env.REPLICATE_API_TOKEN?.trim());
  return [
    {
      id: 'remotion-local',
      label: 'Remotion Studio Renderer (Free License)',
      kind: 'built-in-renderer',
      enabled: true,
      configured: true,
      freeTier: true,
      requiresPaidBilling: false,
      note: 'Client/local deterministic 1080x1920 @ 30fps rendering via Remotion Web Renderer + FFmpeg fallback.',
    },
    {
      id: 'huggingface',
      label: 'HuggingFace Inference Video Adapter (Optional)',
      kind: 'optional-video-adapter',
      enabled: false,
      configured: hfConfigured,
      freeTier: true,
      requiresPaidBilling: false,
      note: 'Disabled by default. Configure HUGGINGFACE_TOKEN to enable optional experimental clip generation.',
    },
    {
      id: 'replicate',
      label: 'Replicate Video Adapter (Optional)',
      kind: 'optional-video-adapter',
      enabled: false,
      configured: repConfigured,
      freeTier: false,
      requiresPaidBilling: false,
      note: 'Disabled by default and never auto-selected to protect against paid billing.',
    },
  ];
}

async function persistVideoProjectAuthoritative(project: VideoProject, ownerUid: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    if (isProductionRuntime()) {
      throw new SupabasePersistenceError({
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: 'Supabase must be configured in production before saving Video Studio projects.',
        retriable: false,
        statusCode: 503,
      });
    }
    const store = loadStore(ownerUid);
    const idx = store.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) store.projects[idx] = project;
    else store.projects.unshift(project);
    saveStore(ownerUid, store);
    return;
  }

  assertSyncOk(
    await syncRowsToSupabase(
      'video_projects',
      [
        {
          id: project.id,
          owner_uid: ownerUid,
          workspace_id: project.workspaceId,
          title: project.title,
          topic: project.topic,
          audience: project.audience,
          destination: project.destination || 'both',
          workflow_stage: project.workflowStage || 'script',
          visual_style: project.primaryStyle,
          aspect_ratio: '9:16',
          target_duration_sec: project.targetDurationSeconds,
          fps: 30,
          status: project.status,
          script_approved: project.approvedForRender,
          storyboard_json: project.scenes,
          audio_config_json: project.audio,
          settings_json: project.captionStyle,
          created_at: project.createdAt,
          updated_at: project.updatedAt,
        },
      ],
      'owner_uid,id'
    )
  );

  assertSyncOk(
    await syncRowsToSupabase(
      'video_scripts',
      [
        {
          id: project.script.id,
          owner_uid: ownerUid,
          project_id: project.id,
          hook_line: project.script.hook,
          full_script: project.script.fullNarration,
          closing_cta: project.script.closingCta,
          provider_id: project.script.providerId || 'fallback',
          model: project.script.model || 'local-template',
          was_fallback: Boolean(project.script.wasFallback),
          approved: project.approvedForRender,
          meta_json: {
            bodySummary: project.script.bodySummary,
            educationalTakeaway: project.script.educationalTakeaway,
            suggestedCaption: project.script.suggestedCaption,
            hashtags: project.script.hashtags,
            estimatedDurationSeconds: project.script.estimatedDurationSeconds,
            targetDurationSeconds: project.script.targetDurationSeconds,
          },
          created_at: project.createdAt,
          updated_at: project.updatedAt,
        },
      ],
      'owner_uid,id'
    )
  );

  if (project.scenes.length > 0) {
    assertSyncOk(
      await syncRowsToSupabase(
        'video_scenes',
        project.scenes.map((sc) => ({
          id: sc.id,
          owner_uid: ownerUid,
          project_id: project.id,
          scene_order: sc.orderIndex,
          visual_style: sc.style,
          duration_sec: sc.durationSeconds,
          narration_text: sc.narrationText,
          on_screen_text: sc.motion.headline,
          stickman_config_json: sc.stickman,
          cartoon_config_json: sc.cartoon,
          motion_config_json: sc.motion,
          subtitle_words_json: sc.subtitleText.split(/\s+/).filter(Boolean),
          transition_type: sc.motion.transition,
          background_preset: sc.cartoon.backgroundPreset,
          created_at: project.createdAt,
          updated_at: project.updatedAt,
        })),
        'owner_uid,id'
      )
    );
  }
}

export function registerVideoStudio(app: Express): void {
  const jsonParser = express.json({ limit: '4mb' });
  const authGuard = requireServerOperator('ws-behind-the-release');

  app.get('/api/video-studio/providers', authGuard, (_req: AuthenticatedRequest, res: Response) => {
    return res.json({ providers: getVideoGenerationProviders() });
  });

  app.get('/api/video-studio/projects', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scopeKey = getScopeKey(req);
      const projects = await listProjectsAuthoritative(scopeKey);
      return res.json({ projects });
    } catch (err) {
      return handleRouteError(res, err, 'Failed to load video projects.');
    }
  });

  app.post('/api/video-studio/projects', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scopeKey = getScopeKey(req);
      const body = req.body as { project?: VideoProject };
      if (!body.project || !body.project.title) {
        return res.status(400).json({ error: 'Valid project payload is required.' });
      }
      const now = new Date().toISOString();
      const project: VideoProject = {
        ...body.project,
        id: body.project.id || `vid_${crypto.randomBytes(5).toString('hex')}`,
        workspaceId: 'ws-behind-the-release',
        targetDurationSeconds: clampDuration60To90(body.project.targetDurationSeconds),
        scenes: normalizeSceneDurations(body.project.scenes || [], body.project.targetDurationSeconds || 75),
        createdAt: body.project.createdAt || now,
        updatedAt: now,
      };

      await persistVideoProjectAuthoritative(project, scopeKey);
      return res.json({ project });
    } catch (err) {
      return handleRouteError(res, err, 'Failed to save video project.');
    }
  });

  app.put('/api/video-studio/projects/:id', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      const existing = await getProjectAuthoritative(scopeKey, id);
      if (!existing) {
        return res.status(404).json({ error: 'Video project not found.' });
      }
      const incoming = req.body as Partial<VideoProject>;
      const targetDur = clampDuration60To90(incoming.targetDurationSeconds ?? existing.targetDurationSeconds);
      const updated: VideoProject = {
        ...existing,
        ...incoming,
        id: existing.id,
        workspaceId: 'ws-behind-the-release',
        targetDurationSeconds: targetDur,
        scenes: incoming.scenes ? incoming.scenes.map((s, i) => ({ ...s, orderIndex: i })) : existing.scenes,
        updatedAt: new Date().toISOString(),
      };
      await persistVideoProjectAuthoritative(updated, scopeKey);
      return res.json({ project: updated });
    } catch (err) {
      return handleRouteError(res, err, 'Failed to update video project.');
    }
  });

  app.delete('/api/video-studio/projects/:id', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      if (isSupabaseConfigured()) {
        assertSyncOk(
          await deleteRowFromSupabase('video_projects', scopeKey, id, {
            workspace_id: 'ws-behind-the-release',
          })
        );
      } else if (isProductionRuntime()) {
        return res.status(503).json({
          error: 'Supabase must be configured in production to delete Video Studio projects.',
          code: 'SUPABASE_NOT_CONFIGURED',
        });
      } else {
        const store = loadStore(scopeKey);
        store.projects = store.projects.filter((p) => p.id !== id);
        saveStore(scopeKey, store);
      }
      return res.json({ ok: true });
    } catch (err) {
      return handleRouteError(res, err, 'Failed to delete video project.');
    }
  });

  app.post('/api/video-studio/generate-script', jsonParser, authGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    let scopeKey: string;
    try {
      scopeKey = getScopeKey(req);
    } catch (err) {
      return handleRouteError(res, err, 'Authentication required.');
    }

    const body = req.body as {
      topic?: string;
      audience?: string;
      style?: VideoStyle;
      targetDurationSeconds?: number;
      destination?: VideoProject['destination'];
      notes?: string;
      saveProject?: boolean;
    };

    const topic = (body.topic || '').trim();
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required to generate an educational video script.' });
    }

    const style: VideoStyle = sanitizeStyle(body.style, 'hybrid');
    const targetDuration = clampDuration60To90(body.targetDurationSeconds);
    const audience = (body.audience || 'Independent recording artists, producers, and songwriters').trim();
    const destination = body.destination || 'both';

    let projectToReturn: VideoProject;
    let usedFallbackTemplate = false;

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'video-script',
        responseFormat: 'json',
        maxOutputTokens: 3200,
        prompt: `You are the Creative Director for "Behind The Release", creating an educational 9:16 vertical video for Instagram Reels and YouTube Shorts.

BRIEF:
- Topic: ${topic}
- Audience: ${audience}
- Visual Style Mode: ${style} (available engines: stickman animation, 2d cartoon studio characters/props, motion graphics & kinetic typography, or hybrid mix)
- Exact Target Duration: ${targetDuration} seconds (MUST be 60 to 90 seconds total)
- Destination: ${destination}
${body.notes ? `- Creator Notes: ${body.notes}` : ''}

SCENE COUNT & STRUCTURE:
Generate 8 to 11 concise scenes whose durationSeconds sum cleanly to ~${targetDuration} seconds.
For EACH scene, assign:
- stickmanAction from ONLY: ${STICKMAN_ACTIONS.join(', ')}
- cartoonBackground from ONLY: ${CARTOON_BACKGROUNDS.join(', ')}
- cartoonCharacter from ONLY: ${CARTOON_CHARACTERS.join(', ')}
- chartType from ONLY: none, bar, line, timeline, comparison, flowchart
- transition from ONLY: ${TRANSITIONS.join(', ')}
- headline (<= 7 words), subheadline (<= 14 words), narrationText (spoken educational sentence, ~15-24 words per scene), highlightWords (1-3 impactful words from narration/headline).

Return strict JSON: { title, hook, bodySummary, closingCta, educationalTakeaway, suggestedCaption, hashtags (array), scenes: [{ title, durationSeconds, style, narrationText, visualDirection, stickmanAction, stickmanExpression, cartoonBackground, cartoonCharacter, props, headline, subheadline, kicker, highlightWords, kpiValue, kpiLabel, chartType, transition }] }.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            hook: { type: Type.STRING },
            bodySummary: { type: Type.STRING },
            closingCta: { type: Type.STRING },
            educationalTakeaway: { type: Type.STRING },
            suggestedCaption: { type: Type.STRING },
            hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  durationSeconds: { type: Type.NUMBER },
                  style: { type: Type.STRING },
                  narrationText: { type: Type.STRING },
                  visualDirection: { type: Type.STRING },
                  stickmanAction: { type: Type.STRING },
                  stickmanExpression: { type: Type.STRING },
                  cartoonBackground: { type: Type.STRING },
                  cartoonCharacter: { type: Type.STRING },
                  props: { type: Type.ARRAY, items: { type: Type.STRING } },
                  headline: { type: Type.STRING },
                  subheadline: { type: Type.STRING },
                  kicker: { type: Type.STRING },
                  highlightWords: { type: Type.ARRAY, items: { type: Type.STRING } },
                  kpiValue: { type: Type.STRING },
                  kpiLabel: { type: Type.STRING },
                  chartType: { type: Type.STRING },
                  transition: { type: Type.STRING },
                },
                required: ['title', 'durationSeconds', 'narrationText', 'headline'],
              },
            },
          },
          required: ['title', 'hook', 'closingCta', 'scenes'],
        },
      });

      const cleaned = (aiResp.text || '{}')
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned) as {
        title?: string;
        hook?: string;
        bodySummary?: string;
        closingCta?: string;
        educationalTakeaway?: string;
        suggestedCaption?: string;
        hashtags?: string[];
        scenes?: Array<Record<string, unknown>>;
      };

      const rawScenes = Array.isArray(parsed.scenes) && parsed.scenes.length >= 4
        ? parsed.scenes
        : null;

      if (!rawScenes) {
        projectToReturn = buildDeterministicFallbackProject({
          topic,
          audience,
          style,
          targetDurationSeconds: targetDuration,
          destination,
        });
        usedFallbackTemplate = true;
      } else {
        const now = new Date().toISOString();
        const mappedScenes: VideoScene[] = rawScenes.map((raw, idx) => {
          const sceneStyle = sanitizeStyle(String(raw.style || ''), style);
          const chartTypeRaw = String(raw.chartType || 'none') as MotionChartType;
          const chartType: MotionChartType = ['none', 'bar', 'line', 'timeline', 'comparison', 'flowchart'].includes(chartTypeRaw)
            ? chartTypeRaw
            : 'none';
          const transitionRaw = String(raw.transition || 'crossfade') as SceneTransitionType;
          const transition: SceneTransitionType = TRANSITIONS.includes(transitionRaw) ? transitionRaw : 'crossfade';
          const narrationText = String(raw.narrationText || '');
          const highlightWords = Array.isArray(raw.highlightWords)
            ? raw.highlightWords.filter((w): w is string => typeof w === 'string').slice(0, 4)
            : [];

          return {
            id: `sc_${crypto.randomBytes(4).toString('hex')}`,
            orderIndex: idx,
            title: String(raw.title || `Scene ${idx + 1}`),
            durationSeconds: Math.max(4, Math.min(18, Number(raw.durationSeconds) || 8)),
            style: sceneStyle,
            narrationText,
            subtitleText: narrationText,
            visualDirection: String(raw.visualDirection || raw.subheadline || ''),
            stickman: {
              enabled: sceneStyle === 'stickman' || sceneStyle === 'hybrid',
              action: sanitizeAction(String(raw.stickmanAction || ''), 'explaining'),
              bodyColor: '#f4f4f5',
              outlineColor: '#18181b',
              headShape: 'circle',
              headScale: 1,
              limbThickness: 8,
              expression:
                raw.stickmanExpression === 'happy' ||
                raw.stickmanExpression === 'surprised' ||
                raw.stickmanExpression === 'skeptical' ||
                raw.stickmanExpression === 'focused'
                  ? raw.stickmanExpression
                  : 'focused',
              accessories: idx % 2 === 0 ? ['headphones'] : [],
              positionX: sceneStyle === 'hybrid' ? 28 : 50,
              positionY: 62,
              scale: 1,
              flipped: idx % 2 === 1,
            },
            cartoon: {
              enabled: sceneStyle === 'cartoon-2d' || sceneStyle === 'hybrid',
              backgroundPreset: sanitizeBackground(String(raw.cartoonBackground || '')),
              characterId: sanitizeCharacter(String(raw.cartoonCharacter || '')),
              characterColor: '#e4e4e7',
              accentColor: '#f59e0b',
              props: sanitizeProps(raw.props),
            },
            motion: {
              headline: String(raw.headline || `Point ${idx + 1}`),
              subheadline: raw.subheadline ? String(raw.subheadline) : undefined,
              kicker: raw.kicker ? String(raw.kicker) : `Step ${String(idx + 1).padStart(2, '0')}`,
              highlightWords,
              kpiValue: raw.kpiValue ? String(raw.kpiValue) : undefined,
              kpiLabel: raw.kpiLabel ? String(raw.kpiLabel) : undefined,
              chartType,
              chartData:
                chartType === 'bar' || chartType === 'line'
                  ? [
                      { label: 'P1', value: 35 },
                      { label: 'P2', value: 62 },
                      { label: 'P3', value: 80 },
                      { label: 'Peak', value: 94 },
                    ]
                  : undefined,
              comparisonLeft:
                chartType === 'comparison'
                  ? { label: 'Common Mistake', points: ['Skipped prep', 'Weak hook', 'No CTA'] }
                  : undefined,
              comparisonRight:
                chartType === 'comparison'
                  ? { label: 'Behind The Release', points: ['Clear thesis', 'Visual proof', 'Next action'] }
                  : undefined,
              timelineSteps:
                chartType === 'timeline' || chartType === 'flowchart'
                  ? [
                      { step: '01', detail: 'Hook tension' },
                      { step: '02', detail: 'Visual breakdown' },
                      { step: '03', detail: 'Clear takeaway' },
                    ]
                  : undefined,
              transition,
              accentColor: '#f59e0b',
              backgroundColor: '#09090b',
            },
          };
        });

        const normalizedScenes = normalizeSceneDurations(mappedScenes, targetDuration);
        const totalEstimated = Number(
          normalizedScenes.reduce((acc, s) => acc + s.durationSeconds, 0).toFixed(1)
        );

        projectToReturn = {
          id: `vid_${crypto.randomBytes(5).toString('hex')}`,
          workspaceId: 'ws-behind-the-release',
          title: String(parsed.title || topic).slice(0, 90),
          topic,
          audience,
          destination,
          primaryStyle: style,
          targetDurationSeconds: targetDuration,
          workflowStage: 'script',
          approvedForRender: false,
          status: 'script-ready',
          script: {
            id: `scr_${crypto.randomBytes(4).toString('hex')}`,
            hook: String(parsed.hook || normalizedScenes[0]?.narrationText || ''),
            bodySummary: String(parsed.bodySummary || ''),
            closingCta: String(parsed.closingCta || normalizedScenes[normalizedScenes.length - 1]?.narrationText || ''),
            fullNarration: normalizedScenes.map((s) => s.narrationText).join(' '),
            estimatedDurationSeconds: totalEstimated,
            targetDurationSeconds: targetDuration,
            educationalTakeaway: String(parsed.educationalTakeaway || topic),
            suggestedCaption: String(parsed.suggestedCaption || `${topic} — Behind The Release`),
            hashtags:
              Array.isArray(parsed.hashtags) && parsed.hashtags.length > 0
                ? parsed.hashtags.map((h) => String(h))
                : ['#behindtherelease', '#musicproduction', '#independentartist'],
            providerId: aiResp.providerId,
            model: aiResp.model,
            wasFallback: aiResp.wasFallback,
          },
          scenes: normalizedScenes,
          audio: {
            narrationVolume: 1,
            bgmVolume: 0.25,
            sfxEnabled: true,
            sfxVolume: 0.4,
            fadeInSeconds: 0.5,
            fadeOutSeconds: 1.0,
            trimStartSeconds: 0,
          },
          captionStyle: {
            position: 'bottom',
            highlightColor: '#f59e0b',
            fontSize: 44,
            showProgressBar: true,
            showBrandWatermark: true,
          },
          renders: [],
          createdAt: now,
          updatedAt: now,
        };
      }
    } catch {
      projectToReturn = buildDeterministicFallbackProject({
        topic,
        audience,
        style,
        targetDurationSeconds: targetDuration,
        destination,
      });
      usedFallbackTemplate = true;
    }

    if (body.saveProject !== false) {
      try {
        await persistVideoProjectAuthoritative(projectToReturn, scopeKey);
      } catch (persistErr) {
        return handleRouteError(res, persistErr, 'Failed to save generated video project.');
      }
    }

    return res.json({ project: projectToReturn, usedFallbackTemplate });
  });

  app.post('/api/video-studio/regenerate-scene', jsonParser, authGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as {
      topic?: string;
      scene?: VideoScene;
      instruction?: string;
    };

    if (!body.scene) {
      return res.status(400).json({ error: 'Scene payload is required.' });
    }

    const scene = body.scene;
    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'video-scene-regen',
        responseFormat: 'json',
        maxOutputTokens: 900,
        prompt: `Refine ONE educational short-form video scene for "Behind The Release" (${body.topic || scene.title}).
Current Scene:
- Title: ${scene.title}
- Style: ${scene.style}
- Duration: ${scene.durationSeconds}s
- Current Narration: ${scene.narrationText}
- Current Headline: ${scene.motion.headline}
- Instruction: ${body.instruction || 'Sharpen educational clarity, visual action, and spoken pacing.'}

Available stickmanAction values: ${STICKMAN_ACTIONS.join(', ')}
Return strict JSON { title, narrationText, visualDirection, headline, subheadline, stickmanAction, highlightWords (array) }.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            narrationText: { type: Type.STRING },
            visualDirection: { type: Type.STRING },
            headline: { type: Type.STRING },
            subheadline: { type: Type.STRING },
            stickmanAction: { type: Type.STRING },
            highlightWords: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['title', 'narrationText', 'headline'],
        },
      });

      const cleaned = (aiResp.text || '{}').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned) as {
        title?: string;
        narrationText?: string;
        visualDirection?: string;
        headline?: string;
        subheadline?: string;
        stickmanAction?: string;
        highlightWords?: string[];
      };

      const nextNarration = String(parsed.narrationText || scene.narrationText);
      const updatedScene: VideoScene = {
        ...scene,
        title: String(parsed.title || scene.title),
        narrationText: nextNarration,
        subtitleText: nextNarration,
        visualDirection: String(parsed.visualDirection || scene.visualDirection),
        stickman: {
          ...scene.stickman,
          action: sanitizeAction(parsed.stickmanAction, scene.stickman.action),
        },
        motion: {
          ...scene.motion,
          headline: String(parsed.headline || scene.motion.headline),
          subheadline: parsed.subheadline ?? scene.motion.subheadline,
          highlightWords: Array.isArray(parsed.highlightWords)
            ? parsed.highlightWords.slice(0, 4)
            : scene.motion.highlightWords,
        },
      };

      return res.json({
        scene: updatedScene,
        providerId: aiResp.providerId,
        model: aiResp.model,
      });
    } catch {
      return res.json({
        scene: {
          ...scene,
          motion: {
            ...scene.motion,
            headline: scene.motion.headline.trim(),
          },
        },
        usedFallbackTemplate: true,
      });
    }
  });

  // Durable Cross-Instance Chunked Cloud Storage Upload (Supabase DB + Supabase Storage)
  app.post(
    '/api/video-studio/projects/:id/upload-render/init',
    jsonParser,
    authGuard,
    videoUploadLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        cleanupExpiredUploadSessions();
        const scopeKey = getScopeKey(req);
        const id = String(req.params.id || '').trim();
        const ownership = await verifyVideoProjectOwnership(scopeKey, id);
        if (!ownership.owned) {
          return res.status(404).json({ error: 'Video project not found.' });
        }

        const body = (req.body || {}) as {
          renderId?: string;
          format?: 'mp4' | 'webm';
          mimeType?: string;
          totalBytes?: number;
          totalChunks?: number;
          expectedSha256?: string;
        };
        const cleanRenderId = String(body.renderId || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const totalBytes = Number(body.totalBytes || 0);
        const rawTotalChunks = Number(body.totalChunks || 1);
        const expectedSha256 =
          typeof body.expectedSha256 === 'string' && body.expectedSha256.trim()
            ? body.expectedSha256.trim().toLowerCase()
            : undefined;

        if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
          return res.status(400).json({ error: 'expectedSha256 must be a valid 64-character hex SHA-256 digest.' });
        }
        if (
          !cleanRenderId ||
          !Number.isFinite(totalBytes) ||
          totalBytes <= 0 ||
          !Number.isInteger(rawTotalChunks) ||
          rawTotalChunks < 1 ||
          rawTotalChunks > 256
        ) {
          return res.status(400).json({ error: 'Valid renderId, totalBytes, and totalChunks (1-256) are required.' });
        }
        if (totalBytes > MAX_SUPABASE_RENDER_BYTES) {
          return res.status(413).json({
            error: `Rendered video (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the configured Supabase bucket limit (${MAX_SUPABASE_RENDER_BYTES / (1024 * 1024)} MB). Local browser backup and download remain intact.`,
            code: 'FILE_TOO_LARGE_FOR_BUCKET',
            maxBytes: MAX_SUPABASE_RENDER_BYTES,
          });
        }
        if (totalBytes > rawTotalChunks * MAX_CHUNK_BYTES) {
          return res.status(400).json({
            error: `Declared totalBytes (${totalBytes}) exceeds totalChunks * 5MB limit.`,
            code: 'INVALID_CHUNK_GEOMETRY',
          });
        }

        const format: 'mp4' | 'webm' = body.format === 'webm' ? 'webm' : 'mp4';
        const mimeType = body.mimeType || (format === 'webm' ? 'video/webm' : 'video/mp4');
        const uploadId = `upl_${crypto.randomBytes(12).toString('hex')}`;

        if (isSupabaseConfigured()) {
          const rpcRes = await callSupabaseRpc<{
            ok?: boolean;
            code?: string;
            error?: string;
            active_count?: number;
            max_concurrent?: number;
            expires_at?: string;
          }>('create_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_workspace_id: 'ws-behind-the-release',
            p_project_id: id,
            p_render_id: cleanRenderId,
            p_format: format,
            p_mime_type: mimeType,
            p_total_chunks: rawTotalChunks,
            p_total_bytes: totalBytes,
            p_expected_sha256: expectedSha256 || null,
            p_max_concurrent: MAX_CONCURRENT_UPLOADS_PER_OWNER,
            p_ttl_seconds: Math.round(UPLOAD_SESSION_TTL_MS / 1000),
          });
          const rpcData = assertSyncOk(rpcRes);
          if (!rpcData?.ok) {
            if (rpcData?.code === 'UPLOAD_CONCURRENCY_LIMIT') {
              return res.status(429).json({
                error: `Too many concurrent video uploads (${rpcData.active_count}/${rpcData.max_concurrent || MAX_CONCURRENT_UPLOADS_PER_OWNER}). Wait for existing uploads to finish or expire.`,
                code: 'UPLOAD_CONCURRENCY_LIMIT',
              });
            }
            return res.status(400).json({
              error: rpcData?.error || 'Failed to initialize durable upload session.',
              code: rpcData?.code || 'UPLOAD_INIT_FAILED',
            });
          }

          return res.json({
            uploadId,
            maxBytes: MAX_SUPABASE_RENDER_BYTES,
            maxChunkBytes: MAX_CHUNK_BYTES,
            expiresAt: rpcData.expires_at,
          });
        }

        const diag = getSupabaseConfigDiagnostics();
        if (isProductionRuntime()) {
          return res.status(503).json({
            error: `Cloud upload unavailable: Supabase not configured (${diag.missingEnvVars.join(', ')}).`,
            code: 'SUPABASE_NOT_CONFIGURED',
            cloudSupported: false,
          });
        }

        // Non-production dev fallback ONLY when Supabase is unconfigured
        let activeForOwner = 0;
        for (const s of devChunkUploadSessions.values()) {
          if (s.ownerScopeKey === scopeKey && (s.status === 'active' || s.status === 'completing')) {
            activeForOwner += 1;
          }
        }
        if (activeForOwner >= MAX_CONCURRENT_UPLOADS_PER_OWNER) {
          return res.status(429).json({
            error: `Too many concurrent video uploads (${activeForOwner}/${MAX_CONCURRENT_UPLOADS_PER_OWNER}). Wait for existing uploads to finish or expire.`,
            code: 'UPLOAD_CONCURRENCY_LIMIT',
          });
        }

        fs.mkdirSync(DEV_UPLOAD_SESSIONS_ROOT, { recursive: true, mode: 0o700 });
        const workDir = fs.mkdtempSync(path.join(DEV_UPLOAD_SESSIONS_ROOT, `${uploadId}-`));
        const nowMs = Date.now();
        devChunkUploadSessions.set(uploadId, {
          uploadId,
          ownerScopeKey: scopeKey,
          projectId: id,
          renderId: cleanRenderId,
          format,
          mimeType,
          totalChunks: rawTotalChunks,
          totalBytes,
          expectedSha256,
          workDir,
          receivedChunks: new Map(),
          status: 'active',
          createdAt: nowMs,
          updatedAt: nowMs,
        });

        return res.json({ uploadId, maxBytes: MAX_SUPABASE_RENDER_BYTES, maxChunkBytes: MAX_CHUNK_BYTES });
      } catch (err) {
        return handleRouteError(res, err, 'Failed to initialize upload session.');
      }
    }
  );

  app.put(
    '/api/video-studio/projects/:id/upload-render/:uploadId/chunk',
    authGuard,
    videoUploadLimiter,
    express.raw({ type: ['application/octet-stream', 'video/*'], limit: '5mb' }),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        cleanupExpiredUploadSessions();
        const scopeKey = getScopeKey(req);
        const id = String(req.params.id || '');
        const uploadId = String(req.params.uploadId || '');
        const chunkIndex = Number(req.query.index);

        if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
          return res.status(400).json({ error: 'Invalid chunk index.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Empty upload chunk.' });
        }
        if (req.body.length > MAX_CHUNK_BYTES) {
          return res.status(413).json({ error: `Chunk exceeds ${MAX_CHUNK_BYTES} byte limit.` });
        }

        const chunkSha256 = crypto.createHash('sha256').update(req.body).digest('hex');
        const clientShaHeader = req.get('x-chunk-sha256')?.trim().toLowerCase();
        if (clientShaHeader) {
          if (!/^[a-f0-9]{64}$/.test(clientShaHeader) || clientShaHeader !== chunkSha256) {
            return res.status(400).json({
              error: 'Chunk SHA-256 verification failed against X-Chunk-Sha256 header.',
              code: 'CHUNK_DIGEST_MISMATCH',
            });
          }
        }

        if (isSupabaseConfigured()) {
          const client = getSupabaseAdmin()!;
          const { data: sessRow, error: sessErr } = await client
            .from('video_upload_sessions')
            .select('*')
            .eq('upload_id', uploadId)
            .eq('owner_uid', scopeKey)
            .eq('project_id', id)
            .maybeSingle();

          if (sessErr) {
            throw new SupabasePersistenceError({
              ok: false,
              code: 'SUPABASE_READ_FAILED',
              message: `Failed to verify upload session: ${sessErr.message}`,
              retriable: true,
              statusCode: 503,
            });
          }
          const sess = sessRow as SupabaseUploadSessionRow | null;
          if (!sess) {
            return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
          }
          if (sess.status === 'completing' || sess.status === 'completed') {
            return res.status(409).json({
              error: `Upload session is already ${sess.status} and can no longer accept chunks.`,
              code: 'UPLOAD_LOCKED',
            });
          }
          if (sess.status === 'expired' || Date.parse(sess.expires_at) <= Date.now()) {
            return res.status(400).json({ error: 'Upload session has expired.', code: 'SESSION_EXPIRED' });
          }
          if (chunkIndex >= sess.total_chunks) {
            return res.status(400).json({ error: 'Invalid chunk index.' });
          }

          const existingChunks = sess.received_chunks_json || {};
          const existingChunk = existingChunks[String(chunkIndex)];
          if (existingChunk) {
            if (
              Number(existingChunk.size) === req.body.length &&
              String(existingChunk.sha256 || '').toLowerCase() === chunkSha256
            ) {
              return res.json({
                ok: true,
                idempotent: true,
                chunkIndex,
                receivedCount: Object.keys(existingChunks).length,
                totalChunks: sess.total_chunks,
                sha256: chunkSha256,
              });
            }
            return res.status(409).json({
              error: 'Conflicting chunk payload supplied for already-recorded chunk index.',
              code: 'CHUNK_CONFLICT',
            });
          }

          let existingBytesWithoutThis = 0;
          for (const [k, meta] of Object.entries(existingChunks)) {
            if (k !== String(chunkIndex)) {
              existingBytesWithoutThis += Number(meta?.size || 0);
            }
          }
          if (existingBytesWithoutThis + req.body.length > Number(sess.total_bytes)) {
            return res.status(413).json({
              error: `Cumulative chunk bytes (${existingBytesWithoutThis + req.body.length}) exceed declared totalBytes (${sess.total_bytes}).`,
              code: 'CHUNK_OVERFLOW',
            });
          }

          const relativeChunkPath = `_chunks/${uploadId}/chunk-${String(chunkIndex).padStart(5, '0')}.bin`;
          const uploadedChunk = await uploadToSupabaseBucket({
            bucket: 'video-studio',
            ownerUid: scopeKey,
            relativePath: relativeChunkPath,
            buffer: req.body,
            contentType: 'application/octet-stream',
            upsert: true,
          });
          if (!uploadedChunk.ok) {
            return res.status(502).json({
              error: `Failed to store chunk ${chunkIndex} in Supabase Storage: ${uploadedChunk.error}`,
              code: 'CHUNK_STORAGE_UPLOAD_FAILED',
            });
          }

          const rpcRes = await callSupabaseRpc<{
            ok?: boolean;
            idempotent?: boolean;
            code?: string;
            error?: string;
            chunk_index?: number;
            received_count?: number;
            total_chunks?: number;
          }>('record_video_upload_chunk', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_project_id: id,
            p_chunk_index: chunkIndex,
            p_chunk_size: req.body.length,
            p_chunk_sha256: chunkSha256,
            p_object_path: uploadedChunk.path,
          });
          const rpcData = assertSyncOk(rpcRes);
          if (!rpcData?.ok) {
            const status =
              rpcData?.code === 'CHUNK_CONFLICT' || rpcData?.code === 'UPLOAD_LOCKED'
                ? 409
                : rpcData?.code === 'CHUNK_OVERFLOW'
                  ? 413
                  : 400;
            return res.status(status).json({
              error: rpcData?.error || 'Failed to record uploaded chunk.',
              code: rpcData?.code || 'CHUNK_RECORD_FAILED',
            });
          }

          return res.json({
            ok: true,
            idempotent: Boolean(rpcData.idempotent),
            chunkIndex,
            receivedCount: Number(rpcData.received_count ?? 1),
            totalChunks: Number(rpcData.total_chunks ?? sess.total_chunks),
            sha256: chunkSha256,
          });
        }

        if (isProductionRuntime()) {
          return res.status(503).json({
            error: 'Supabase must be configured in production for chunked video upload.',
            code: 'SUPABASE_NOT_CONFIGURED',
          });
        }

        // Local dev fallback ONLY when Supabase is unconfigured
        const sess = devChunkUploadSessions.get(uploadId);
        if (!sess || sess.ownerScopeKey !== scopeKey || sess.projectId !== id) {
          return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
        }
        if (sess.status === 'completing' || sess.status === 'completed') {
          return res.status(409).json({
            error: `Upload session is already ${sess.status} and can no longer accept chunks.`,
            code: 'UPLOAD_LOCKED',
          });
        }
        if (chunkIndex >= sess.totalChunks) {
          return res.status(400).json({ error: 'Invalid chunk index.' });
        }

        const existingMeta = sess.receivedChunks.get(chunkIndex);
        if (existingMeta) {
          if (existingMeta.size === req.body.length && existingMeta.sha256 === chunkSha256) {
            return res.json({
              ok: true,
              idempotent: true,
              chunkIndex,
              receivedCount: sess.receivedChunks.size,
              totalChunks: sess.totalChunks,
            });
          }
          return res.status(409).json({
            error: 'Conflicting chunk payload supplied for already-recorded chunk index.',
            code: 'CHUNK_CONFLICT',
          });
        }

        let existingBytesWithoutThis = 0;
        for (const [idx, meta] of sess.receivedChunks.entries()) {
          if (idx !== chunkIndex) existingBytesWithoutThis += meta.size;
        }
        if (existingBytesWithoutThis + req.body.length > sess.totalBytes) {
          return res.status(413).json({
            error: `Cumulative chunk bytes (${existingBytesWithoutThis + req.body.length}) exceed declared totalBytes (${sess.totalBytes}).`,
            code: 'CHUNK_OVERFLOW',
          });
        }

        const chunkPath = path.resolve(sess.workDir, `chunk-${String(chunkIndex).padStart(5, '0')}.bin`);
        if (!chunkPath.startsWith(sess.workDir + path.sep)) {
          return res.status(400).json({ error: 'Invalid chunk target path.' });
        }
        fs.writeFileSync(chunkPath, req.body);
        sess.receivedChunks.set(chunkIndex, { size: req.body.length, sha256: chunkSha256 });
        sess.updatedAt = Date.now();
        return res.json({
          ok: true,
          chunkIndex,
          receivedCount: sess.receivedChunks.size,
          totalChunks: sess.totalChunks,
        });
      } catch (err) {
        return handleRouteError(res, err, 'Failed to process upload chunk.');
      }
    }
  );

  app.post(
    '/api/video-studio/projects/:id/upload-render/:uploadId/complete',
    jsonParser,
    authGuard,
    videoUploadLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      cleanupExpiredUploadSessions();
      let scopeKey: string;
      try {
        scopeKey = getScopeKey(req);
      } catch (authErr) {
        return handleRouteError(res, authErr, 'Authentication required.');
      }

      const id = String(req.params.id || '');
      const uploadId = String(req.params.uploadId || '');

      if (!isSupabaseConfigured()) {
        if (isProductionRuntime()) {
          return res.status(503).json({
            uploaded: false,
            error: 'Supabase must be configured in production to finalize video uploads.',
            code: 'SUPABASE_NOT_CONFIGURED',
          });
        }
        const devSess = devChunkUploadSessions.get(uploadId);
        if (!devSess || devSess.ownerScopeKey !== scopeKey || devSess.projectId !== id) {
          return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
        }
        return res.status(503).json({
          uploaded: false,
          error: 'Supabase Storage is not configured; upload remains local.',
          code: 'SUPABASE_NOT_CONFIGURED',
        });
      }

      const leaseToken = crypto.randomBytes(16).toString('hex');
      let leaseAcquired = false;
      let sess: SupabaseUploadSessionRow | null = null;
      let workDir: string | null = null;

      try {
        const leaseRes = await callSupabaseRpc<{
          ok?: boolean;
          outcome?: string;
          error?: string;
          lease_token?: string;
          session?: SupabaseUploadSessionRow;
        }>('acquire_video_upload_completion_lease', {
          p_upload_id: uploadId,
          p_owner_uid: scopeKey,
          p_project_id: id,
          p_lease_token: leaseToken,
          p_lease_seconds: 180,
        });
        const leaseData = assertSyncOk(leaseRes);

        if (!leaseData || leaseData.outcome === 'not_found') {
          return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
        }
        if (leaseData.outcome === 'in_progress') {
          return res.status(409).json({
            error: 'Upload completion is already in progress. Please wait before retrying.',
            code: 'UPLOAD_COMPLETING',
          });
        }
        if (leaseData.outcome === 'expired') {
          return res.status(400).json({
            error: leaseData.error || 'Upload session expired before completion.',
            code: 'SESSION_EXPIRED',
          });
        }

        sess = leaseData.session || null;
        if (!sess) {
          return res.status(500).json({ uploaded: false, error: 'Missing upload session state from RPC.' });
        }

        if (leaseData.outcome === 'already_completed' && sess.storage_path) {
          const verifiedExisting = await findExistingStorageRenderObject(
            scopeKey,
            sess.project_id,
            sess.render_id,
            sess.format,
            Number(sess.total_bytes),
            sess.storage_path
          );
          if (verifiedExisting.exists) {
            // Ensure video_renders DB record exists idempotently
            const existingProj = await getProjectAuthoritative(scopeKey, sess.project_id);
            const existingRender = existingProj?.renders.find((r) => r.id === sess!.render_id);
            assertSyncOk(
              await syncRowsToSupabase(
                'video_renders',
                [
                  {
                    id: sess.render_id,
                    owner_uid: scopeKey,
                    project_id: sess.project_id,
                    format: sess.format,
                    width: existingRender?.resolution === '540x960' ? 540 : existingRender?.resolution === '1920x1080' ? 1920 : 1080,
                    height: existingRender?.resolution === '540x960' ? 960 : existingRender?.resolution === '1920x1080' ? 1080 : 1920,
                    fps: existingRender?.fps || 30,
                    duration_sec: existingRender?.durationSeconds || existingProj?.targetDurationSeconds || 75,
                    status: 'completed',
                    progress_pct: 100,
                    checkpoint_json: {
                      engine: existingRender?.engine || 'remotion-web',
                      lastCheckpointFrame: existingRender?.lastCheckpointFrame,
                    },
                    storage_bucket: 'video-studio',
                    storage_path: verifiedExisting.objectPath,
                    sha256: sess.assembled_sha256 || sess.expected_sha256 || null,
                    error_message: null,
                    created_at: existingRender?.createdAt || new Date().toISOString(),
                    completed_at: new Date().toISOString(),
                  },
                ],
                'owner_uid,id'
              )
            );
            return res.json({
              uploaded: true,
              recovered: true,
              storageBucket: 'video-studio',
              storagePath: verifiedExisting.objectPath,
              signedUrl: verifiedExisting.signedUrl,
              bytesUploaded: verifiedExisting.size || Number(sess.bytes_uploaded || sess.total_bytes),
              sha256: sess.assembled_sha256 || undefined,
            });
          }
          return res.status(502).json({
            uploaded: false,
            error: 'Session was marked completed, but final Storage object could not be verified.',
            code: 'STORAGE_VERIFICATION_FAILED',
          });
        }

        if (!leaseData.ok || leaseData.outcome !== 'acquired') {
          return res.status(409).json({
            uploaded: false,
            error: leaseData.error || 'Could not acquire upload completion lease.',
          });
        }
        leaseAcquired = true;

        const chunksMap = sess.received_chunks_json || {};
        const chunkObjectPaths: string[] = [];
        const missingChunks: number[] = [];
        for (let i = 0; i < sess.total_chunks; i += 1) {
          const entry = chunksMap[String(i)];
          if (!entry || !entry.objectPath) {
            missingChunks.push(i);
          } else {
            chunkObjectPaths.push(entry.objectPath);
          }
        }
        if (missingChunks.length > 0) {
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: `Missing chunk(s): ${missingChunks.slice(0, 10).join(', ')}`,
          });
          leaseAcquired = false;
          return res.status(400).json({
            error: `Incomplete chunk upload (${sess.total_chunks - missingChunks.length}/${sess.total_chunks} chunks received).`,
            receivedChunks: Object.keys(chunksMap).map(Number).sort((a, b) => a - b),
          });
        }

        // Stream-assemble chunks cleanly into an isolated os.tmpdir() directory
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), `74studio-upl-${uploadId}-`));
        const assembledPath = path.join(workDir, `assembled.${sess.format}`);
        const assembledHasher = crypto.createHash('sha256');
        let assembledBytes = 0;

        const outStream = fs.createWriteStream(assembledPath);
        const streamFinishPromise = new Promise<void>((resolve, reject) => {
          outStream.once('finish', resolve);
          outStream.once('error', reject);
        });

        try {
          for (let i = 0; i < sess.total_chunks; i += 1) {
            const chunkMeta = chunksMap[String(i)]!;
            const tempChunkPath = path.join(workDir, `chunk-${String(i).padStart(5, '0')}.bin`);
            const dl = await downloadStorageObjectToFile({
              bucket: 'video-studio',
              objectPath: chunkMeta.objectPath,
              destinationPath: tempChunkPath,
            });
            if (!dl.ok) {
              throw Object.assign(new Error(`Failed to fetch chunk ${i} from Supabase Storage: ${dl.error}`), {
                statusCode: 502,
                code: 'CHUNK_STORAGE_READ_FAILED',
              });
            }
            if (
              dl.bytes !== Number(chunkMeta.size) ||
              dl.sha256.toLowerCase() !== String(chunkMeta.sha256).toLowerCase()
            ) {
              throw Object.assign(new Error(`Chunk ${i} failed SHA-256 or byte-size verification during assembly.`), {
                statusCode: 400,
                code: 'CHUNK_INTEGRITY_MISMATCH',
              });
            }

            // Stream chunk into assembled file without holding all chunks in RAM
            await new Promise<void>((resolve, reject) => {
              const rs = fs.createReadStream(tempChunkPath);
              rs.on('data', (piece: Buffer | string) => {
                const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
                assembledBytes += buf.length;
                assembledHasher.update(buf);
                if (!outStream.write(buf)) {
                  rs.pause();
                  outStream.once('drain', () => rs.resume());
                }
              });
              rs.once('end', resolve);
              rs.once('error', reject);
            });

            // Remove each temporary chunk file immediately after appending to keep /tmp bounded
            await fs.promises.unlink(tempChunkPath).catch(() => {});
          }
          outStream.end();
          await streamFinishPromise;
        } catch (asmErr) {
          outStream.destroy();
          throw asmErr;
        }

        if (assembledBytes !== Number(sess.total_bytes)) {
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: `Assembled byte count (${assembledBytes}) does not match declared totalBytes (${sess.total_bytes}).`,
          });
          leaseAcquired = false;
          return res.status(400).json({
            error: `Assembled byte count (${assembledBytes}) does not match declared totalBytes (${sess.total_bytes}).`,
            code: 'SIZE_MISMATCH',
          });
        }

        const assembledSha256 = assembledHasher.digest('hex');
        if (sess.expected_sha256 && assembledSha256 !== sess.expected_sha256.toLowerCase()) {
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: 'Assembled video SHA-256 did not match expected client digest.',
          });
          leaseAcquired = false;
          return res.status(400).json({
            error: 'Assembled video SHA-256 digest mismatch.',
            code: 'FILE_DIGEST_MISMATCH',
          });
        }

        if (sess.format === 'mp4') {
          const mp4Check = await probeAndValidateMp4(assembledPath);
          if (!mp4Check.valid) {
            await callSupabaseRpc('finalize_video_upload_session', {
              p_upload_id: uploadId,
              p_owner_uid: scopeKey,
              p_lease_token: leaseToken,
              p_success: false,
              p_error_message: mp4Check.reason || 'Uploaded MP4 failed container validation.',
            });
            leaseAcquired = false;
            return res.status(422).json({
              uploaded: false,
              error: mp4Check.reason || 'Uploaded MP4 failed container validation.',
              code: 'INVALID_MP4_CONTAINER',
            });
          }
        }

        const uploaded = await uploadToSupabaseBucket({
          bucket: 'video-studio',
          ownerUid: scopeKey,
          relativePath: `${sess.project_id}/${sess.render_id}.${sess.format}`,
          filePath: assembledPath,
          contentType: sess.mime_type,
          upsert: true,
        });

        if (!uploaded.ok) {
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: uploaded.error,
          });
          leaseAcquired = false;
          const lowerErr = uploaded.error.toLowerCase();
          const isSizeLimit =
            lowerErr.includes('size') || lowerErr.includes('too large') || lowerErr.includes('payload');
          return res.status(isSizeLimit ? 413 : 502).json({
            uploaded: false,
            error: isSizeLimit
              ? `Supabase Storage rejected upload due to plan/bucket size limit (${uploaded.error}).`
              : `Supabase Storage upload failed: ${uploaded.error}.`,
            code: isSizeLimit ? 'SUPABASE_SIZE_LIMIT' : 'SUPABASE_UPLOAD_FAILED',
          });
        }

        // Verify final Storage object exists & matches assembled byte length BEFORE persisting & cleaning chunks
        const verifiedFinal = await inspectStorageObjectMetadata('video-studio', uploaded.path);
        if (
          !verifiedFinal.exists ||
          (typeof verifiedFinal.size === 'number' && verifiedFinal.size > 0 && verifiedFinal.size !== assembledBytes)
        ) {
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: 'Final Supabase Storage object verification failed.',
          });
          leaseAcquired = false;
          return res.status(502).json({
            uploaded: false,
            error: 'Final Supabase Storage object verification failed; chunks retained for retry.',
            code: 'STORAGE_VERIFICATION_FAILED',
          });
        }

        // Persist video_renders DB record BEFORE deleting cloud _chunks/
        const existingProj = await getProjectAuthoritative(scopeKey, sess.project_id);
        const existingRender = existingProj?.renders.find((r) => r.id === sess!.render_id);
        const nowIso = new Date().toISOString();

        assertSyncOk(
          await syncRowsToSupabase(
            'video_renders',
            [
              {
                id: sess.render_id,
                owner_uid: scopeKey,
                project_id: sess.project_id,
                format: sess.format,
                width: existingRender?.resolution === '540x960' ? 540 : existingRender?.resolution === '1920x1080' ? 1920 : 1080,
                height: existingRender?.resolution === '540x960' ? 960 : existingRender?.resolution === '1920x1080' ? 1080 : 1920,
                fps: existingRender?.fps || 30,
                duration_sec: existingRender?.durationSeconds || existingProj?.targetDurationSeconds || 75,
                status: 'completed',
                progress_pct: 100,
                checkpoint_json: {
                  engine: existingRender?.engine || 'remotion-web',
                  lastCheckpointFrame: existingRender?.lastCheckpointFrame,
                },
                storage_bucket: 'video-studio',
                storage_path: uploaded.path,
                sha256: assembledSha256,
                error_message: null,
                created_at: existingRender?.createdAt || nowIso,
                completed_at: nowIso,
              },
            ],
            'owner_uid,id'
          )
        );

        const finalizedRes = await callSupabaseRpc<{ ok?: boolean; code?: string; error?: string }>(
          'finalize_video_upload_session',
          {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: true,
            p_storage_path: uploaded.path,
            p_bytes_uploaded: assembledBytes,
            p_assembled_sha256: assembledSha256,
            p_error_message: null,
          }
        );
        const finalized = assertSyncOk(finalizedRes);
        if (!finalized?.ok) {
          return res.status(409).json({
            uploaded: false,
            error: finalized?.error || 'Upload completion lease was superseded before finalizing.',
            code: finalized?.code || 'LEASE_TOKEN_MISMATCH',
          });
        }
        leaseAcquired = false;

        // ONLY AFTER final Storage object is verified AND video_renders + completed session are persisted, clean cloud _chunks/
        if (chunkObjectPaths.length > 0) {
          const rmRes = await removeStorageObjects('video-studio', chunkObjectPaths);
          if (rmRes.ok) {
            await callSupabaseRpc('mark_video_upload_chunks_cleaned', {
              p_upload_id: uploadId,
              p_owner_uid: scopeKey,
            }).catch(() => {});
          }
        }

        return res.json({
          uploaded: true,
          storageBucket: 'video-studio',
          storagePath: uploaded.path,
          signedUrl: uploaded.signedUrl,
          bytesUploaded: assembledBytes,
          sha256: assembledSha256,
        });
      } catch (err) {
        if (leaseAcquired) {
          const errMsg = err instanceof Error ? err.message : 'Unexpected upload completion error.';
          await callSupabaseRpc('finalize_video_upload_session', {
            p_upload_id: uploadId,
            p_owner_uid: scopeKey,
            p_lease_token: leaseToken,
            p_success: false,
            p_error_message: errMsg,
          }).catch(() => {});
        }
        return handleRouteError(res, err, 'Unexpected upload completion error.');
      } finally {
        if (workDir) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      }
    }
  );

  app.get(
    '/api/video-studio/projects/:id/renders/:renderId/url',
    authGuard,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const scopeKey = getScopeKey(req);
        const id = String(req.params.id || '').trim();
        const renderId = String(req.params.renderId || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const ownership = await verifyVideoProjectOwnership(scopeKey, id);
        if (!ownership.owned || !ownership.project) {
          return res.status(404).json({ error: 'Video project not found.' });
        }

        const client = getSupabaseAdmin();
        if (!client) {
          return res.status(503).json({ error: 'Supabase Storage is not configured.' });
        }

        const knownRender = ownership.project.renders.find((r) => r.id === renderId);
        const verified = await findExistingStorageRenderObject(
          scopeKey,
          id,
          renderId,
          knownRender?.format === 'webm' ? 'webm' : 'mp4',
          undefined,
          knownRender?.storagePath
        );

        if (!verified.exists || !verified.signedUrl) {
          return res.status(404).json({ error: 'Rendered video file not found in Supabase Storage.' });
        }

        return res.json({
          ok: true,
          storageBucket: 'video-studio',
          storagePath: verified.objectPath,
          signedUrl: verified.signedUrl,
        });
      } catch (err) {
        return handleRouteError(res, err, 'Failed to resolve render download URL.');
      }
    }
  );

  app.post('/api/video-studio/projects/:id/render-checkpoint', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      const ownership = await verifyVideoProjectOwnership(scopeKey, id);
      if (!ownership.owned || !ownership.project) {
        return res.status(404).json({ error: 'Video project not found.' });
      }
      const project = ownership.project;

      const body = req.body as {
        render?: VideoRenderRecord;
        base64Video?: string;
        mimeType?: string;
      };
      if (!body.render) {
        return res.status(400).json({ error: 'Render record is required.' });
      }

      const existingRender = project.renders.find((r) => r.id === body.render!.id);
      let storagePath = body.render.storagePath || existingRender?.storagePath;
      let storageBucket = body.render.storageBucket || existingRender?.storageBucket;
      let uploadError: string | undefined;
      let fileSha256: string | undefined;
      const ext = body.render.format === 'webm' ? 'webm' : 'mp4';

      if (!storagePath && body.render.status === 'completed') {
        const existingObj = await findExistingStorageRenderObject(
          scopeKey,
          id,
          body.render.id,
          ext
        );
        if (existingObj.exists) {
          storagePath = existingObj.objectPath;
          storageBucket = 'video-studio';
        } else if (body.base64Video) {
          const buf = Buffer.from(body.base64Video, 'base64');
          fileSha256 = crypto.createHash('sha256').update(buf).digest('hex');
          const uploaded = await uploadToSupabaseBucket({
            bucket: 'video-studio',
            ownerUid: scopeKey,
            relativePath: `${id}/${body.render.id}.${ext}`,
            buffer: buf,
            contentType: body.mimeType || (ext === 'webm' ? 'video/webm' : 'video/mp4'),
          });
          if (uploaded.ok) {
            storagePath = uploaded.path;
            storageBucket = 'video-studio';
          } else {
            uploadError = uploaded.error;
          }
        }
      }

      const record: VideoRenderRecord = {
        ...body.render,
        projectId: id,
        storagePath,
        storageBucket: storagePath ? storageBucket || 'video-studio' : undefined,
      };

      const existingIdx = project.renders.findIndex((r) => r.id === record.id);
      if (existingIdx >= 0) project.renders[existingIdx] = record;
      else project.renders.unshift(record);
      if (record.status === 'completed') {
        project.status = 'rendered';
        project.workflowStage = 'export';
      }
      project.updatedAt = new Date().toISOString();

      if (isSupabaseConfigured()) {
        const [parsedW, parsedH] = String(record.resolution || '1080x1920')
          .split('x')
          .map((n) => Number(n));
        const width = Number.isFinite(parsedW) && parsedW > 0 ? parsedW : 1080;
        const height = Number.isFinite(parsedH) && parsedH > 0 ? parsedH : 1920;

        // Preserve any already-persisted sha256 if already written during upload-render/complete
        const supaClient = getSupabaseAdmin();
        if (!fileSha256 && supaClient) {
          const { data: prevRow } = await supaClient
            .from('video_renders')
            .select('sha256')
            .eq('owner_uid', scopeKey)
            .eq('id', record.id)
            .maybeSingle();
          const prevSha = (prevRow as { sha256?: string | null } | null)?.sha256;
          if (prevSha) fileSha256 = prevSha;
        }

        assertSyncOk(
          await syncRowsToSupabase(
            'video_renders',
            [
              {
                id: record.id,
                owner_uid: scopeKey,
                project_id: id,
                format: record.format,
                width,
                height,
                fps: record.fps,
                duration_sec: record.durationSeconds,
                status: record.status,
                progress_pct: record.progress,
                checkpoint_json: {
                  engine: record.engine,
                  lastCheckpointFrame: record.lastCheckpointFrame,
                },
                storage_bucket: record.storagePath ? record.storageBucket || 'video-studio' : null,
                storage_path: record.storagePath || null,
                sha256: fileSha256 || null,
                error_message: record.error || uploadError || null,
                created_at: record.createdAt,
                completed_at: record.status === 'completed' ? new Date().toISOString() : null,
              },
            ],
            'owner_uid,id'
          )
        );

        assertSyncOk(
          await syncRowsToSupabase(
            'video_projects',
            [
              {
                id: project.id,
                owner_uid: scopeKey,
                workspace_id: project.workspaceId,
                status: project.status,
                workflow_stage: project.workflowStage,
                updated_at: project.updatedAt,
              },
            ],
            'owner_uid,id'
          )
        );
      } else if (isProductionRuntime()) {
        return res.status(503).json({
          error: 'Supabase must be configured in production to persist render checkpoints.',
          code: 'SUPABASE_NOT_CONFIGURED',
        });
      } else {
        const store = loadStore(scopeKey);
        const sIdx = store.projects.findIndex((p) => p.id === project.id);
        if (sIdx >= 0) store.projects[sIdx] = project;
        else store.projects.unshift(project);
        saveStore(scopeKey, store);
      }

      return res.json({ render: record, project, uploadError });
    } catch (err) {
      return handleRouteError(res, err, 'Failed to save render checkpoint.');
    }
  });
}
