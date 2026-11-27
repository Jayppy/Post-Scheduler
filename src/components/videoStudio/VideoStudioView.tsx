import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player } from '@remotion/player';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Film,
  FolderPlus,
  ImagePlus,
  Layers,
  Loader2,
  Music,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { videoStudioClient } from '../../services/videoStudioClient';
import { triggerBlobDownload } from '../../services/carouselRenderer';
import { blobToBase64, putMediaBlob } from '../../services/idb';
import { createId } from '../../services/storage';
import type { ExportRecord, MediaAsset } from '../../types/studio';
import type {
  CartoonBackgroundPreset,
  CartoonCharacterId,
  CartoonPropId,
  MotionChartType,
  SceneTransitionType,
  StickmanAccessory,
  StickmanExpression,
  StickmanHeadShape,
  VideoGenerationProviderStatus,
  VideoProject,
  VideoRenderRecord,
  VideoScene,
  VideoStyle,
  VideoWorkflowStage,
} from '../../types/videoStudio';
import { ALL_STICKMAN_ACTIONS } from './StickmanSvg';
import { BehindTheReleaseVideoComposition } from './RemotionComposition';
import {
  computeProjectDurationFrames,
  renderVideoProjectToFile,
  transcodeToVerifiedMp4,
  type RawRenderBackup,
  type VideoExportResolution,
} from './videoRenderer';

const WORKFLOW_STAGES: Array<{ id: VideoWorkflowStage; label: string }> = [
  { id: 'script', label: '1. Script' },
  { id: 'storyboard', label: '2. Storyboard' },
  { id: 'assets', label: '3. Visual & Audio Assets' },
  { id: 'preview', label: '4. Preview & Approval' },
  { id: 'export', label: '5. Export' },
];

const VIDEO_STYLES: Array<{ id: VideoStyle; label: string; desc: string }> = [
  {
    id: 'hybrid',
    label: 'Hybrid Mix (Recommended)',
    desc: 'Combines Stickman characters, 2D studio environments, and kinetic charts',
  },
  {
    id: 'stickman',
    label: 'Stickman Animation',
    desc: '18-action animated presenter stickman with props & kinetic captions',
  },
  {
    id: 'cartoon-2d',
    label: '2D Cartoon Studio',
    desc: 'Layered 2D music studio scenes, vector characters & animated props',
  },
  {
    id: 'motion-graphics',
    label: 'Motion Graphics & Kinetic Type',
    desc: 'Editorial typography, timelines, comparisons & animated charts',
  },
];

const ACCESSORIES_LIST: StickmanAccessory[] = [
  'headphones',
  'cap',
  'glasses',
  'chain',
  'hoodie',
];

const PROPS_LIST: CartoonPropId[] = [
  'condenser-mic',
  'studio-monitors',
  'laptop-daw',
  'vinyl-record',
  'waveform',
  'stream-counter',
  'phone-ui',
  'cash-stack',
];

