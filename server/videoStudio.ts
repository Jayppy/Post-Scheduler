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
  requireServerOperator,
} from './aiProviders/authMiddleware';

function getScopeKey(req: AuthenticatedRequest): string {
  return req.operatorContext?.ownerScopeKey || 'local-operator';
}
import { executeAiTask } from './aiProviders/providerManager';
import { getDataDirPath } from './tokenCrypto';
import {
  deleteRowFromSupabase,
  syncRowsToSupabase,
} from './supabase/syncHelper';
import { getSupabaseConfigDiagnostics, uploadToSupabaseBucket } from './supabase/client';
import { aiGenerationLimiter, videoUploadLimiter } from './rateLimiters';

const DATA_DIR = getDataDirPath();
const MAX_SUPABASE_RENDER_BYTES = 100 * 1024 * 1024; // Matches video-studio bucket fileSizeLimit

interface ChunkUploadSession {
  uploadId: string;
  ownerScopeKey: string;
  projectId: string;
  renderId: string;
  format: 'mp4' | 'webm';
  mimeType: string;
  totalChunks: number;
  totalBytes: number;
  workDir: string;
  receivedChunks: Set<number>;
  createdAt: number;
}

const chunkUploadSessions = new Map<string, ChunkUploadSession>();

function cleanupExpiredUploadSessions(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, sess] of chunkUploadSessions.entries()) {
    if (sess.createdAt < cutoff) {
      fs.rmSync(sess.workDir, { recursive: true, force: true });
      chunkUploadSessions.delete(id);
    }
  }
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

async function mirrorVideoProjectToSupabase(project: VideoProject, ownerUid: string): Promise<void> {
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
  );

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
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    ],
    'owner_uid,id'
  );

  if (project.scenes.length > 0) {
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
    );
  }
}

