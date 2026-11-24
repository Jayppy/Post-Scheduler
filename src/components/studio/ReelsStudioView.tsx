import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarPlus,
  Check,
  CheckCircle2,
  Clapperboard,
  Download,
  FileAudio,
  Film,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Mic,
  Pause,
  Play,
  Plus,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { aiClient, AiApiError } from '../../services/aiClient';
import { triggerBlobDownload } from '../../services/carouselRenderer';
import { blobToBase64, getMediaBlob, putMediaBlob } from '../../services/idb';
import { createId } from '../../services/storage';
import {
  drawReelFrame,
  formatTimecode,
  parseSrtOrTranscript,
  renderReelVideo,
  RenderReelOutput,
  validateReelForPlatform,
} from '../../services/videoEngine';
import {
  CreativeProject,
  EditingPreset,
  ExportRecord,
  ReelAssetRef,
  ReelCreationMode,
  ReelState,
  StoryboardScene,
  SubtitleSegment,
  TimelineClip,
} from '../../types/studio';

const CREATION_MODES: Array<{ id: ReelCreationMode; label: string; desc: string }> = [
  { id: 'music-promotion', label: 'Music Promotion', desc: 'Single drops, teasers, release campaigns' },
  { id: 'educational-reels', label: 'Educational Reels', desc: 'Music-industry advice & artist breakdowns' },
  { id: 'talking-head', label: 'Talking-Head Videos', desc: 'Commentary, explanations, presenter clips' },
  { id: 'cinematic-promotional', label: 'Cinematic Promotional', desc: 'Atmospheric visual storytelling' },
  { id: 'typography-driven', label: 'Typography-Driven', desc: 'Kinetic text & graphic narrative frames' },
];

function createDefaultReelState(defaultPreset: EditingPreset): ReelState {
  return {
    step: 1,
    creationMode: 'music-promotion',
    presetId: defaultPreset.id,
    topic: '',
    script: '',
    transcript: '',
    targetDuration: 24,
    assets: [],
    storyboardApproved: false,
    storyboard: [],
    editingNotes: '',
    hookLine: '',
    closingCta: '',
    timelineClips: [],
    musicVolume: 0.7,
    voiceVolume: 1.0,
    audioFadeIn: 0.5,
    audioFadeOut: 1.0,
    subtitles: [],
    subtitleSettings: {
      fontFamily: defaultPreset.fontFamily,
      fontSize: 48,
      position: 'bottom',
      animationPreset: 'word-highlight',
      highlightColor: '#f59e0b',
    },
    showProgressBar: true,
    showBrandLogo: true,
    introTemplate: 'minimal-title',
    outroTemplate: 'brand-cta',
    colorTreatment: defaultPreset.colorTreatment,
    destinationProfile: 'instagram-reels',
  };
}