export const VideoStudioView: React.FC = () => {
  const {
    activeWorkspace,
    activeVideoProjectId,
    setActiveVideoProjectId,
    addMediaAsset,
    addExportRecord,
    openPostComposerWithDraft,
    notify,
  } = useStudio();

  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [providers, setProviders] = useState<VideoGenerationProviderStatus[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [styleFilter, setStyleFilter] = useState<VideoStyle | 'all'>('all');
  const [confirmDeleteProj, setConfirmDeleteProj] = useState<VideoProject | null>(null);

  // New Video Creator Form
  const [showCreator, setShowCreator] = useState(false);
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('Independent recording artists and producers');
  const [style, setStyle] = useState<VideoStyle>('hybrid');
  const [targetDuration, setTargetDuration] = useState(75);
  const [destination, setDestination] = useState<VideoProject['destination']>('both');
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);

  // Active editor state + Undo history
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<VideoProject[]>([]);
  const [saving, setSaving] = useState(false);
  const [regenInstruction, setRegenInstruction] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);

  // Render & Export state
  const [exportResolution, setExportResolution] = useState<VideoExportResolution>('1080x1920');
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatusLabel, setRenderStatusLabel] = useState('');
  const [lastRenderedBlob, setLastRenderedBlob] = useState<{
    blob: Blob;
    format: 'mp4' | 'webm';
    durationSeconds: number;
    renderId?: string;
    engine?: 'remotion-web' | 'canvas-ffmpeg-fallback';
  } | null>(null);
  const [pendingRawRender, setPendingRawRender] = useState<
    (RawRenderBackup & { blobKey: string; resolution: VideoExportResolution }) | null
  >(null);
  const [mp4ConversionError, setMp4ConversionError] = useState<string | null>(null);
  const [cloudUploadError, setCloudUploadError] = useState<string | null>(null);
  const [cloudBackupSaved, setCloudBackupSaved] = useState(false);
  const [uploadingCloud, setUploadingCloud] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [projList, provList] = await Promise.all([
        videoStudioClient.listProjects(),
        videoStudioClient.listProviders(),
      ]);
      setProjects(projList);
      setProviders(provList);
    } catch (err) {
      notify('error', 'Failed to load Video Studio', err instanceof Error ? err.message : '');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeVideoProjectId) || null,
    [projects, activeVideoProjectId]
  );

  useEffect(() => {
    if (activeProject && (!selectedSceneId || !activeProject.scenes.some((s) => s.id === selectedSceneId))) {
      setSelectedSceneId(activeProject.scenes[0]?.id || null);
    }
  }, [activeProject, selectedSceneId]);

  const activeScene = useMemo(
    () =>
      activeProject?.scenes.find((s) => s.id === selectedSceneId) ||
      activeProject?.scenes[0] ||
      null,
    [activeProject, selectedSceneId]
  );

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return projects.filter((p) => {
      if (styleFilter !== 'all' && p.primaryStyle !== styleFilter) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.topic.toLowerCase().includes(q)
      );
    });
  }, [projects, searchQuery, styleFilter]);

  const mutateProjectWithUndo = (updater: (prev: VideoProject) => VideoProject) => {
    if (!activeProject) return;
    setUndoStack((stack) => [...stack.slice(-14), activeProject]);
    const next = updater(activeProject);
    setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  };

  const handleUndo = () => {
    if (undoStack.length === 0 || !activeProject) return;
    const prevSnapshot = undoStack[undoStack.length - 1];
    setUndoStack((stack) => stack.slice(0, -1));
    setProjects((prev) => prev.map((p) => (p.id === prevSnapshot.id ? prevSnapshot : p)));
  };

  const handleGenerateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || generating) return;
    setGenerating(true);
    try {
      const result = await videoStudioClient.generateScript({
        topic: topic.trim(),
        audience,
        style,
        targetDurationSeconds: targetDuration,
        destination,
        notes: notes.trim() || undefined,
      });
      setProjects((prev) => [result.project, ...prev]);
      setActiveVideoProjectId(result.project.id);
      setSelectedSceneId(result.project.scenes[0]?.id || null);
      setShowCreator(false);
      setTopic('');
      setNotes('');
      notify(
        result.usedFallbackTemplate ? 'info' : 'success',
        'Educational Video Blueprint Created',
        `${result.project.scenes.length} scenes (${result.project.targetDurationSeconds}s) ready for review.`
      );
    } catch (err) {
      notify('error', 'Script generation failed', err instanceof Error ? err.message : '');
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveProject = async (projectToSave: VideoProject = activeProject!) => {
    if (!projectToSave) return;
    setSaving(true);
    try {
      const saved = await videoStudioClient.updateProject(projectToSave.id, projectToSave);
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      notify('success', 'Video project saved');
    } catch (err) {
      notify('error', 'Save failed', err instanceof Error ? err.message : '');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicateProject = async (proj: VideoProject) => {
    const copy: VideoProject = {
      ...JSON.parse(JSON.stringify(proj)),
      id: `vid_${Date.now().toString(36)}`,
      title: `${proj.title} (Copy)`,
      approvedForRender: false,
      status: 'draft',
      renders: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const saved = await videoStudioClient.createOrSaveProject(copy);
      setProjects((prev) => [saved, ...prev]);
      notify('success', 'Project duplicated');
    } catch (err) {
      notify('error', 'Duplicate failed', err instanceof Error ? err.message : '');
    }
  };

  const handleDeleteProject = async () => {
    if (!confirmDeleteProj) return;
    try {
      await videoStudioClient.deleteProject(confirmDeleteProj.id);
      setProjects((prev) => prev.filter((p) => p.id !== confirmDeleteProj.id));
      if (activeVideoProjectId === confirmDeleteProj.id) {
        setActiveVideoProjectId(null);
      }
      setConfirmDeleteProj(null);
      notify('info', 'Video project deleted');
    } catch (err) {
      notify('error', 'Delete failed', err instanceof Error ? err.message : '');
    }
  };

  const updateActiveScene = (patch: Partial<VideoScene>) => {
    if (!activeScene) return;
    mutateProjectWithUndo((proj) => ({
      ...proj,
      scenes: proj.scenes.map((s) => (s.id === activeScene.id ? { ...s, ...patch } : s)),
    }));
  };

  const handleMoveScene = (idx: number, dir: -1 | 1) => {
    if (!activeProject) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= activeProject.scenes.length) return;
    mutateProjectWithUndo((proj) => {
      const arr = [...proj.scenes];
      const [moved] = arr.splice(idx, 1);
      arr.splice(targetIdx, 0, moved);
      return { ...proj, scenes: arr.map((s, i) => ({ ...s, orderIndex: i })) };
    });
  };

  const handleRegenerateScene = async () => {
    if (!activeProject || !activeScene || regenLoading) return;
    setRegenLoading(true);
    try {
      const res = await videoStudioClient.regenerateScene({
        topic: activeProject.topic,
        scene: activeScene,
        instruction: regenInstruction.trim() || undefined,
      });
      mutateProjectWithUndo((proj) => ({
        ...proj,
        scenes: proj.scenes.map((s) => (s.id === activeScene.id ? res.scene : s)),
      }));
      setRegenInstruction('');
      notify('success', 'Scene refreshed');
    } catch (err) {
      notify('error', 'Scene regeneration failed', err instanceof Error ? err.message : '');
    } finally {
      setRegenLoading(false);
    }
  };

  const handleAudioUpload = (kind: 'narration' | 'bgm', file?: File | null) => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      notify('warning', 'Audio file too large', 'Use audio under 12MB for browser Remotion mixing.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        mutateProjectWithUndo((proj) => ({
          ...proj,
          audio:
            kind === 'narration'
              ? { ...proj.audio, narrationName: file.name, narrationDataUrl: reader.result as string }
              : { ...proj.audio, bgmName: file.name, bgmDataUrl: reader.result as string },
        }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSceneImageUpload = (file?: File | null) => {
    if (!file || !activeScene) return;
    if (file.size > 4 * 1024 * 1024) {
      notify('warning', 'Image too large', 'Please select an image under 4MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        updateActiveScene({
          customOverlayAssetUrl: reader.result,
          cartoon: { ...activeScene.cartoon, customImageUrl: reader.result },
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const finalizeVerifiedMp4Export = async (opts: {
    mp4Blob: Blob;
    durationSeconds: number;
    engine: 'remotion-web' | 'canvas-ffmpeg-fallback';
    resolution: VideoExportResolution;
    signal?: AbortSignal;
  }) => {
    if (!activeProject) return;
    const renderId = `rnd_${Date.now().toString(36)}`;

    // Save locally into IndexedDB first as durable fallback
    const localBlobKey = createId('video_blob');
    await putMediaBlob(localBlobKey, opts.mp4Blob).catch(() => {});

    setLastRenderedBlob({
      blob: opts.mp4Blob,
      format: 'mp4',
      durationSeconds: opts.durationSeconds,
      renderId,
      engine: opts.engine,
    });
    setPendingRawRender(null);
    setMp4ConversionError(null);

    const renderRecord: VideoRenderRecord = {
      id: renderId,
      projectId: activeProject.id,
      status: 'completed',
      format: 'mp4',
      resolution: opts.resolution,
      fps: 30,
      durationSeconds: opts.durationSeconds,
      engine: opts.engine,
      progress: 100,
      createdAt: new Date().toISOString(),
    };

    // Attempt chunked cloud upload
    let storagePath: string | undefined;
    let storageBucket: string | undefined;
    let uploadErrMessage: string | null = null;
    try {
      setUploadingCloud(true);
      const uploadRes = await videoStudioClient.uploadRenderedVideoWithProgress(
        activeProject.id,
        renderId,
        opts.mp4Blob,
        'video/mp4',
        (pct, label) => {
          setRenderProgress(pct);
          setRenderStatusLabel(label);
        },
        opts.signal
      );
      storagePath = uploadRes.storagePath;
      storageBucket = uploadRes.storageBucket;
      setCloudBackupSaved(true);
    } catch (uploadErr) {
      uploadErrMessage = uploadErr instanceof Error ? uploadErr.message : 'Cloud backup failed';
      setCloudUploadError(uploadErrMessage);
      console.warn('Cloud video backup warning (saved locally):', uploadErrMessage);
    } finally {
      setUploadingCloud(false);
    }

    if (storagePath) {
      renderRecord.storagePath = storagePath;
      renderRecord.storageBucket = storageBucket;
    }

    const saved = await videoStudioClient.saveRenderCheckpoint(activeProject.id, {
      render: renderRecord,
    });
    setProjects((prev) => prev.map((p) => (p.id === saved.project.id ? saved.project : p)));
    notify(
      storagePath ? 'success' : 'info',
      storagePath ? 'Verified MP4 Rendered & Backed Up' : 'Verified MP4 Rendered Locally',
      storagePath
        ? `${opts.resolution} MP4 (${opts.durationSeconds}s) successfully backed up to Supabase storage.`
        : `${opts.resolution} MP4 (${opts.durationSeconds}s) saved locally. Cloud backup skipped/failed (${uploadErrMessage || 'Offline/Bucket limit'}).`
    );
  };

  const handleRenderExport = async () => {
    if (!activeProject || !activeProject.approvedForRender || rendering) return;
    setRendering(true);
    setRenderProgress(2);
    setRenderStatusLabel('Initializing render…');
    setCloudUploadError(null);
    setCloudBackupSaved(false);
    setMp4ConversionError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await renderVideoProjectToFile({
        project: activeProject,
        resolution: exportResolution,
        fps: 30,
        signal: controller.signal,
        onRawRenderBackup: async (raw) => {
          const rawKey = createId('raw_render');
          await putMediaBlob(rawKey, raw.blob).catch(() => {});
          setPendingRawRender({
            ...raw,
            blobKey: rawKey,
            resolution: exportResolution,
          });
        },
        onProgress: (pct, label) => {
          setRenderProgress(pct);
          setRenderStatusLabel(label);
        },
      });

      await finalizeVerifiedMp4Export({
        mp4Blob: result.blob,
        durationSeconds: result.durationSeconds,
        engine: result.engine,
        resolution: exportResolution,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Render interrupted';
      if (!controller.signal.aborted && msg.toLowerCase().includes('mp4')) {
        setMp4ConversionError(msg);
      }
      notify(controller.signal.aborted ? 'info' : 'error', controller.signal.aborted ? 'Render cancelled' : 'Render / MP4 conversion failed', msg);
    } finally {
      setRendering(false);
      abortControllerRef.current = null;
    }
  };

  const handleRetryMp4Conversion = async () => {
    if (!activeProject || !pendingRawRender || rendering) return;
    setRendering(true);
    setRenderProgress(88);
    setRenderStatusLabel('Retrying H.264/AAC MP4 conversion from preserved render…');
    setMp4ConversionError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const mp4Blob = await transcodeToVerifiedMp4({
        rawBlob: pendingRawRender.blob,
        width: pendingRawRender.width,
        height: pendingRawRender.height,
        fps: pendingRawRender.fps,
        durationSeconds: pendingRawRender.durationSeconds,
        signal: controller.signal,
        onProgress: (pct, label) => {
          setRenderProgress(pct);
          setRenderStatusLabel(label);
        },
      });
      await finalizeVerifiedMp4Export({
        mp4Blob,
        durationSeconds: pendingRawRender.durationSeconds,
        engine: 'canvas-ffmpeg-fallback',
        resolution: pendingRawRender.resolution,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MP4 retry failed';
      setMp4ConversionError(msg);
      notify('error', 'MP4 Conversion Failed', msg);
    } finally {
      setRendering(false);
      abortControllerRef.current = null;
    }
  };

  const handleRetryCloudBackup = async () => {
    if (!activeProject || !lastRenderedBlob || !lastRenderedBlob.renderId || uploadingCloud) return;
    setUploadingCloud(true);
    setCloudUploadError(null);
    try {
      const uploadRes = await videoStudioClient.uploadRenderedVideoWithProgress(
        activeProject.id,
        lastRenderedBlob.renderId,
        lastRenderedBlob.blob,
        lastRenderedBlob.format === 'mp4' ? 'video/mp4' : 'video/webm',
        (pct, label) => {
          setRenderProgress(pct);
          setRenderStatusLabel(label);
        }
      );
      setCloudBackupSaved(true);
      notify('success', 'Cloud Backup Complete', 'Video successfully uploaded to Supabase storage.');
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cloud upload retry failed';
      setCloudUploadError(msg);
      notify('error', 'Cloud Backup Failed', msg);
    } finally {
      setUploadingCloud(false);
    }
  };


  const handleSaveExportToLibrary = async (): Promise<MediaAsset | null> => {
    if (!activeProject || !lastRenderedBlob) return null;
    const blobKey = createId('blob');
    await putMediaBlob(blobKey, lastRenderedBlob.blob);

    const exportRec: ExportRecord = {
      id: createId('exp'),
      workspaceId: activeWorkspace.id,
      projectId: activeProject.id,
      projectName: activeProject.title,
      exportType: 'reel-mp4',
      themeName: activeProject.primaryStyle,
      format: `${exportResolution} ${lastRenderedBlob.format.toUpperCase()}`,
      dimensions: exportResolution,
      duration: lastRenderedBlob.durationSeconds,
      fps: 30,
      destinationProfile: activeProject.destination,
      blobKeys: [blobKey],
      exportHash: `vid-${activeProject.id}-${lastRenderedBlob.blob.size}`,
      savedToMediaLibrary: true,
      createdAt: new Date().toISOString(),
    };
    addExportRecord(exportRec);

    const mediaAsset: MediaAsset = {
      id: createId('media'),
      workspaceId: activeWorkspace.id,
      name: `${activeProject.title}.${lastRenderedBlob.format}`,
      mediaType: 'reel-export',
      mimeType: lastRenderedBlob.format === 'mp4' ? 'video/mp4' : 'video/webm',
      blobKey,
      dimensions: exportResolution,
      duration: lastRenderedBlob.durationSeconds,
      fps: 30,
      projectName: activeProject.title,
      createdAt: new Date().toISOString(),
    };
    await addMediaAsset(mediaAsset);
    notify('success', 'Saved to Media Library');
    return mediaAsset;
  };

  const handleSendToComposer = async () => {
    if (!activeProject || !lastRenderedBlob) return;
    const savedAsset = await handleSaveExportToLibrary();
    if (!savedAsset) return;
    openPostComposerWithDraft({
      title: activeProject.title,
      platform:
        activeProject.destination === 'youtube-shorts'
          ? 'youtube-shorts'
          : activeProject.destination === 'both'
            ? 'both-video'
            : 'instagram-reel',
      caption: activeProject.script.suggestedCaption,
      hashtags: activeProject.script.hashtags,
      mediaAssetIds: [savedAsset.id],
      sourceProjectId: activeProject.id,
    });
  };

  const totalSceneDuration = useMemo(
    () =>
      activeProject
        ? Number(activeProject.scenes.reduce((acc, s) => acc + s.durationSeconds, 0).toFixed(1))
        : 0,
    [activeProject]
  );

  // LIBRARY / CREATOR LANDING VIEW
  if (!activeProject) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">
              Behind The Release Video Studio
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              Produce 60–90s educational Instagram Reels &amp; YouTube Shorts with Stickman animation, 2D cartoon studio scenes, and kinetic motion graphics.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreator((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{showCreator ? 'Close Brief' : 'Create Educational Video'}</span>
          </button>
        </div>

        {/* New Educational Video Generator */}
        {showCreator && (
          <form
            onSubmit={handleGenerateProject}
            className="rounded-xl border border-zinc-800 bg-[#121216] p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Generate 60–90s Educational Video Script &amp; Storyboard</span>
              </h2>
              <span className="text-[11px] font-mono text-zinc-500">
                1080×1920 · 30fps · Remotion
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1.5">
                  Educational Topic / Thesis
                </label>
                <input
                  type="text"
                  required
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. Why mixing vocals before finalizing arrangement wastes studio budget"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Target Audience</label>
                <input
                  type="text"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">
                    Target Length (60–90s)
                  </label>
                  <input
                    type="number"
                    min={60}
                    max={90}
                    value={targetDuration}
                    onChange={(e) =>
                      setTargetDuration(Math.max(60, Math.min(90, Number(e.target.value) || 75)))
                    }
                    className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Destination</label>
                  <select
                    value={destination}
                    onChange={(e) => setDestination(e.target.value as VideoProject['destination'])}
                    className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                  >
                    <option value="both">Reels + Shorts (9:16)</option>
                    <option value="instagram-reels">Instagram Reels</option>
                    <option value="youtube-shorts">YouTube Shorts</option>
                  </select>
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1.5">Primary Visual Style</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {VIDEO_STYLES.map((vs) => (
                    <button
                      key={vs.id}
                      type="button"
                      onClick={() => setStyle(vs.id)}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        style === vs.id
                          ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
                          : 'bg-[#09090b] text-zinc-200 border-zinc-800 hover:border-zinc-600'
                      }`}
                    >
                      <div className="text-xs font-semibold">{vs.label}</div>
                      <div
                        className={`text-[11px] mt-1 leading-snug ${
                          style === vs.id ? 'text-zinc-700' : 'text-zinc-400'
                        }`}
                      >
                        {vs.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1.5">
                  Additional Key Points / Examples (Optional)
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional stats, release step takeaways, or call-to-action angle…"
                  className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreator(false)}
                className="px-3.5 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={generating || !topic.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
              >
                {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                <span>{generating ? 'Generating Script & Scenes…' : 'Generate Script & Storyboard'}</span>
              </button>
            </div>
          </form>
        )}

        {/* Filter & Search Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search video projects…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#121216] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[#121216] border border-zinc-800">
            {(['all', 'hybrid', 'stickman', 'cartoon-2d', 'motion-graphics'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStyleFilter(s)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                  styleFilter === s ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {s === 'all' ? 'All Styles' : s}
              </button>
            ))}
          </div>
        </div>

        {/* Projects Grid */}
        {loading ? (
          <div className="py-20 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading Video Library…</span>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-[#121216] p-12 text-center space-y-3">
            <Film className="w-8 h-8 text-zinc-500 mx-auto" />
            <h3 className="text-sm font-semibold text-zinc-200">No educational videos yet</h3>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Create your first 60–90s educational Instagram Reel or YouTube Short using Stickman characters, 2D studio scenes, and kinetic typography.
            </p>
            <button
              type="button"
              onClick={() => setShowCreator(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create First Video</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredProjects.map((proj) => (
              <div
                key={proj.id}
                className="rounded-xl border border-zinc-800 bg-[#121216] p-5 flex flex-col justify-between gap-4 hover:border-zinc-700 transition-colors"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>{proj.primaryStyle}</span>
                    <span className="font-mono tabular-nums">{proj.targetDurationSeconds}s · {proj.scenes.length} scenes</span>
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-100 line-clamp-2">{proj.title}</h3>
                  <p className="text-xs text-zinc-400 line-clamp-2">{proj.script.educationalTakeaway}</p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 border-t border-zinc-800/80">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveVideoProjectId(proj.id);
                      setUndoStack([]);
                    }}
                    className="px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
                  >
                    Open Studio
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleDuplicateProject(proj)}
                      title="Duplicate project"
                      className="p-1.5 text-zinc-400 hover:text-zinc-200"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteProj(proj)}
                      title="Delete project"
                      className="p-1.5 text-zinc-400 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Rendering & Optional External Provider Compliance Card */}
        <div className="rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-3">
          <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">
            Rendering Engine &amp; Optional Video Adapters
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {providers.map((prov) => (
              <div key={prov.id} className="rounded-lg border border-zinc-800/80 bg-[#09090b] p-3 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-100">{prov.label}</span>
                  <span className={`font-mono text-[11px] ${prov.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {prov.enabled ? 'Active' : 'Disabled'}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">{prov.note}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Delete Confirm Modal */}
        {confirmDeleteProj && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-100">Delete Video Project?</h3>
              <p className="text-xs text-zinc-400">
                Permanently remove “{confirmDeleteProj.title}”? Media exports already saved to Media Library remain intact.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteProj(null)}
                  className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteProject}
                  className="px-3 py-1.5 rounded bg-red-600 text-white text-xs font-semibold"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ACTIVE 5-STAGE PRODUCTION EDITOR
  const durationInFrames = computeProjectDurationFrames(activeProject, 30);

  return (
    <div className="space-y-5">
      {/* Editor Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setActiveVideoProjectId(null)}
            className="px-2.5 py-1.5 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:text-white"
          >
            Library
          </button>
          <input
            type="text"
            value={activeProject.title}
            onChange={(e) =>
              mutateProjectWithUndo((p) => ({ ...p, title: e.target.value }))
            }
            className="bg-transparent text-base font-bold text-zinc-100 focus:outline-none border-b border-transparent focus:border-zinc-600 min-w-[200px]"
          />
          <span className="text-xs font-mono tabular-nums text-zinc-400 whitespace-nowrap">
            {totalSceneDuration}s · {activeProject.scenes.length} scenes
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={undoStack.length === 0}
            onClick={handleUndo}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:text-white disabled:opacity-35"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Undo</span>
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleSaveProject()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>Save Project</span>
          </button>
        </div>
      </div>

      {/* 5-Stage Production Stepper */}
      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg bg-[#121216] border border-zinc-800">
        {WORKFLOW_STAGES.map((st) => (
          <button
            key={st.id}
            type="button"
            onClick={() =>
              mutateProjectWithUndo((p) => ({ ...p, workflowStage: st.id }))
            }
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              activeProject.workflowStage === st.id
                ? 'bg-zinc-100 text-zinc-950 font-semibold'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {st.label}
          </button>
        ))}
      </div>

      {/* STAGE 1: SCRIPT */}
      {activeProject.workflowStage === 'script' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-100">Educational Video Script (60–90s)</h2>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Opening Hook (0–5s)</label>
              <textarea
                rows={2}
                value={activeProject.script.hook}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    script: { ...p.script, hook: e.target.value },
                  }))
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Core Educational Takeaway</label>
              <input
                type="text"
                value={activeProject.script.educationalTakeaway}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    script: { ...p.script, educationalTakeaway: e.target.value },
                  }))
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Closing Call to Action</label>
              <textarea
                rows={2}
                value={activeProject.script.closingCta}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    script: { ...p.script, closingCta: e.target.value },
                  }))
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Social Post Caption</label>
              <textarea
                rows={2}
                value={activeProject.script.suggestedCaption}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    script: { ...p.script, suggestedCaption: e.target.value },
                  }))
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-100">Format &amp; Pacing</h3>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Destination Profile</label>
              <select
                value={activeProject.destination}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    destination: e.target.value as VideoProject['destination'],
                  }))
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="both">Instagram Reels + YouTube Shorts</option>
                <option value="instagram-reels">Instagram Reels</option>
                <option value="youtube-shorts">YouTube Shorts</option>
              </select>
            </div>
            <div className="text-xs text-zinc-400 space-y-1 pt-2 border-t border-zinc-800">
              <div>Aspect Ratio: <strong className="text-zinc-200">9:16 (1080×1920)</strong></div>
              <div>Frame Rate: <strong className="text-zinc-200">30 FPS</strong></div>
              <div>Combined Scene Runtime: <strong className="text-zinc-200 font-mono tabular-nums">{totalSceneDuration}s</strong></div>
            </div>
            <button
              type="button"
              onClick={() => mutateProjectWithUndo((p) => ({ ...p, workflowStage: 'storyboard' }))}
              className="w-full py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
            >
              Continue to Storyboard →
            </button>
          </div>
        </div>
      )}

      {/* STAGE 2: STORYBOARD */}
      {activeProject.workflowStage === 'storyboard' && activeScene && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Scene Rail */}
          <div className="lg:col-span-5 space-y-2 max-h-[640px] overflow-y-auto pr-1">
            {activeProject.scenes.map((sc, idx) => (
              <div
                key={sc.id}
                onClick={() => setSelectedSceneId(sc.id)}
                className={`p-3.5 rounded-xl border cursor-pointer transition-colors ${
                  sc.id === activeScene.id
                    ? 'bg-[#18181f] border-zinc-400'
                    : 'bg-[#121216] border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-100 truncate">
                    {idx + 1}. {sc.title}
                  </span>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <span className="text-[11px] font-mono tabular-nums text-zinc-400 mr-1">
                      {sc.durationSeconds}s
                    </span>
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMoveScene(idx, -1)}
                      className="p-1 text-zinc-400 hover:text-white disabled:opacity-30"
                      aria-label="Move scene up"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === activeProject.scenes.length - 1}
                      onClick={() => handleMoveScene(idx, 1)}
                      className="p-1 text-zinc-400 hover:text-white disabled:opacity-30"
                      aria-label="Move scene down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{sc.narrationText}</p>
                <div className="text-[11px] text-zinc-500 mt-1.5">
                  {sc.style} · {sc.stickman.action} · {sc.motion.chartType}
                </div>
              </div>
            ))}
          </div>

          {/* Selected Scene Editor */}
          <div className="lg:col-span-7 rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">Edit Scene {activeScene.orderIndex + 1}</h3>
              <button
                type="button"
                onClick={() => mutateProjectWithUndo((p) => ({ ...p, workflowStage: 'assets' }))}
                className="text-xs text-amber-400 hover:text-amber-300 font-medium"
              >
                Customize Stickman &amp; Visuals →
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1">Scene Title</label>
                <input
                  type="text"
                  value={activeScene.title}
                  onChange={(e) => updateActiveScene({ title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Duration (sec)</label>
                <input
                  type="number"
                  min={3}
                  max={20}
                  step={0.5}
                  value={activeScene.durationSeconds}
                  onChange={(e) =>
                    updateActiveScene({
                      durationSeconds: Math.max(3, Math.min(20, Number(e.target.value) || 7)),
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 font-mono tabular-nums"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Narration &amp; Word-Synced Subtitle Text</label>
              <textarea
                rows={3}
                value={activeScene.narrationText}
                onChange={(e) =>
                  updateActiveScene({
                    narrationText: e.target.value,
                    subtitleText: e.target.value,
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Headline Overlay</label>
                <input
                  type="text"
                  value={activeScene.motion.headline}
                  onChange={(e) =>
                    updateActiveScene({
                      motion: { ...activeScene.motion, headline: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Style Mode</label>
                <select
                  value={activeScene.style}
                  onChange={(e) => {
                    const nextStyle = e.target.value as VideoStyle;
                    updateActiveScene({
                      style: nextStyle,
                      stickman: {
                        ...activeScene.stickman,
                        enabled: nextStyle === 'stickman' || nextStyle === 'hybrid',
                      },
                      cartoon: {
                        ...activeScene.cartoon,
                        enabled: nextStyle === 'cartoon-2d' || nextStyle === 'hybrid',
                      },
                    });
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="hybrid">Hybrid Mix</option>
                  <option value="stickman">Stickman Only</option>
                  <option value="cartoon-2d">2D Cartoon Scene</option>
                  <option value="motion-graphics">Motion Graphics</option>
                </select>
              </div>
            </div>

            {/* Single-Scene AI Regeneration */}
            <div className="pt-3 border-t border-zinc-800 space-y-2">
              <label className="block text-xs text-zinc-400">
                Regenerate Only This Scene (AI Provider Manager)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={regenInstruction}
                  onChange={(e) => setRegenInstruction(e.target.value)}
                  placeholder="Optional note (e.g. make hook punchier, switch to chart explanation)…"
                  className="flex-1 px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
                <button
                  type="button"
                  disabled={regenLoading}
                  onClick={handleRegenerateScene}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500 whitespace-nowrap"
                >
                  {regenLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  <span>Regen Scene</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STAGE 3: VISUAL & AUDIO ASSETS */}
      {activeProject.workflowStage === 'assets' && activeScene && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Stickman Character Engine Controls */}
          <div className="rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Stickman Engine (18 Actions)</h3>
              <label className="text-xs text-zinc-300 inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={activeScene.stickman.enabled}
                  onChange={(e) =>
                    updateActiveScene({
                      stickman: { ...activeScene.stickman, enabled: e.target.checked },
                    })
                  }
                />
                <span>Visible</span>
              </label>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Action Pose</label>
              <select
                value={activeScene.stickman.action}
                onChange={(e) =>
                  updateActiveScene({
                    stickman: {
                      ...activeScene.stickman,
                      action: e.target.value as VideoScene['stickman']['action'],
                    },
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                {ALL_STICKMAN_ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Head Shape</label>
                <select
                  value={activeScene.stickman.headShape}
                  onChange={(e) =>
                    updateActiveScene({
                      stickman: {
                        ...activeScene.stickman,
                        headShape: e.target.value as StickmanHeadShape,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="circle">Circle</option>
                  <option value="rounded-square">Rounded Square</option>
                  <option value="oval">Oval</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Expression</label>
                <select
                  value={activeScene.stickman.expression}
                  onChange={(e) =>
                    updateActiveScene({
                      stickman: {
                        ...activeScene.stickman,
                        expression: e.target.value as StickmanExpression,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="focused">Focused</option>
                  <option value="happy">Happy</option>
                  <option value="surprised">Surprised</option>
                  <option value="skeptical">Skeptical</option>
                  <option value="neutral">Neutral</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Body Color</label>
                <input
                  type="color"
                  value={activeScene.stickman.bodyColor}
                  onChange={(e) =>
                    updateActiveScene({
                      stickman: { ...activeScene.stickman, bodyColor: e.target.value },
                    })
                  }
                  className="w-full h-8 rounded bg-[#09090b] border border-zinc-800"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Outline Color</label>
                <input
                  type="color"
                  value={activeScene.stickman.outlineColor}
                  onChange={(e) =>
                    updateActiveScene({
                      stickman: { ...activeScene.stickman, outlineColor: e.target.value },
                    })
                  }
                  className="w-full h-8 rounded bg-[#09090b] border border-zinc-800"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Accessories</label>
              <div className="flex flex-wrap gap-1.5">
                {ACCESSORIES_LIST.map((acc) => {
                  const has = activeScene.stickman.accessories.includes(acc);
                  return (
                    <button
                      key={acc}
                      type="button"
                      onClick={() =>
                        updateActiveScene({
                          stickman: {
                            ...activeScene.stickman,
                            accessories: has
                              ? activeScene.stickman.accessories.filter((a) => a !== acc)
                              : [...activeScene.stickman.accessories, acc],
                          },
                        })
                      }
                      className={`px-2.5 py-1 rounded text-[11px] border ${
                        has
                          ? 'bg-zinc-100 text-zinc-950 border-zinc-100 font-semibold'
                          : 'bg-[#09090b] text-zinc-400 border-zinc-800'
                      }`}
                    >
                      {acc}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 2D Cartoon Scene & Motion Graphics */}
          <div className="rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">2D Cartoon &amp; Motion Graphics</h3>
              <label className="text-xs text-zinc-300 inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={activeScene.cartoon.enabled}
                  onChange={(e) =>
                    updateActiveScene({
                      cartoon: { ...activeScene.cartoon, enabled: e.target.checked },
                    })
                  }
                />
                <span>2D Scene</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Background</label>
                <select
                  value={activeScene.cartoon.backgroundPreset}
                  onChange={(e) =>
                    updateActiveScene({
                      cartoon: {
                        ...activeScene.cartoon,
                        backgroundPreset: e.target.value as CartoonBackgroundPreset,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="recording-studio">Recording Studio</option>
                  <option value="vocal-booth">Vocal Booth</option>
                  <option value="desk-setup">Desk Setup</option>
                  <option value="stage-spotlight">Stage Spotlight</option>
                  <option value="mobile-analytics">Mobile Analytics</option>
                  <option value="minimal-dark">Minimal Dark</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">2D Character</label>
                <select
                  value={activeScene.cartoon.characterId}
                  onChange={(e) =>
                    updateActiveScene({
                      cartoon: {
                        ...activeScene.cartoon,
                        characterId: e.target.value as CartoonCharacterId,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="artist">Artist</option>
                  <option value="producer">Producer</option>
                  <option value="engineer">Engineer</option>
                  <option value="creator">Creator</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Chart / Kinetic Visual</label>
              <select
                value={activeScene.motion.chartType}
                onChange={(e) =>
                  updateActiveScene({
                    motion: {
                      ...activeScene.motion,
                      chartType: e.target.value as MotionChartType,
                    },
                  })
                }
                className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="none">Headline Only</option>
                <option value="bar">Animated Bar Chart</option>
                <option value="line">Progress Bars</option>
                <option value="timeline">Timeline Steps</option>
                <option value="comparison">Comparison Split</option>
                <option value="flowchart">Workflow Flowchart</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">2D Props</label>
              <div className="flex flex-wrap gap-1.5">
                {PROPS_LIST.map((propId) => {
                  const active = activeScene.cartoon.props.includes(propId);
                  return (
                    <button
                      key={propId}
                      type="button"
                      onClick={() =>
                        updateActiveScene({
                          cartoon: {
                            ...activeScene.cartoon,
                            props: active
                              ? activeScene.cartoon.props.filter((p) => p !== propId)
                              : [...activeScene.cartoon.props, propId].slice(0, 4),
                          },
                        })
                      }
                      className={`px-2 py-1 rounded text-[11px] border ${
                        active
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                          : 'bg-[#09090b] text-zinc-400 border-zinc-800'
                      }`}
                    >
                      {propId}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Custom Image / Screenshot</label>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-200 cursor-pointer hover:border-zinc-500">
                <ImagePlus className="w-3.5 h-3.5" />
                <span>Upload Scene Image</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleSceneImageUpload(e.target.files?.[0])}
                />
              </label>
            </div>
          </div>

          {/* Audio Mixer */}
          <div className="rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Music className="w-4 h-4 text-amber-400" />
              <span>Audio Tracks &amp; Captions</span>
            </h3>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Voiceover / Narration Track</label>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-200 cursor-pointer">
                <span>{activeProject.audio.narrationName || 'Upload Voice Audio'}</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => handleAudioUpload('narration', e.target.files?.[0])}
                />
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={activeProject.audio.narrationVolume}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    audio: { ...p.audio, narrationVolume: Number(e.target.value) },
                  }))
                }
                className="w-full mt-1.5"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Background Music Track</label>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-200 cursor-pointer">
                <span>{activeProject.audio.bgmName || 'Upload BGM Track'}</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => handleAudioUpload('bgm', e.target.files?.[0])}
                />
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={activeProject.audio.bgmVolume}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    audio: { ...p.audio, bgmVolume: Number(e.target.value) },
                  }))
                }
                className="w-full mt-1.5"
              />
            </div>

            <div className="pt-2 border-t border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-300">Progress Bar</span>
              <input
                type="checkbox"
                checked={activeProject.captionStyle.showProgressBar}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    captionStyle: { ...p.captionStyle, showProgressBar: e.target.checked },
                  }))
                }
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">Behind The Release Watermark</span>
              <input
                type="checkbox"
                checked={activeProject.captionStyle.showBrandWatermark}
                onChange={(e) =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    captionStyle: { ...p.captionStyle, showBrandWatermark: e.target.checked },
                  }))
                }
              />
            </div>

            <button
              type="button"
              onClick={() => mutateProjectWithUndo((p) => ({ ...p, workflowStage: 'preview' }))}
              className="w-full py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
            >
              Open Remotion Player Preview →
            </button>
          </div>
        </div>
      )}

      {/* STAGE 4: LIVE REMOTION PREVIEW & APPROVAL */}
      {activeProject.workflowStage === 'preview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 flex justify-center">
            <div className="w-[320px] rounded-2xl border border-zinc-800 bg-black overflow-hidden shadow-2xl">
              <Player
                component={BehindTheReleaseVideoComposition}
                inputProps={{ project: activeProject }}
                durationInFrames={durationInFrames}
                compositionWidth={1080}
                compositionHeight={1920}
                fps={30}
                controls
                style={{ width: '100%', aspectRatio: '9 / 16' }}
              />
            </div>
          </div>

          <div className="lg:col-span-7 rounded-xl border border-zinc-800 bg-[#121216] p-6 space-y-4">
            <h3 className="text-base font-semibold text-zinc-100">
              Preview Check &amp; Manual Approval Gate
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Review timing, Stickman animations, 2D props, and captions in the Remotion Player. Exporting requires explicit approval so no unverified video renders are generated automatically.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800">
                <div className="text-zinc-500">Duration</div>
                <div className="text-sm font-mono tabular-nums font-semibold text-zinc-100 mt-0.5">
                  {totalSceneDuration}s
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800">
                <div className="text-zinc-500">Scenes</div>
                <div className="text-sm font-mono tabular-nums font-semibold text-zinc-100 mt-0.5">
                  {activeProject.scenes.length}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800">
                <div className="text-zinc-500">Approval Status</div>
                <div
                  className={`text-sm font-semibold mt-0.5 ${
                    activeProject.approvedForRender ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {activeProject.approvedForRender ? 'Approved' : 'Pending Approval'}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() =>
                  mutateProjectWithUndo((p) => ({
                    ...p,
                    approvedForRender: true,
                    status: 'approved',
                    workflowStage: 'export',
                  }))
                }
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-500 text-zinc-950 hover:bg-emerald-400 text-xs font-semibold"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Approve &amp; Proceed to Export</span>
              </button>
              <button
                type="button"
                onClick={() => mutateProjectWithUndo((p) => ({ ...p, workflowStage: 'storyboard' }))}
                className="px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200"
              >
                Back to Storyboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STAGE 5: RENDER & EXPORT */}
      {activeProject.workflowStage === 'export' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 rounded-xl border border-zinc-800 bg-[#121216] p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-zinc-100">
                Render Verified H.264 MP4 Export
              </h3>
              <span className="text-[11px] font-mono text-zinc-400">
                FFmpeg H.264 + AAC · +faststart
              </span>
            </div>

            {!activeProject.approvedForRender ? (
              <div className="p-4 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200 space-y-2">
                <div>Approve the script and storyboard in Stage 4 before rendering.</div>
                <button
                  type="button"
                  onClick={() => mutateProjectWithUndo((p) => ({ ...p, workflowStage: 'preview' }))}
                  className="underline font-semibold"
                >
                  Go to Preview &amp; Approval
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Render Resolution</label>
                    <select
                      value={exportResolution}
                      onChange={(e) =>
                        setExportResolution(e.target.value as VideoExportResolution)
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    >
                      <option value="1080x1920">1080×1920 Vertical 9:16 (Reels / Shorts)</option>
                      <option value="1920x1080">1920×1080 Landscape 16:9 (YouTube / Studio)</option>
                      <option value="540x960">540×960 Fast Draft Preview (MP4)</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      disabled={rendering}
                      onClick={handleRenderExport}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
                    >
                      {rendering ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Film className="w-4 h-4" />
                      )}
                      <span>{rendering ? 'Rendering…' : 'Start Video Render'}</span>
                    </button>
                    {rendering && (
                      <button
                        type="button"
                        onClick={() => abortControllerRef.current?.abort()}
                        className="px-3 py-2 rounded-lg border border-red-500/50 text-xs text-red-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {rendering && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-zinc-400 font-mono tabular-nums">
                      <span>{renderStatusLabel}</span>
                      <span>{renderProgress}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-amber-400 transition-all"
                        style={{ width: `${renderProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {mp4ConversionError && pendingRawRender && (
                  <div className="p-4 rounded-xl border border-red-500/40 bg-red-500/10 space-y-2.5 text-xs text-red-200">
                    <div className="font-semibold text-red-100">
                      MP4 Conversion Failed — Original Render Preserved
                    </div>
                    <p className="text-[11px] text-red-200/90 leading-relaxed">
                      {mp4ConversionError}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={rendering}
                        onClick={handleRetryMp4Conversion}
                        className="px-3 py-1.5 rounded-md bg-red-500 text-zinc-950 font-semibold hover:bg-red-400 disabled:opacity-50"
                      >
                        Retry MP4 Conversion
                      </button>
                    </div>
                  </div>
                )}

                {lastRenderedBlob && (
                  <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 space-y-3">
                    <div className="flex items-center justify-between text-xs font-semibold text-emerald-300">
                      <span>Render ready · {lastRenderedBlob.format.toUpperCase()} ({(lastRenderedBlob.blob.size / (1024 * 1024)).toFixed(2)} MB)</span>
                      <span className={cloudBackupSaved ? 'text-emerald-400' : 'text-amber-400'}>
                        {cloudBackupSaved ? '✓ Cloud Backup Saved' : uploadingCloud ? 'Uploading Cloud Backup…' : 'Local Draft / Cloud Backup Pending'}
                      </span>
                    </div>

                    {cloudUploadError && (
                      <div className="text-[11px] text-amber-200 bg-amber-500/20 p-2 rounded border border-amber-500/30 flex items-center justify-between gap-2">
                        <span>Cloud backup notice: {cloudUploadError}</span>
                        <button
                          type="button"
                          disabled={uploadingCloud}
                          onClick={handleRetryCloudBackup}
                          className="px-2.5 py-1 rounded bg-amber-500 text-zinc-950 font-semibold hover:bg-amber-400 disabled:opacity-50 text-[11px]"
                        >
                          {uploadingCloud ? 'Retrying…' : 'Retry Cloud Backup'}
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          triggerBlobDownload(
                            lastRenderedBlob.blob,
                            `${activeProject.title.replace(/[^a-z0-9-_]+/gi, '_')}.${lastRenderedBlob.format}`
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download {lastRenderedBlob.format.toUpperCase()}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveExportToLibrary}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 bg-[#09090b] text-xs text-zinc-100"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                        <span>Save to Media Library</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleSendToComposer}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-950 text-xs font-semibold"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Schedule / Post</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="pt-3 border-t border-zinc-800 text-[11px] text-zinc-400 leading-relaxed">
              Remotion Free License Notice: Built with Remotion for local/client browser rendering (free for individuals and small teams up to 3 people). No paid Remotion Lambda or cloud rendering credentials are required.
            </div>
          </div>

          <div className="lg:col-span-5 rounded-xl border border-zinc-800 bg-[#121216] p-5 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-100">Render History</h3>
            {activeProject.renders.length === 0 ? (
              <div className="text-xs text-zinc-500 py-8 text-center">
                No completed exports yet for this project.
              </div>
            ) : (
              <div className="space-y-2">
                {activeProject.renders.map((r) => (
                  <div
                    key={r.id}
                    className="p-3 rounded-lg bg-[#09090b] border border-zinc-800 text-xs flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium text-zinc-200">
                        {r.resolution} · {r.format.toUpperCase()} ({r.engine})
                      </div>
                      <div className="text-[11px] text-zinc-500 font-mono tabular-nums">
                        {r.durationSeconds}s · {new Date(r.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className="text-[11px] text-emerald-400 font-medium">{r.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