export function registerVideoStudio(app: Express): void {
  const jsonParser = express.json({ limit: '4mb' });
  const authGuard = requireServerOperator('ws-behind-the-release');

  app.get('/api/video-studio/providers', authGuard, (_req: AuthenticatedRequest, res: Response) => {
    return res.json({ providers: getVideoGenerationProviders() });
  });

  app.get('/api/video-studio/projects', authGuard, (req: AuthenticatedRequest, res: Response) => {
    const scopeKey = getScopeKey(req);
    const store = loadStore(scopeKey);
    return res.json({
      projects: [...store.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  });

  app.post('/api/video-studio/projects', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
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

    const store = loadStore(scopeKey);
    const idx = store.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) store.projects[idx] = project;
    else store.projects.unshift(project);
    saveStore(scopeKey, store);
    await mirrorVideoProjectToSupabase(project, scopeKey);

    return res.json({ project });
  });

  app.put('/api/video-studio/projects/:id', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scopeKey = getScopeKey(req);
    const id = String(req.params.id || '');
    const store = loadStore(scopeKey);
    const idx = store.projects.findIndex((p) => p.id === id);
    if (idx < 0) {
      return res.status(404).json({ error: 'Video project not found.' });
    }
    const incoming = req.body as Partial<VideoProject>;
    const existing = store.projects[idx];
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
    store.projects[idx] = updated;
    saveStore(scopeKey, store);
    await mirrorVideoProjectToSupabase(updated, scopeKey);
    return res.json({ project: updated });
  });

  app.delete('/api/video-studio/projects/:id', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scopeKey = getScopeKey(req);
    const id = String(req.params.id || '');
    const store = loadStore(scopeKey);
    store.projects = store.projects.filter((p) => p.id !== id);
    saveStore(scopeKey, store);
    await deleteRowFromSupabase('video_projects', scopeKey, id);
    return res.json({ ok: true });
  });

  app.post('/api/video-studio/generate-script', jsonParser, authGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scopeKey = getScopeKey(req);
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
        const fb = buildDeterministicFallbackProject({
          topic,
          audience,
          style,
          targetDurationSeconds: targetDuration,
          destination,
        });
        if (body.saveProject !== false) {
          const store = loadStore(scopeKey);
          store.projects.unshift(fb);
          saveStore(scopeKey, store);
          await mirrorVideoProjectToSupabase(fb, scopeKey);
        }
        return res.json({ project: fb, usedFallbackTemplate: true });
      }

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

      const project: VideoProject = {
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

      if (body.saveProject !== false) {
        const store = loadStore(scopeKey);
        store.projects.unshift(project);
        saveStore(scopeKey, store);
        await mirrorVideoProjectToSupabase(project, scopeKey);
      }

      return res.json({ project, usedFallbackTemplate: false });
    } catch {
      const fb = buildDeterministicFallbackProject({
        topic,
        audience,
        style,
        targetDurationSeconds: targetDuration,
        destination,
      });
      if (body.saveProject !== false) {
        const store = loadStore(scopeKey);
        store.projects.unshift(fb);
        saveStore(scopeKey, store);
        await mirrorVideoProjectToSupabase(fb, scopeKey);
      }
      return res.json({ project: fb, usedFallbackTemplate: true });
    }
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

  // Chunked/Resumable Cloud Storage Upload for Large Video Renders (>3MB up to 100MB bucket limit)
  app.post(
    '/api/video-studio/projects/:id/upload-render/init',
    jsonParser,
    authGuard,
    videoUploadLimiter,
    (req: AuthenticatedRequest, res: Response) => {
      cleanupExpiredUploadSessions();
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      const store = loadStore(scopeKey);
      const project = store.projects.find((p) => p.id === id);
      if (!project) {
        return res.status(404).json({ error: 'Video project not found.' });
      }

      const diag = getSupabaseConfigDiagnostics();
      if (!diag.configured) {
        return res.status(503).json({
          error: `Cloud upload skipped: Supabase not configured (${diag.missingEnvVars.join(', ')}). Video remains saved locally in browser storage.`,
          code: 'SUPABASE_NOT_CONFIGURED',
          cloudSupported: false,
        });
      }

      const body = (req.body || {}) as {
        renderId?: string;
        format?: 'mp4' | 'webm';
        mimeType?: string;
        totalBytes?: number;
        totalChunks?: number;
      };
      const totalBytes = Number(body.totalBytes || 0);
      const totalChunks = Math.max(1, Math.min(256, Math.round(Number(body.totalChunks || 1))));
      if (!body.renderId || !Number.isFinite(totalBytes) || totalBytes <= 0) {
        return res.status(400).json({ error: 'Valid renderId, totalBytes, and totalChunks are required.' });
      }
      if (totalBytes > MAX_SUPABASE_RENDER_BYTES) {
        return res.status(413).json({
          error: `Rendered video (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the configured Supabase bucket limit (${MAX_SUPABASE_RENDER_BYTES / (1024 * 1024)} MB). Local browser backup and download remain intact.`,
          code: 'FILE_TOO_LARGE_FOR_BUCKET',
          maxBytes: MAX_SUPABASE_RENDER_BYTES,
        });
      }

      const uploadId = `upl_${crypto.randomBytes(10).toString('hex')}`;
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), '74studio-vidup-'));
      chunkUploadSessions.set(uploadId, {
        uploadId,
        ownerScopeKey: scopeKey,
        projectId: project.id,
        renderId: String(body.renderId).replace(/[^a-zA-Z0-9_-]/g, ''),
        format: body.format === 'webm' ? 'webm' : 'mp4',
        mimeType: body.mimeType || (body.format === 'webm' ? 'video/webm' : 'video/mp4'),
        totalChunks,
        totalBytes,
        workDir,
        receivedChunks: new Set<number>(),
        createdAt: Date.now(),
      });

      return res.json({ uploadId, maxBytes: MAX_SUPABASE_RENDER_BYTES });
    }
  );

  app.put(
    '/api/video-studio/projects/:id/upload-render/:uploadId/chunk',
    authGuard,
    videoUploadLimiter,
    express.raw({ type: ['application/octet-stream', 'video/*'], limit: '5mb' }),
    (req: AuthenticatedRequest, res: Response) => {
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      const uploadId = String(req.params.uploadId || '');
      const sess = chunkUploadSessions.get(uploadId);
      if (!sess || sess.ownerScopeKey !== scopeKey || sess.projectId !== id) {
        return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
      }

      const chunkIndex = Number(req.query.index);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= sess.totalChunks) {
        return res.status(400).json({ error: 'Invalid chunk index.' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty upload chunk.' });
      }

      const chunkPath = path.resolve(sess.workDir, `chunk-${String(chunkIndex).padStart(5, '0')}.bin`);
      if (!chunkPath.startsWith(sess.workDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid chunk target path.' });
      }

      fs.writeFileSync(chunkPath, req.body);
      sess.receivedChunks.add(chunkIndex);
      return res.json({
        ok: true,
        chunkIndex,
        receivedCount: sess.receivedChunks.size,
        totalChunks: sess.totalChunks,
      });
    }
  );

  app.post(
    '/api/video-studio/projects/:id/upload-render/:uploadId/complete',
    jsonParser,
    authGuard,
    videoUploadLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      const scopeKey = getScopeKey(req);
      const id = String(req.params.id || '');
      const uploadId = String(req.params.uploadId || '');
      const sess = chunkUploadSessions.get(uploadId);
      if (!sess || sess.ownerScopeKey !== scopeKey || sess.projectId !== id) {
        return res.status(404).json({ error: 'Upload session not found or unauthorized.' });
      }

      try {
        if (sess.receivedChunks.size < sess.totalChunks) {
          return res.status(400).json({
            error: `Incomplete chunk upload (${sess.receivedChunks.size}/${sess.totalChunks} chunks received).`,
            receivedChunks: Array.from(sess.receivedChunks),
          });
        }

        const partBuffers: Buffer[] = [];
        for (let i = 0; i < sess.totalChunks; i += 1) {
          const chunkPath = path.resolve(sess.workDir, `chunk-${String(i).padStart(5, '0')}.bin`);
          if (!chunkPath.startsWith(sess.workDir + path.sep) || !fs.existsSync(chunkPath)) {
            return res.status(400).json({ error: `Missing chunk ${i} during assembly.` });
          }
          partBuffers.push(fs.readFileSync(chunkPath));
        }

        const fullBuffer = Buffer.concat(partBuffers);
        const uploaded = await uploadToSupabaseBucket({
          bucket: 'video-studio',
          ownerUid: scopeKey,
          relativePath: `${sess.projectId}/${sess.renderId}.${sess.format}`,
          buffer: fullBuffer,
          contentType: sess.mimeType,
        });

        if (!uploaded.ok) {
          const lowerErr = uploaded.error.toLowerCase();
          const isSizeLimit =
            lowerErr.includes('size') || lowerErr.includes('too large') || lowerErr.includes('payload');
          return res.status(isSizeLimit ? 413 : 502).json({
            uploaded: false,
            error: isSizeLimit
              ? `Supabase Storage rejected upload due to plan/bucket size limit (${uploaded.error}). Local IndexedDB copy and download remain intact.`
              : `Supabase Storage upload failed: ${uploaded.error}. Local IndexedDB copy remains intact.`,
            code: isSizeLimit ? 'SUPABASE_SIZE_LIMIT' : 'SUPABASE_UPLOAD_FAILED',
          });
        }

        return res.json({
          uploaded: true,
          storageBucket: 'video-studio',
          storagePath: uploaded.path,
          signedUrl: uploaded.signedUrl,
          bytesUploaded: fullBuffer.length,
        });
      } finally {
        fs.rmSync(sess.workDir, { recursive: true, force: true });
        chunkUploadSessions.delete(uploadId);
      }
    }
  );

  app.post('/api/video-studio/projects/:id/render-checkpoint', jsonParser, authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scopeKey = getScopeKey(req);
    const id = String(req.params.id || '');
    const store = loadStore(scopeKey);
    const project = store.projects.find((p) => p.id === id);
    if (!project) {
      return res.status(404).json({ error: 'Video project not found.' });
    }

    const body = req.body as {
      render?: VideoRenderRecord;
      base64Video?: string;
      mimeType?: string;
    };
    if (!body.render) {
      return res.status(400).json({ error: 'Render record is required.' });
    }

    let storagePath = body.render.storagePath;
    let storageBucket = body.render.storageBucket;
    let uploadError: string | undefined;

    if (!storagePath && body.base64Video && body.render.status === 'completed') {
      const buf = Buffer.from(body.base64Video, 'base64');
      const ext = body.render.format === 'webm' ? 'webm' : 'mp4';
      const uploaded = await uploadToSupabaseBucket({
        bucket: 'video-studio',
        ownerUid: scopeKey,
        relativePath: `${project.id}/${body.render.id}.${ext}`,
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

    const record: VideoRenderRecord = {
      ...body.render,
      projectId: project.id,
      storagePath,
      storageBucket: storagePath ? storageBucket || 'video-studio' : undefined,
    };

    const existingIdx = project.renders.findIndex((r) => r.id === record.id);
    if (existingIdx >= 0) project.renders[existingIdx] = record;
    else project.renders.unshift(record);
    if (record.status === 'completed') {
      project.status = 'rendered';
    }
    project.updatedAt = new Date().toISOString();
    saveStore(scopeKey, store);

    const width = record.resolution === '1080x1920' ? 1080 : 540;
    const height = record.resolution === '1080x1920' ? 1920 : 960;

    await syncRowsToSupabase(
      'video_renders',
      [
        {
          id: record.id,
          owner_uid: scopeKey,
          project_id: project.id,
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
          storage_path: record.storagePath || null,
          error_message: record.error || uploadError || null,
          created_at: record.createdAt,
          completed_at: record.status === 'completed' ? new Date().toISOString() : null,
        },
      ],
      'owner_uid,id'
    );

    return res.json({ render: record, project, uploadError });
  });
}