export const ReelsStudioView: React.FC = () => {
  const {
    activeWorkspace,
    activeProject,
    workspaceProjects,
    editingPresets,
    saveEditingPreset,
    saveProject,
    setActiveProjectId,
    addExportRecord,
    saveExportToMediaLibrary,
    openPostComposerWithDraft,
    schedulePostToCalendar,
    notify,
  } = useStudio();

  const existingProject =
    activeProject && activeProject.type === 'reel'
      ? activeProject
      : workspaceProjects.find((p) => p.type === 'reel');

  const [project, setProject] = useState<CreativeProject>(() => {
    if (existingProject && existingProject.reelState) return existingProject;
    const now = new Date().toISOString();
    return {
      id: createId('proj'),
      workspaceId: activeWorkspace.id,
      title: `${activeWorkspace.name} Vertical Reel`,
      type: 'reel',
      themeId: activeWorkspace.defaultThemeId,
      status: 'draft',
      reelState: createDefaultReelState(editingPresets[0]),
      createdAt: now,
      updatedAt: now,
    };
  });

  // Sync if user switches to a different reel project from Creative Projects
  useEffect(() => {
    if (activeProject && activeProject.type === 'reel' && activeProject.id !== project.id) {
      setProject(activeProject);
    }
  }, [activeProject?.id]);

  const reel = project.reelState!;
  const activePreset = editingPresets.find((p) => p.id === reel.presetId) || editingPresets[0];

  const persistReel = (nextReel: ReelState, nextTitle?: string, nextStatus?: CreativeProject['status']) => {
    const updated: CreativeProject = {
      ...project,
      title: nextTitle ?? project.title,
      status: nextStatus ?? project.status,
      reelState: nextReel,
      updatedAt: new Date().toISOString(),
    };
    setProject(updated);
    saveProject(updated);
    setActiveProjectId(updated.id);
  };

  // Upload & AI states
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  // Timeline Editor states
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    reel.timelineClips[0]?.id || null
  );
  const [editorTab, setEditorTab] = useState<'clip' | 'audio' | 'subtitles' | 'style'>('clip');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaElementsRef = useRef<Map<string, HTMLVideoElement | HTMLImageElement>>(new Map());
  const previewUrlsRef = useRef<string[]>([]);

  // Export states
  const [exportRes, setExportRes] = useState<'1080x1920' | '720x1280'>('1080x1920');
  const [isRendering, setIsRendering] = useState(false);
  const [renderStage, setRenderStage] = useState('');
  const [renderPct, setRenderPct] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [exportedOutput, setExportedOutput] = useState<RenderReelOutput | null>(null);
  const [exportedPreviewUrl, setExportedPreviewUrl] = useState<string>('');
  const [lastExportRecord, setLastExportRecord] = useState<ExportRecord | null>(null);
  const [showCalModal, setShowCalModal] = useState(false);
  const [calDate, setCalDate] = useState('2026-11-27');
  const [calTime, setCalTime] = useState('18:00');
  const abortRef = useRef<AbortController | null>(null);

  const totalDuration = useMemo(
    () => reel.timelineClips.reduce((acc, c) => acc + Math.max(0.5, c.duration), 0),
    [reel.timelineClips]
  );

  const validation = useMemo(() => validateReelForPlatform(reel), [reel]);

  // Load IndexedDB media elements for live 9:16 preview canvas
  useEffect(() => {
    let active = true;
    const loadAssets = async () => {
      previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      previewUrlsRef.current = [];
      const map = new Map<string, HTMLVideoElement | HTMLImageElement>();

      for (const asset of reel.assets) {
        if (asset.kind !== 'image' && asset.kind !== 'video') continue;
        const blob = await getMediaBlob(asset.blobKey);
        if (!blob || !active) continue;
        const url = URL.createObjectURL(blob);
        previewUrlsRef.current.push(url);

        if (asset.kind === 'image') {
          const img = new Image();
          img.src = url;
          await new Promise((r) => {
            img.onload = r;
            img.onerror = r;
          });
          map.set(asset.id, img);
        } else {
          const vid = document.createElement('video');
          vid.src = url;
          vid.muted = true;
          vid.playsInline = true;
          vid.preload = 'metadata';
          await new Promise((r) => {
            vid.onloadedmetadata = r;
            vid.onerror = r;
          });
          map.set(asset.id, vid);
        }
      }
      if (active) {
        mediaElementsRef.current = map;
      }
    };
    loadAssets();
    return () => {
      active = false;
      previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      previewUrlsRef.current = [];
    };
  }, [reel.assets.length]);

  // Draw preview frame whenever playhead or reel state changes
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawReelFrame(
      ctx,
      canvas.width,
      canvas.height,
      playhead,
      Math.max(1, totalDuration),
      reel,
      activeWorkspace,
      mediaElementsRef.current
    );
  }, [playhead, reel, activeWorkspace, totalDuration]);

  // Real-time preview playback loop
  useEffect(() => {
    if (!isPlaying) return;
    const dur = Math.max(1, totalDuration);
    const startWall = performance.now() - playhead * 1000;
    let rafId = 0;

    const loop = () => {
      const elapsed = (performance.now() - startWall) / 1000;
      if (elapsed >= dur) {
        setPlayhead(0);
        setIsPlaying(false);
        return;
      }
      setPlayhead(elapsed);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, totalDuration]);

  // Cleanup exported preview object URL
  useEffect(() => {
    return () => {
      if (exportedPreviewUrl) URL.revokeObjectURL(exportedPreviewUrl);
    };
  }, [exportedPreviewUrl]);

  const probeMediaDuration = (file: File, kind: ReelAssetRef['kind']): Promise<{ duration?: number; width?: number; height?: number }> => {
    return new Promise((resolve) => {
      if (kind === 'image') {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
          URL.revokeObjectURL(url);
        };
        img.onerror = () => {
          resolve({});
          URL.revokeObjectURL(url);
        };
        img.src = url;
        return;
      }
      const url = URL.createObjectURL(file);
      const media = document.createElement(kind === 'video' ? 'video' : 'audio');
      media.preload = 'metadata';
      media.onloadedmetadata = () => {
        resolve({
          duration: Number.isFinite(media.duration) ? media.duration : undefined,
          width: media instanceof HTMLVideoElement ? media.videoWidth : undefined,
          height: media instanceof HTMLVideoElement ? media.videoHeight : undefined,
        });
        URL.revokeObjectURL(url);
      };
      media.onerror = () => {
        resolve({});
        URL.revokeObjectURL(url);
      };
      media.src = url;
    });
  };

  const handleUploadMediaFiles = async (
    files: FileList | null,
    forcedKind?: 'audio' | 'voice'
  ) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const added: ReelAssetRef[] = [];

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setUploadPct(Math.round(((i + 0.3) / list.length) * 100));

      let kind: ReelAssetRef['kind'] = forcedKind || 'image';
      if (!forcedKind) {
        if (file.type.startsWith('video/')) kind = 'video';
        else if (file.type.startsWith('audio/')) kind = 'audio';
        else kind = 'image';
      }

      const meta = await probeMediaDuration(file, kind);
      const blobKey = createId('reel-blob');
      await putMediaBlob(blobKey, file);

      added.push({
        id: createId('rasset'),
        name: file.name,
        kind,
        mimeType: file.type || 'application/octet-stream',
        blobKey,
        sizeBytes: file.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        description: '',
      });
      setUploadPct(Math.round(((i + 1) / list.length) * 100));
    }

    const firstAudio = added.find((a) => a.kind === 'audio');
    const firstVoice = added.find((a) => a.kind === 'voice');
    persistReel({
      ...reel,
      assets: [...reel.assets, ...added],
      audioTrackAssetId: reel.audioTrackAssetId || firstAudio?.id,
      voiceTrackAssetId: reel.voiceTrackAssetId || firstVoice?.id,
    });
    setUploadPct(null);
    notify('success', `${added.length} media file(s) stored in IndexedDB`);
  };

  const handleGenerateEditingPlan = async () => {
    setAiNotice(null);
    if (!reel.topic.trim() && !reel.script.trim() && reel.assets.length === 0) {
      notify('warning', 'Provide a topic, script, or upload media files first.');
      return;
    }
    setIsGeneratingPlan(true);
    try {
      const plan = await aiClient.generateReelsPlan({
        topic: reel.topic,
        existingScript: reel.script,
        transcript: reel.transcript,
        creationMode: reel.creationMode,
        editingPresetName: activePreset.name,
        targetDuration: reel.targetDuration,
        assets: reel.assets.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          duration: a.duration,
          description: a.description,
        })),
        workspaceName: activeWorkspace.name,
        brandVoice: activeWorkspace.brandVoice,
      });

      const scenes: StoryboardScene[] = (plan.scenes || []).map((s, idx) => ({
        id: createId('sc'),
        sceneNumber: s.sceneNumber || idx + 1,
        recommendedAssetId: s.recommendedAssetId || 'typography-card',
        recommendedAssetName:
          reel.assets.find((a) => a.id === s.recommendedAssetId)?.name ||
          s.recommendedAssetName ||
          'Typography Frame',
        durationSeconds: Math.max(1, Math.min(15, Number(s.durationSeconds) || activePreset.pacingSeconds)),
        sceneDescription: s.sceneDescription,
        textOverlay: s.textOverlay || '',
        lowerThird: s.lowerThird || '',
        subtitleLine: s.subtitleLine || '',
        transitionStyle: s.transitionStyle || activePreset.transitionStyle,
        motionPreset: s.motionPreset || activePreset.motionStyle,
        visualEmphasis: s.visualEmphasis || '',
      }));

      persistReel(
        {
          ...reel,
          step: 2,
          hookLine: plan.hookLine,
          script: plan.fullScript || reel.script,
          closingCta: plan.closingCta,
          editingNotes: plan.editingNotes || plan.musicDirection || '',
          suggestedCaption: plan.suggestedCaption,
          storyboard: scenes,
          storyboardApproved: false,
        },
        plan.projectTitle || project.title,
        'storyboard-ready'
      );
      notify('success', 'Editing plan & storyboard ready for review');
    } catch (err) {
      const msg = err instanceof AiApiError ? err.message : 'Gemini editing assistant unavailable.';
      setAiNotice(msg);
      notify('warning', 'AI unavailable — build storyboard manually', msg);
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  const handleBuildManualStoryboard = () => {
    const visualAssets = reel.assets.filter((a) => a.kind === 'video' || a.kind === 'image');
    const scenes: StoryboardScene[] =
      visualAssets.length > 0
        ? visualAssets.map((a, idx) => ({
            id: createId('sc'),
            sceneNumber: idx + 1,
            recommendedAssetId: a.id,
            recommendedAssetName: a.name,
            durationSeconds: Math.min(6, Math.max(2.5, a.duration || activePreset.pacingSeconds)),
            sceneDescription: a.description || `Feature ${a.name} cleanly in vertical frame.`,
            textOverlay: idx === 0 ? reel.topic || project.title : '',
            lowerThird: idx === 1 ? activeWorkspace.name : '',
            subtitleLine: '',
            transitionStyle: activePreset.transitionStyle,
            motionPreset: activePreset.motionStyle,
            visualEmphasis: 'Center vertical framing',
          }))
        : [1, 2, 3].map((num) => ({
            id: createId('sc'),
            sceneNumber: num,
            recommendedAssetId: 'typography-card',
            recommendedAssetName: 'Typography Card',
            durationSeconds: activePreset.pacingSeconds,
            sceneDescription: `Typography scene ${num}`,
            textOverlay:
              num === 1
                ? reel.topic || 'Opening Hook'
                : num === 2
                  ? 'Core Insight'
                  : activeWorkspace.defaultOutroText,
            lowerThird: '',
            subtitleLine: '',
            transitionStyle: activePreset.transitionStyle,
            motionPreset: activePreset.motionStyle,
            visualEmphasis: 'High contrast typography',
          }));

    persistReel({
      ...reel,
      step: 2,
      storyboard: scenes,
      storyboardApproved: false,
    });
  };

  const handleApproveStoryboardAndAssemble = () => {
    let cursor = 0;
    const clips: TimelineClip[] = [];
    const subs: SubtitleSegment[] = [];

    for (const sc of reel.storyboard) {
      const asset = reel.assets.find((a) => a.id === sc.recommendedAssetId);
      const kind: TimelineClip['kind'] =
        asset?.kind === 'video' ? 'video' : asset?.kind === 'image' ? 'image' : 'typography-card';

      clips.push({
        id: createId('clip'),
        assetId: asset ? asset.id : 'typography-card',
        assetName: asset ? asset.name : 'Typography Frame',
        kind,
        startTime: cursor,
        duration: sc.durationSeconds,
        trimStart: 0,
        trimEnd: sc.durationSeconds,
        transition: sc.transitionStyle,
        cropX: 0,
        cropY: 0,
        zoom: 1,
        textOverlay: sc.textOverlay,
        lowerThird: sc.lowerThird,
        motionStyle: sc.motionPreset,
      });

      if (sc.subtitleLine.trim()) {
        const words = sc.subtitleLine.trim().split(' ');
        subs.push({
          id: createId('sub'),
          startTime: Number(cursor.toFixed(2)),
          endTime: Number((cursor + sc.durationSeconds).toFixed(2)),
          text: sc.subtitleLine.trim(),
          highlightWord: words.length > 2 ? words[words.length - 1].replace(/[^a-zA-Z0-9]/g, '') : '',
        });
      }
      cursor += sc.durationSeconds;
    }

    const parsedTranscriptSubs =
      subs.length === 0 && reel.transcript.trim()
        ? parseSrtOrTranscript(reel.transcript, cursor)
        : subs;

    persistReel(
      {
        ...reel,
        step: 3,
        storyboardApproved: true,
        timelineClips: clips,
        subtitles: parsedTranscriptSubs.length > 0 ? parsedTranscriptSubs : reel.subtitles,
      },
      undefined,
      'edited'
    );
    setSelectedClipId(clips[0]?.id || null);
    setPlayhead(0);
    notify('success', 'Timeline assembled from approved storyboard');
  };

  const selectedClip =
    reel.timelineClips.find((c) => c.id === selectedClipId) || reel.timelineClips[0];

  const updateClip = (clipId: string, patch: Partial<TimelineClip>) => {
    const nextClips = reel.timelineClips.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
    persistReel({ ...reel, timelineClips: nextClips });
  };

  const splitSelectedClip = () => {
    if (!selectedClip || selectedClip.duration < 1.5) {
      notify('warning', 'Clip must be at least 1.5s long to split.');
      return;
    }
    const idx = reel.timelineClips.findIndex((c) => c.id === selectedClip.id);
    const half = Number((selectedClip.duration / 2).toFixed(2));
    const first: TimelineClip = { ...selectedClip, duration: half };
    const second: TimelineClip = {
      ...selectedClip,
      id: createId('clip'),
      duration: Number((selectedClip.duration - half).toFixed(2)),
      trimStart: selectedClip.trimStart + half,
    };
    const next = [...reel.timelineClips];
    next.splice(idx, 1, first, second);
    persistReel({ ...reel, timelineClips: next });
    notify('info', 'Clip split cleanly into two segments');
  };

  const moveClip = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= reel.timelineClips.length) return;
    const next = [...reel.timelineClips];
    [next[idx], next[target]] = [next[target], next[idx]];
    persistReel({ ...reel, timelineClips: next });
  };

  const deleteClip = (id: string) => {
    if (reel.timelineClips.length <= 1) return;
    const next = reel.timelineClips.filter((c) => c.id !== id);
    persistReel({ ...reel, timelineClips: next });
    setSelectedClipId(next[0]?.id || null);
  };

  const addClipFromAsset = (asset?: ReelAssetRef) => {
    const clip: TimelineClip = {
      id: createId('clip'),
      assetId: asset ? asset.id : 'typography-card',
      assetName: asset ? asset.name : 'Typography Frame',
      kind: asset ? (asset.kind === 'video' ? 'video' : 'image') : 'typography-card',
      startTime: totalDuration,
      duration: 3.0,
      trimStart: 0,
      trimEnd: 3.0,
      transition: activePreset.transitionStyle,
      cropX: 0,
      cropY: 0,
      zoom: 1,
      textOverlay: asset ? '' : 'New Statement Frame',
      lowerThird: '',
      motionStyle: activePreset.motionStyle,
    };
    persistReel({ ...reel, timelineClips: [...reel.timelineClips, clip] });
    setSelectedClipId(clip.id);
  };

  const handleTranscribeAudioAsset = async () => {
    const audioRef =
      reel.assets.find((a) => a.id === reel.voiceTrackAssetId) ||
      reel.assets.find((a) => a.id === reel.audioTrackAssetId) ||
      reel.assets.find((a) => a.kind === 'audio' || a.kind === 'voice');

    if (!audioRef) {
      notify('warning', 'Upload a voice recording or audio track first.');
      return;
    }

    setIsTranscribing(true);
    try {
      const blob = await getMediaBlob(audioRef.blobKey);
      if (!blob) throw new Error('Audio blob missing.');
      if (blob.size > 12 * 1024 * 1024) {
        throw new Error('Audio exceeds 12MB browser upload limit for transcription. Paste transcript manually.');
      }
      const base64Audio = await blobToBase64(blob);
      const res = await aiClient.transcribeAudio({
        base64Audio,
        mimeType: audioRef.mimeType || 'audio/mp3',
      });
      const parsed = parseSrtOrTranscript(res.transcript, Math.max(5, totalDuration));
      persistReel({
        ...reel,
        transcript: res.transcript,
        subtitles: parsed,
      });
      notify('success', 'Subtitles generated from audio', `${parsed.length} timed segments created.`);
    } catch (err) {
      notify(
        'warning',
        'Audio transcription unavailable — use manual subtitles',
        err instanceof Error ? err.message : ''
      );
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleRenderExport = async () => {
    setRenderError(null);
    if (!validation.valid) {
      setRenderError(validation.errors[0]);
      return;
    }

    setIsRendering(true);
    setRenderPct(2);
    setRenderStage('Starting video render...');
    const controller = new AbortController();
    abortRef.current = controller;

    const [w, h] = exportRes === '720x1280' ? [720, 1280] : [1080, 1920];

    try {
      const output = await renderReelVideo({
        reel,
        workspace: activeWorkspace,
        width: w,
        height: h,
        fps: 30,
        abortSignal: controller.signal,
        onProgress: (stage, pct) => {
          setRenderStage(stage);
          setRenderPct(pct);
        },
      });

      const blobKey = createId('reel-exp');
      await putMediaBlob(blobKey, output.blob);

      const exportHash = `reel-${project.id}-${Math.round(output.duration * 10)}-${w}x${h}-${reel.timelineClips.length}`;
      const record: ExportRecord = {
        id: createId('exp'),
        workspaceId: activeWorkspace.id,
        projectId: project.id,
        projectName: project.title,
        exportType: 'reel-mp4',
        themeName: activePreset.name,
        format: output.extension.toUpperCase(),
        dimensions: `${w}×${h}`,
        duration: output.duration,
        fps: output.fps,
        destinationProfile: reel.destinationProfile,
        blobKeys: [blobKey],
        exportHash,
        savedToMediaLibrary: false,
        createdAt: new Date().toISOString(),
      };

      addExportRecord(record);
      setLastExportRecord(record);
      setExportedOutput(output);
      if (exportedPreviewUrl) URL.revokeObjectURL(exportedPreviewUrl);
      setExportedPreviewUrl(URL.createObjectURL(output.blob));

      persistReel(reel, undefined, 'exported');
      notify(
        'success',
        `Video exported (${output.extension.toUpperCase()})`,
        `Engine: ${output.engineUsed} · ${output.duration.toFixed(1)}s @ ${output.fps} FPS`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rendering failed.';
      setRenderError(msg);
      notify('error', 'Video export failed — project preserved', msg);
    } finally {
      setIsRendering(false);
      abortRef.current = null;
    }
  };

  const handleSaveVideoToLibrary = async () => {
    if (!exportedOutput || !lastExportRecord) return;
    try {
      const res = await saveExportToMediaLibrary(
        lastExportRecord,
        [
          {
            filename: `${project.title}.${exportedOutput.extension}`,
            blob: exportedOutput.blob,
          },
        ],
        activeWorkspace.id,
        false
      );
      if (res.skippedDuplicate) {
        notify('info', 'This exported video is already saved in the Media Library.');
      } else {
        notify('success', 'Video saved to Media Library', `${activeWorkspace.name} Media Library updated.`);
      }
    } catch (err) {
      notify('error', 'Save failed', err instanceof Error ? err.message : '');
    }
  };

  const handleOpenComposerWithReel = async (platform: 'instagram-reel' | 'youtube-shorts') => {
    if (!exportedOutput || !lastExportRecord) return;
    const { savedAssets } = await saveExportToMediaLibrary(
      lastExportRecord,
      [{ filename: `${project.title}.${exportedOutput.extension}`, blob: exportedOutput.blob }],
      activeWorkspace.id,
      false
    );
    openPostComposerWithDraft({
      title: project.title,
      platform,
      caption: reel.suggestedCaption || `${project.title} — ${reel.hookLine || activeWorkspace.name}`,
      hashtags:
        platform === 'youtube-shorts'
          ? ['#Shorts', '#MusicIndustry', '#74Studio']
          : ['#Reels', '#74Studio', '#MusicMarketing'],
      mediaAssetIds: savedAssets.map((a) => a.id),
      sourceProjectId: project.id,
    });
  };

  const handleScheduleReelToCalendar = async () => {
    if (!exportedOutput || !lastExportRecord) return;
    const { savedAssets } = await saveExportToMediaLibrary(
      lastExportRecord,
      [{ filename: `${project.title}.${exportedOutput.extension}`, blob: exportedOutput.blob }],
      activeWorkspace.id,
      false
    );
    schedulePostToCalendar({
      title: project.title,
      platform:
        reel.destinationProfile === 'youtube-shorts' ? 'youtube-shorts' : 'instagram-reel',
      caption: reel.suggestedCaption || project.title,
      hashtags: ['#74Studio'],
      mediaAssetIds: savedAssets.map((a) => a.id),
      scheduledDate: calDate,
      scheduledTime: calTime,
      sourceProjectId: project.id,
    });
    setShowCalModal(false);
  };

  return (
    <div className="space-y-5">
      {/* Top Production Header & 4-Stage Stepper */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
        <div className="min-w-0">
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>AI Reels & Shorts Studio</span>
          </div>
          <input
            type="text"
            value={project.title}
            onChange={(e) => persistReel(reel, e.target.value)}
            className="bg-transparent text-xl font-bold text-zinc-100 border-b border-transparent hover:border-zinc-700 focus:border-zinc-400 focus:outline-none w-full max-w-md"
          />
        </div>

        <div className="inline-flex flex-wrap p-1 rounded-lg bg-[#111114] border border-zinc-800 gap-1">
          {[
            { step: 1 as const, label: '1. Assets & Brief' },
            { step: 2 as const, label: '2. Storyboard Plan' },
            { step: 3 as const, label: '3. Timeline Editor' },
            { step: 4 as const, label: '4. Export & Publish' },
          ].map((item) => (
            <button
              key={item.step}
              type="button"
              onClick={() => persistReel({ ...reel, step: item.step })}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                reel.step === item.step
                  ? 'bg-zinc-100 text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {aiNotice && (
        <div className="p-3.5 rounded-lg border border-amber-500/40 bg-amber-950/20 flex items-center justify-between gap-3 text-xs text-amber-200">
          <span>{aiNotice}</span>
          <button
            type="button"
            onClick={handleBuildManualStoryboard}
            className="px-3 py-1.5 rounded bg-amber-200 text-zinc-950 font-semibold shrink-0"
          >
            Build Storyboard Manually
          </button>
        </div>
      )}

      {/* STAGE 1: ASSETS, MODE & CONCEPT */}
      {reel.step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-5">
            {/* Creation Mode */}
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Video Creation Mode
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {CREATION_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => persistReel({ ...reel, creationMode: m.id })}
                    className={`p-3 rounded-lg border text-left transition-colors ${
                      reel.creationMode === m.id
                        ? 'bg-[#1a1a20] border-zinc-300'
                        : 'bg-[#09090b] border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    <div className="text-xs font-semibold text-zinc-100">{m.label}</div>
                    <div className="text-[11px] text-zinc-400 mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Concept, Script & Transcript */}
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Video Topic or Concept
                </label>
                <input
                  type="text"
                  value={reel.topic}
                  onChange={(e) => persistReel({ ...reel, topic: e.target.value })}
                  placeholder="e.g., 3 Studio Mixing Habits That Separate Amateur Demos From Label Masters"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Existing Script (Optional — Gemini will generate one if left blank)
                </label>
                <textarea
                  rows={4}
                  value={reel.script}
                  onChange={(e) => persistReel({ ...reel, script: e.target.value })}
                  placeholder="Paste script lines or beat notes..."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Transcript / Caption Lines (Optional, supports SRT or plain lines)
                </label>
                <textarea
                  rows={3}
                  value={reel.transcript}
                  onChange={(e) => persistReel({ ...reel, transcript: e.target.value })}
                  placeholder="Paste dialogue lines or .srt timing blocks..."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Right: Media Uploader & Editing Preset */}
          <div className="lg:col-span-5 space-y-5">
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Project Footage & Audio
                </h2>
                {uploadPct !== null && (
                  <span className="text-xs font-mono text-zinc-300">Uploading {uploadPct}%</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="p-3 rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 bg-[#09090b] text-xs text-zinc-200 flex items-center justify-center gap-2 cursor-pointer">
                  <Film className="w-4 h-4 text-zinc-400" />
                  <span>Video / Images</span>
                  <input
                    type="file"
                    accept="video/*,image/*"
                    multiple
                    onChange={(e) => handleUploadMediaFiles(e.target.files)}
                    className="hidden"
                  />
                </label>
                <label className="p-3 rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 bg-[#09090b] text-xs text-zinc-200 flex items-center justify-center gap-2 cursor-pointer">
                  <FileAudio className="w-4 h-4 text-zinc-400" />
                  <span>Music Track</span>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => handleUploadMediaFiles(e.target.files, 'audio')}
                    className="hidden"
                  />
                </label>
              </div>

              <label className="w-full p-2.5 rounded-lg border border-dashed border-zinc-800 hover:border-zinc-600 bg-[#09090b] text-xs text-zinc-300 flex items-center justify-center gap-2 cursor-pointer">
                <Mic className="w-3.5 h-3.5 text-zinc-400" />
                <span>Upload Voice Recording (Optional)</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => handleUploadMediaFiles(e.target.files, 'voice')}
                  className="hidden"
                />
              </label>

              {reel.assets.length > 0 && (
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {reel.assets.map((asset) => (
                    <div
                      key={asset.id}
                      className="p-2.5 rounded-md bg-[#09090b] border border-zinc-800 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-zinc-200 truncate">{asset.name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-mono text-[11px] text-zinc-500">
                            {asset.kind}
                            {asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              persistReel({
                                ...reel,
                                assets: reel.assets.filter((a) => a.id !== asset.id),
                              })
                            }
                            className="text-zinc-500 hover:text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={asset.description || ''}
                        onChange={(e) =>
                          persistReel({
                            ...reel,
                            assets: reel.assets.map((a) =>
                              a.id === asset.id ? { ...a, description: e.target.value } : a
                            ),
                          })
                        }
                        placeholder="Describe what happens in this clip for AI sequencing..."
                        className="w-full px-2 py-1 rounded bg-[#141418] border border-zinc-800/80 text-[11px] text-zinc-300"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Editing Preset
                </label>
                <select
                  value={reel.presetId}
                  onChange={(e) => {
                    const preset = editingPresets.find((p) => p.id === e.target.value) || editingPresets[0];
                    persistReel({
                      ...reel,
                      presetId: preset.id,
                      colorTreatment: preset.colorTreatment,
                      subtitleSettings: { ...reel.subtitleSettings, fontFamily: preset.fontFamily },
                    });
                  }}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {editingPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-zinc-500 mt-1">{activePreset.description}</p>
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-300 mb-1">
                  <span>Target Duration</span>
                  <span className="font-mono tabular-nums">{reel.targetDuration}s (max 60s)</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={60}
                  value={reel.targetDuration}
                  onChange={(e) => persistReel({ ...reel, targetDuration: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div className="pt-2 space-y-2">
                <button
                  type="button"
                  disabled={isGeneratingPlan}
                  onClick={handleGenerateEditingPlan}
                  className="w-full py-2.5 px-4 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {isGeneratingPlan ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Creating Editing Plan & Storyboard...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Generate Gemini Editing Plan</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleBuildManualStoryboard}
                  className="w-full py-2 px-4 rounded-md border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300"
                >
                  Assemble Storyboard Manually
                </button>
              </div>

              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Gemini generates an editing plan, script, and storyboard strictly from your supplied footage metadata and inputs—it never fabricates video clips.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* STAGE 2: STORYBOARD REVIEW & APPROVAL */}
      {reel.step === 2 && (
        <div className="space-y-5">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Opening Hook</label>
              <input
                type="text"
                value={reel.hookLine}
                onChange={(e) => persistReel({ ...reel, hookLine: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Closing CTA</label>
              <input
                type="text"
                value={reel.closingCta}
                onChange={(e) => persistReel({ ...reel, closingCta: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Editing & Music Direction</label>
              <input
                type="text"
                value={reel.editingNotes}
                onChange={(e) => persistReel({ ...reel, editingNotes: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
          </div>

          <div className="space-y-3">
            {reel.storyboard.length === 0 ? (
              <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-center space-y-3">
                <p className="text-xs text-zinc-400">No storyboard scenes yet.</p>
                <button
                  type="button"
                  onClick={handleBuildManualStoryboard}
                  className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
                >
                  Create Default Storyboard
                </button>
              </div>
            ) : (
              reel.storyboard.map((sc, idx) => (
                <div key={sc.id} className="p-4 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs font-semibold text-zinc-200">
                        SCENE {String(idx + 1).padStart(2, '0')}
                      </span>
                      <select
                        value={sc.recommendedAssetId}
                        onChange={(e) => {
                          const asset = reel.assets.find((a) => a.id === e.target.value);
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.map((item) =>
                              item.id === sc.id
                                ? {
                                    ...item,
                                    recommendedAssetId: e.target.value,
                                    recommendedAssetName: asset ? asset.name : 'Typography Card',
                                  }
                                : item
                            ),
                          });
                        }}
                        className="px-2.5 py-1 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                      >
                        <option value="typography-card">Typography Frame</option>
                        {reel.assets
                          .filter((a) => a.kind === 'video' || a.kind === 'image')
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.kind})
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-zinc-400">Duration (s)</label>
                      <input
                        type="number"
                        step="0.5"
                        min="1"
                        max="20"
                        value={sc.durationSeconds}
                        onChange={(e) =>
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.map((item) =>
                              item.id === sc.id
                                ? { ...item, durationSeconds: Number(e.target.value) || 2 }
                                : item
                            ),
                          })
                        }
                        className="w-16 px-2 py-1 rounded bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-100"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.filter((item) => item.id !== sc.id),
                          })
                        }
                        className="p-1.5 text-zinc-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-500 mb-1">Scene Description</label>
                      <input
                        type="text"
                        value={sc.sceneDescription}
                        onChange={(e) =>
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.map((item) =>
                              item.id === sc.id ? { ...item, sceneDescription: e.target.value } : item
                            ),
                          })
                        }
                        className="w-full px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-500 mb-1">Text Overlay</label>
                      <input
                        type="text"
                        value={sc.textOverlay}
                        onChange={(e) =>
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.map((item) =>
                              item.id === sc.id ? { ...item, textOverlay: e.target.value } : item
                            ),
                          })
                        }
                        className="w-full px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-500 mb-1">Subtitle Line</label>
                      <input
                        type="text"
                        value={sc.subtitleLine}
                        onChange={(e) =>
                          persistReel({
                            ...reel,
                            storyboard: reel.storyboard.map((item) =>
                              item.id === sc.id ? { ...item, subtitleLine: e.target.value } : item
                            ),
                          })
                        }
                        className="w-full px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={() =>
                persistReel({
                  ...reel,
                  storyboard: [
                    ...reel.storyboard,
                    {
                      id: createId('sc'),
                      sceneNumber: reel.storyboard.length + 1,
                      recommendedAssetId: 'typography-card',
                      recommendedAssetName: 'Typography Frame',
                      durationSeconds: 3,
                      sceneDescription: 'Additional scene',
                      textOverlay: '',
                      lowerThird: '',
                      subtitleLine: '',
                      transitionStyle: activePreset.transitionStyle,
                      motionPreset: activePreset.motionStyle,
                      visualEmphasis: '',
                    },
                  ],
                })
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Scene</span>
            </button>

            <button
              type="button"
              onClick={handleApproveStoryboardAndAssemble}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Approve Storyboard & Assemble Timeline</span>
            </button>
          </div>
        </div>
      )}

      {/* STAGE 3: MULTI-TRACK BROWSER VIDEO EDITOR */}
      {reel.step === 3 && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            {/* Vertical 9:16 Preview Player */}
            <div className="xl:col-span-4 rounded-xl bg-[#111114] border border-zinc-800 p-4 flex flex-col items-center space-y-3">
              <div className="w-full flex items-center justify-between text-xs text-zinc-400">
                <span>9:16 Vertical Preview</span>
                <span className="font-mono tabular-nums text-zinc-200">
                  {formatTimecode(playhead)} / {formatTimecode(totalDuration)}
                </span>
              </div>

              <canvas
                ref={previewCanvasRef}
                width={360}
                height={640}
                className="w-full max-w-[290px] aspect-[9/16] rounded-lg border border-zinc-800 bg-black"
              />

              <div className="w-full space-y-2">
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.5, totalDuration)}
                  step={0.05}
                  value={playhead}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setPlayhead(Number(e.target.value));
                  }}
                  className="w-full"
                />
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setIsPlaying((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    <span>{isPlaying ? 'Pause' : 'Play Preview'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => persistReel({ ...reel, step: 4 })}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-100"
                  >
                    <span>Proceed to Export</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Inspector Tabs (Clip, Audio, Subtitles, Style & Motion) */}
            <div className="xl:col-span-8 space-y-4">
              <div className="rounded-xl bg-[#111114] border border-zinc-800 p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                  <div className="inline-flex p-1 rounded-md bg-[#09090b] border border-zinc-800">
                    {(
                      [
                        ['clip', 'Clip & Motion'],
                        ['audio', 'Audio Mix'],
                        ['subtitles', 'Subtitles'],
                        ['style', 'Presets & Branding'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setEditorTab(id)}
                        className={`px-3 py-1 rounded text-xs font-medium ${
                          editorTab === id
                            ? 'bg-zinc-800 text-zinc-100 font-semibold'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {selectedClip && editorTab === 'clip' && (
                    <button
                      type="button"
                      onClick={splitSelectedClip}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
                    >
                      <Scissors className="w-3.5 h-3.5" />
                      <span>Split Selected Clip</span>
                    </button>
                  )}
                </div>

                {editorTab === 'clip' && selectedClip && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Source Asset</label>
                        <select
                          value={selectedClip.assetId}
                          onChange={(e) => {
                            const asset = reel.assets.find((a) => a.id === e.target.value);
                            updateClip(selectedClip.id, {
                              assetId: e.target.value,
                              assetName: asset ? asset.name : 'Typography Frame',
                              kind: asset ? (asset.kind === 'video' ? 'video' : 'image') : 'typography-card',
                            });
                          }}
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="typography-card">Typography Frame</option>
                          {reel.assets
                            .filter((a) => a.kind === 'video' || a.kind === 'image')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Duration (sec)
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min="0.5"
                          max="30"
                          value={selectedClip.duration}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              duration: Math.max(0.5, Number(e.target.value) || 1),
                            })
                          }
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Transition</label>
                        <select
                          value={selectedClip.transition}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              transition: e.target.value as EditingPreset['transitionStyle'],
                            })
                          }
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="cut">Hard Cut</option>
                          <option value="crossfade">Crossfade</option>
                          <option value="slide-up">Slide Up</option>
                          <option value="zoom-punch">Zoom Punch</option>
                          <option value="flash-silver">Silver Flash</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Kinetic Text Overlay
                        </label>
                        <input
                          type="text"
                          value={selectedClip.textOverlay}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { textOverlay: e.target.value })
                          }
                          placeholder="On-screen animated heading"
                          className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Lower Third Caption
                        </label>
                        <input
                          type="text"
                          value={selectedClip.lowerThird}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { lowerThird: e.target.value })
                          }
                          placeholder="e.g., 74 STUDIO · Mixing Notes"
                          className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Trim Start ({selectedClip.trimStart}s)
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={20}
                          step={0.5}
                          value={selectedClip.trimStart}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { trimStart: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Crop Pan X ({selectedClip.cropX}%)
                        </label>
                        <input
                          type="range"
                          min={-40}
                          max={40}
                          value={selectedClip.cropX}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { cropX: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Zoom ({selectedClip.zoom.toFixed(2)}×)
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={1.6}
                          step={0.05}
                          value={selectedClip.zoom}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { zoom: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {editorTab === 'audio' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Music Track</label>
                        <select
                          value={reel.audioTrackAssetId || ''}
                          onChange={(e) =>
                            persistReel({ ...reel, audioTrackAssetId: e.target.value || undefined })
                          }
                          className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="">No music track</option>
                          {reel.assets
                            .filter((a) => a.kind === 'audio')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Voice Recording</label>
                        <select
                          value={reel.voiceTrackAssetId || ''}
                          onChange={(e) =>
                            persistReel({ ...reel, voiceTrackAssetId: e.target.value || undefined })
                          }
                          className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="">No voice track</option>
                          {reel.assets
                            .filter((a) => a.kind === 'voice' || a.kind === 'audio')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Music Vol ({Math.round(reel.musicVolume * 100)}%)
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={reel.musicVolume}
                          onChange={(e) =>
                            persistReel({ ...reel, musicVolume: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Voice Vol ({Math.round(reel.voiceVolume * 100)}%)
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={reel.voiceVolume}
                          onChange={(e) =>
                            persistReel({ ...reel, voiceVolume: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Fade In ({reel.audioFadeIn}s)
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={3}
                          step={0.25}
                          value={reel.audioFadeIn}
                          onChange={(e) =>
                            persistReel({ ...reel, audioFadeIn: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Fade Out ({reel.audioFadeOut}s)
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={3}
                          step={0.25}
                          value={reel.audioFadeOut}
                          onChange={(e) =>
                            persistReel({ ...reel, audioFadeOut: Number(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {editorTab === 'subtitles' && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 cursor-pointer">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Import SRT / TXT</span>
                        <input
                          type="file"
                          accept=".srt,.txt"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const txt = await f.text();
                            const parsed = parseSrtOrTranscript(txt, Math.max(5, totalDuration));
                            persistReel({ ...reel, transcript: txt, subtitles: parsed });
                            notify('success', `${parsed.length} subtitle segments imported`);
                          }}
                          className="hidden"
                        />
                      </label>

                      <button
                        type="button"
                        disabled={isTranscribing}
                        onClick={handleTranscribeAudioAsset}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-100"
                      >
                        {isTranscribing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        <span>Transcribe Uploaded Audio</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const start =
                            reel.subtitles.length > 0
                              ? reel.subtitles[reel.subtitles.length - 1].endTime
                              : 0;
                          persistReel({
                            ...reel,
                            subtitles: [
                              ...reel.subtitles,
                              {
                                id: createId('sub'),
                                startTime: start,
                                endTime: Number((start + 2.5).toFixed(1)),
                                text: 'Enter subtitle caption text',
                                highlightWord: 'caption',
                              },
                            ],
                          });
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Segment</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Font</label>
                        <select
                          value={reel.subtitleSettings.fontFamily}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              subtitleSettings: {
                                ...reel.subtitleSettings,
                                fontFamily: e.target.value as ReelState['subtitleSettings']['fontFamily'],
                              },
                            })
                          }
                          className="w-full px-2 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                          <option value="Oswald">Oswald</option>
                          <option value="Cormorant Garamond">Cormorant Garamond</option>
                          <option value="Manrope">Manrope</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Position</label>
                        <select
                          value={reel.subtitleSettings.position}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              subtitleSettings: {
                                ...reel.subtitleSettings,
                                position: e.target.value as 'bottom' | 'center' | 'top',
                              },
                            })
                          }
                          className="w-full px-2 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="bottom">Bottom</option>
                          <option value="center">Center</option>
                          <option value="top">Top</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Caption Style</label>
                        <select
                          value={reel.subtitleSettings.animationPreset}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              subtitleSettings: {
                                ...reel.subtitleSettings,
                                animationPreset: e.target.value as ReelState['subtitleSettings']['animationPreset'],
                              },
                            })
                          }
                          className="w-full px-2 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="word-highlight">Word Highlight</option>
                          <option value="bold-box">Bold Box</option>
                          <option value="fade-up">Fade Up</option>
                          <option value="minimal-clean">Minimal Clean</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Size ({reel.subtitleSettings.fontSize}px)
                        </label>
                        <input
                          type="range"
                          min={32}
                          max={72}
                          value={reel.subtitleSettings.fontSize}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              subtitleSettings: {
                                ...reel.subtitleSettings,
                                fontSize: Number(e.target.value),
                              },
                            })
                          }
                          className="w-full"
                        />
                      </div>
                    </div>

                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {reel.subtitles.map((sub) => (
                        <div
                          key={sub.id}
                          className="p-2.5 rounded bg-[#09090b] border border-zinc-800 grid grid-cols-12 gap-2 items-center"
                        >
                          <input
                            type="number"
                            step="0.1"
                            value={sub.startTime}
                            onChange={(e) =>
                              persistReel({
                                ...reel,
                                subtitles: reel.subtitles.map((s) =>
                                  s.id === sub.id ? { ...s, startTime: Number(e.target.value) } : s
                                ),
                              })
                            }
                            className="col-span-2 px-2 py-1 rounded bg-[#141418] border border-zinc-800 text-[11px] font-mono text-zinc-200"
                          />
                          <input
                            type="number"
                            step="0.1"
                            value={sub.endTime}
                            onChange={(e) =>
                              persistReel({
                                ...reel,
                                subtitles: reel.subtitles.map((s) =>
                                  s.id === sub.id ? { ...s, endTime: Number(e.target.value) } : s
                                ),
                              })
                            }
                            className="col-span-2 px-2 py-1 rounded bg-[#141418] border border-zinc-800 text-[11px] font-mono text-zinc-200"
                          />
                          <input
                            type="text"
                            value={sub.text}
                            onChange={(e) =>
                              persistReel({
                                ...reel,
                                subtitles: reel.subtitles.map((s) =>
                                  s.id === sub.id ? { ...s, text: e.target.value } : s
                                ),
                              })
                            }
                            className="col-span-5 px-2 py-1 rounded bg-[#141418] border border-zinc-800 text-xs text-zinc-100"
                          />
                          <input
                            type="text"
                            value={sub.highlightWord}
                            placeholder="Highlight"
                            onChange={(e) =>
                              persistReel({
                                ...reel,
                                subtitles: reel.subtitles.map((s) =>
                                  s.id === sub.id ? { ...s, highlightWord: e.target.value } : s
                                ),
                              })
                            }
                            className="col-span-2 px-2 py-1 rounded bg-[#141418] border border-zinc-800 text-[11px] text-amber-300"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              persistReel({
                                ...reel,
                                subtitles: reel.subtitles.filter((s) => s.id !== sub.id),
                              })
                            }
                            className="col-span-1 text-zinc-500 hover:text-red-400 flex justify-center"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {editorTab === 'style' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Color Treatment</label>
                        <select
                          value={reel.colorTreatment}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              colorTreatment: e.target.value as EditingPreset['colorTreatment'],
                            })
                          }
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="obsidian-silver">Obsidian Silver</option>
                          <option value="warm-analog">Warm Analog</option>
                          <option value="high-contrast-mono">High-Contrast Mono</option>
                          <option value="cinematic-teal">Cinematic Teal</option>
                          <option value="clean-editorial">Clean Editorial</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Intro Template</label>
                        <select
                          value={reel.introTemplate}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              introTemplate: e.target.value as ReelState['introTemplate'],
                            })
                          }
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="minimal-title">Minimal Brand Slate</option>
                          <option value="studio-slate">Studio Border Slate</option>
                          <option value="none">None</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">Outro Template</label>
                        <select
                          value={reel.outroTemplate}
                          onChange={(e) =>
                            persistReel({
                              ...reel,
                              outroTemplate: e.target.value as ReelState['outroTemplate'],
                            })
                          }
                          className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                        >
                          <option value="brand-cta">Brand Outro Card</option>
                          <option value="follow-endcard">Follow Endcard</option>
                          <option value="none">None</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-5 pt-1">
                      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={reel.showBrandLogo}
                          onChange={(e) =>
                            persistReel({ ...reel, showBrandLogo: e.target.checked })
                          }
                        />
                        <span>Brand Watermark Overlay</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={reel.showProgressBar}
                          onChange={(e) =>
                            persistReel({ ...reel, showProgressBar: e.target.checked })
                          }
                        />
                        <span>Top Progress Bar</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          saveEditingPreset({
                            ...activePreset,
                            colorTreatment: reel.colorTreatment,
                            fontFamily: reel.subtitleSettings.fontFamily,
                          });
                          notify('success', `Saved changes to preset "${activePreset.name}"`);
                        }}
                        className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
                      >
                        Save Preset Adjustments
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Multi-Track Timeline Strip */}
              <div className="rounded-xl bg-[#111114] border border-zinc-800 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-zinc-200">
                    Timeline Sequence ({reel.timelineClips.length} clips ·{' '}
                    <span className="font-mono tabular-nums">{totalDuration.toFixed(1)}s</span>)
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => addClipFromAsset()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-100"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Typography Clip</span>
                    </button>
                    {reel.assets
                      .filter((a) => a.kind === 'video' || a.kind === 'image')
                      .slice(0, 2)
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => addClipFromAsset(a)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 hover:border-zinc-500 text-[11px] text-zinc-300 max-w-[140px] truncate"
                        >
                          <Plus className="w-3 h-3 shrink-0" />
                          <span className="truncate">{a.name}</span>
                        </button>
                      ))}
                  </div>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-2">
                  {reel.timelineClips.map((clip, idx) => {
                    const active = clip.id === selectedClip?.id;
                    return (
                      <div
                        key={clip.id}
                        onClick={() => setSelectedClipId(clip.id)}
                        className={`min-w-[160px] p-2.5 rounded-lg border cursor-pointer shrink-0 transition-colors ${
                          active
                            ? 'bg-[#1b1b22] border-zinc-200'
                            : 'bg-[#09090b] border-zinc-800 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
                          <span className="font-mono">
                            #{idx + 1} · {clip.duration.toFixed(1)}s
                          </span>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => moveClip(idx, -1)}
                              disabled={idx === 0}
                              className="p-0.5 hover:text-zinc-100 disabled:opacity-30"
                            >
                              <ArrowLeft className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveClip(idx, 1)}
                              disabled={idx === reel.timelineClips.length - 1}
                              className="p-0.5 hover:text-zinc-100 disabled:opacity-30"
                            >
                              <ArrowRight className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteClip(clip.id)}
                              disabled={reel.timelineClips.length <= 1}
                              className="p-0.5 hover:text-red-400 disabled:opacity-30"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <div className="text-xs font-semibold text-zinc-100 truncate">
                          {clip.assetName}
                        </div>
                        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                          {clip.textOverlay || clip.transition}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STAGE 4: EXPORT & PUBLISH */}
      {reel.step === 4 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-6 p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Export Settings &amp; Platform Validation</h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                9:16 vertical · 30 FPS CFR · Verified H.264 (yuv420p) + AAC 44.1kHz Stereo +faststart MP4.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  { id: 'instagram-reels', label: 'Instagram Reels', note: '9:16 · ≤60s · Silent-caption check' },
                  { id: 'youtube-shorts', label: 'YouTube Shorts', note: '9:16 · <60.0s strict · Hook check' },
                ] as const
              ).map((prof) => (
                <button
                  key={prof.id}
                  type="button"
                  onClick={() => persistReel({ ...reel, destinationProfile: prof.id })}
                  className={`p-3.5 rounded-lg border text-left transition-colors ${
                    reel.destinationProfile === prof.id
                      ? 'bg-[#1a1a20] border-zinc-200'
                      : 'bg-[#09090b] border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <div className="text-xs font-semibold text-zinc-100">{prof.label}</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">{prof.note}</div>
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-2">Output Resolution</label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setExportRes('1080x1920')}
                  className={`py-2 rounded-md border text-xs font-mono ${
                    exportRes === '1080x1920'
                      ? 'bg-zinc-100 text-zinc-950 border-zinc-100 font-semibold'
                      : 'bg-[#09090b] text-zinc-300 border-zinc-800'
                  }`}
                >
                  1080×1920 (Full HD)
                </button>
                <button
                  type="button"
                  onClick={() => setExportRes('720x1280')}
                  className={`py-2 rounded-md border text-xs font-mono ${
                    exportRes === '720x1280'
                      ? 'bg-zinc-100 text-zinc-950 border-zinc-100 font-semibold'
                      : 'bg-[#09090b] text-zinc-300 border-zinc-800'
                  }`}
                >
                  720×1280 (Fast Device)
                </button>
              </div>
            </div>

            {/* Validation feedback */}
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Timeline Duration</span>
                <span className="font-mono tabular-nums text-zinc-100">
                  {validation.totalDuration.toFixed(1)}s / 60.0s
                </span>
              </div>
              {validation.errors.map((err, i) => (
                <div key={i} className="text-red-400 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{err}</span>
                </div>
              ))}
              {validation.warnings.map((w, i) => (
                <div key={i} className="text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
              {validation.valid && validation.warnings.length === 0 && (
                <div className="text-emerald-400 flex items-center gap-2">
                  <Check className="w-3.5 h-3.5" />
                  <span>All {reel.destinationProfile} requirements validated.</span>
                </div>
              )}
            </div>

            {renderError && (
              <div className="p-3.5 rounded-lg border border-red-500/40 bg-red-950/20 text-xs text-red-200">
                <div className="font-semibold">Render Failed (Project State Preserved)</div>
                <div className="mt-0.5">{renderError}</div>
              </div>
            )}

            {isRendering ? (
              <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-200">{renderStage}</span>
                  <span className="font-mono tabular-nums text-zinc-400">{renderPct}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-zinc-100 transition-all"
                    style={{ width: `${renderPct}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Cancel Render
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!validation.valid}
                onClick={handleRenderExport}
                className="w-full py-3 px-4 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-50 text-xs font-semibold flex items-center justify-center gap-2"
              >
                <Clapperboard className="w-4 h-4" />
                <span>Render & Export Video</span>
              </button>
            )}
          </div>

          {/* Right: Exported Video Preview & Post Composer Handoff */}
          <div className="lg:col-span-6 p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-100">Final Exported Preview</h2>

            {exportedOutput && exportedPreviewUrl ? (
              <div className="space-y-4">
                <div className="flex justify-center bg-[#09090b] rounded-lg border border-zinc-800 p-4">
                  <video
                    src={exportedPreviewUrl}
                    controls
                    className="max-h-[420px] rounded border border-zinc-800"
                  />
                </div>

                <div className="text-xs text-zinc-400 font-mono tabular-nums flex flex-wrap gap-2.5">
                  <span>{exportedOutput.width}×{exportedOutput.height}</span>
                  <span>·</span>
                  <span>{exportedOutput.fps} FPS CFR</span>
                  <span>·</span>
                  <span>{exportedOutput.duration.toFixed(1)}s</span>
                  <span>·</span>
                  <span>
                    {exportedOutput.verification.videoCodec.toUpperCase()}/{exportedOutput.verification.audioCodec.toUpperCase()}
                    {exportedOutput.verification.faststart ? ' · faststart OK' : ''}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      triggerBlobDownload(
                        exportedOutput.blob,
                        `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${exportedOutput.extension}`
                      )
                    }
                    className="px-3.5 py-2.5 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download {exportedOutput.extension.toUpperCase()}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveVideoToLibrary}
                    className="px-3.5 py-2.5 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Save to Media Library</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleOpenComposerWithReel('instagram-reel')}
                    className="px-3.5 py-2.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Create Instagram Reel Post</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenComposerWithReel('youtube-shorts')}
                    className="px-3.5 py-2.5 rounded-md bg-zinc-800 text-zinc-100 hover:bg-zinc-700 text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Create YouTube Shorts Post</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowCalModal(true)}
                  className="w-full py-2 px-3 rounded-md border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center justify-center gap-1.5"
                >
                  <CalendarPlus className="w-3.5 h-3.5" />
                  <span>Add to Content Calendar</span>
                </button>
              </div>
            ) : (
              <div className="py-16 text-center space-y-2 border border-dashed border-zinc-800 rounded-lg">
                <ImageIcon className="w-6 h-6 text-zinc-600 mx-auto" />
                <p className="text-xs text-zinc-400">
                  Render your timeline to inspect the final vertical video and unlock publishing actions.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {showCalModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-[#111114] border border-zinc-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Schedule Reel to Calendar</h3>
              <button
                type="button"
                onClick={() => setShowCalModal(false)}
                className="text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Date</label>
                <input
                  type="date"
                  value={calDate}
                  onChange={(e) => setCalDate(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Time</label>
                <input
                  type="time"
                  value={calTime}
                  onChange={(e) => setCalTime(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCalModal(false)}
                className="px-3.5 py-2 rounded border border-zinc-800 text-xs text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleScheduleReelToCalendar}
                className="px-4 py-2 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
              >
                Schedule Video
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
