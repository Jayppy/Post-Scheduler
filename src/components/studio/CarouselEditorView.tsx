import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarPlus,
  Check,
  Copy,
  Download,
  Eye,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Plus,
  Redo2,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { aiClient, AiApiError } from '../../services/aiClient';
import {
  computeCarouselExportHash,
  exportAllSlidesToPngBlobs,
  packagePngSlidesToZip,
  renderSlideToCanvas,
  triggerBlobDownload,
} from '../../services/carouselRenderer';
import { fileToDataUrl, putMediaBlob } from '../../services/idb';
import { createId } from '../../services/storage';
import {
  CarouselSlide,
  CarouselState,
  CreativeProject,
  DesignTheme,
  ExportRecord,
  SlideAspectRatio,
  SlideLayoutVariant,
} from '../../types/studio';

export const CarouselEditorView: React.FC = () => {
  const {
    activeWorkspace,
    activeProject,
    workspaceProjects,
    workspaceThemes,
    saveProject,
    setActiveProjectId,
    setStudioSubView,
    addExportRecord,
    saveExportToMediaLibrary,
    openPostComposerWithDraft,
    schedulePostToCalendar,
    notify,
  } = useStudio();

  // Auto-select latest carousel project if none selected
  const project: CreativeProject | undefined =
    activeProject && activeProject.type === 'carousel'
      ? activeProject
      : workspaceProjects.find((p) => p.type === 'carousel');

  const [undoStack, setUndoStack] = useState<CarouselState[]>([]);
  const [redoStack, setRedoStack] = useState<CarouselState[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [isRenderingPreview, setIsRenderingPreview] = useState(false);
  const [isRegeneratingSlide, setIsRegeneratingSlide] = useState(false);
  const [regenInstruction, setRegenInstruction] = useState('');

  // Export & Integration state
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [showFullPreviewModal, setShowFullPreviewModal] = useState(false);
  const [fullPreviewUrls, setFullPreviewUrls] = useState<string[]>([]);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calDate, setCalDate] = useState('2026-11-26');
  const [calTime, setCalTime] = useState('18:00');
  const [duplicateConfirmHash, setDuplicateConfirmHash] = useState<string | null>(null);

  const carousel = project?.carouselState;
  const theme: DesignTheme =
    workspaceThemes.find((t) => t.id === project?.themeId) || workspaceThemes[0];

  const selectedSlide: CarouselSlide | undefined =
    carousel?.slides.find((s) => s.id === carousel.selectedSlideId) || carousel?.slides[0];

  // Sync live high-DPI canvas preview for selected slide
  useEffect(() => {
    let cancelled = false;
    if (!project || !carousel || !selectedSlide || !theme) return;

    const idx = carousel.slides.findIndex((s) => s.id === selectedSlide.id);
    setIsRenderingPreview(true);
    renderSlideToCanvas(
      selectedSlide,
      Math.max(0, idx),
      carousel.slides.length,
      theme,
      activeWorkspace,
      carousel.aspectRatio
    )
      .then((canvas) => {
        if (cancelled) return;
        setPreviewUrl(canvas.toDataURL('image/png'));
      })
      .catch((err) => {
        console.error(err);
      })
      .finally(() => {
        if (!cancelled) setIsRenderingPreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    project?.id,
    project?.themeId,
    carousel?.aspectRatio,
    carousel?.slides,
    selectedSlide?.id,
    theme,
    activeWorkspace,
  ]);

  if (!project || !carousel) {
    return (
      <div className="p-10 rounded-xl bg-[#111114] border border-zinc-800 text-center space-y-4">
        <h2 className="text-lg font-semibold text-zinc-100">No Active Carousel Project</h2>
        <p className="text-xs text-zinc-400 max-w-md mx-auto">
          Start a new Content-First or Topic-First carousel in {activeWorkspace.name} to open the visual editor.
        </p>
        <button
          type="button"
          onClick={() => setStudioSubView('carousel-creator')}
          className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
        >
          Open Carousel Creator
        </button>
      </div>
    );
  }

  const commitCarouselChange = (nextState: CarouselState, nextThemeId?: string) => {
    setUndoStack((prev) => [...prev.slice(-19), carousel]);
    setRedoStack([]);
    saveProject({
      ...project,
      themeId: nextThemeId || project.themeId,
      status: 'edited',
      carouselState: nextState,
    });
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, carousel]);
    saveProject({ ...project, carouselState: prev });
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, carousel]);
    saveProject({ ...project, carouselState: next });
  };

  const updateSelectedSlide = (patch: Partial<CarouselSlide>) => {
    if (!selectedSlide) return;
    const nextSlides = carousel.slides.map((s) =>
      s.id === selectedSlide.id ? { ...s, ...patch } : s
    );
    commitCarouselChange({ ...carousel, slides: nextSlides });
  };

  const handleSlideImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    updateSelectedSlide({ imageUrl: dataUrl });
    notify('success', 'Slide image updated');
  };

  const handleMoveSlide = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= carousel.slides.length) return;
    const nextSlides = [...carousel.slides];
    [nextSlides[index], nextSlides[target]] = [nextSlides[target], nextSlides[index]];
    commitCarouselChange({ ...carousel, slides: nextSlides });
  };

  const handleDuplicateSlide = (index: number) => {
    const orig = carousel.slides[index];
    const copy: CarouselSlide = { ...orig, id: createId('sl') };
    const nextSlides = [...carousel.slides];
    nextSlides.splice(index + 1, 0, copy);
    commitCarouselChange({ ...carousel, slides: nextSlides, selectedSlideId: copy.id });
  };

  const handleDeleteSlide = (id: string) => {
    if (carousel.slides.length <= 1) return;
    const idx = carousel.slides.findIndex((s) => s.id === id);
    const nextSlides = carousel.slides.filter((s) => s.id !== id);
    const nextSelected = nextSlides[Math.max(0, idx - 1)].id;
    commitCarouselChange({ ...carousel, slides: nextSlides, selectedSlideId: nextSelected });
  };

  const handleAddSlide = () => {
    const newSlide: CarouselSlide = {
      id: createId('sl'),
      role: 'body',
      kicker: `${String(carousel.slides.length + 1).padStart(2, '0')} · INSIGHT`,
      headline: 'New Slide Headline',
      body: 'Click here or edit in the text inspector to update this slide.',
      highlight: '',
      layoutVariant: 'editorial-split',
    };
    commitCarouselChange({
      ...carousel,
      slides: [...carousel.slides, newSlide],
      selectedSlideId: newSlide.id,
    });
  };

  const handleRegenerateSelectedSlide = async () => {
    if (!selectedSlide) return;
    setIsRegeneratingSlide(true);
    try {
      const updated = await aiClient.regenerateSingleSlide({
        slide: selectedSlide,
        instruction: regenInstruction,
        workspaceName: activeWorkspace.name,
        themeName: theme.name,
      });
      updateSelectedSlide({
        kicker: updated.kicker ?? selectedSlide.kicker,
        headline: updated.headline,
        body: updated.body,
        highlight: updated.highlight ?? selectedSlide.highlight,
        layoutVariant: (updated.layoutVariant as SlideLayoutVariant) || selectedSlide.layoutVariant,
      });
      notify('success', 'Slide design & copy refreshed');
      setRegenInstruction('');
    } catch (err) {
      const msg = err instanceof AiApiError ? err.message : 'Unable to regenerate slide.';
      notify('warning', 'AI slide regeneration unavailable', msg);
    } finally {
      setIsRegeneratingSlide(false);
    }
  };

  const openFullPreview = async () => {
    setIsExporting(true);
    setExportProgress('Rendering full carousel preview...');
    try {
      const urls: string[] = [];
      for (let i = 0; i < carousel.slides.length; i++) {
        const c = await renderSlideToCanvas(
          carousel.slides[i],
          i,
          carousel.slides.length,
          theme,
          activeWorkspace,
          carousel.aspectRatio
        );
        urls.push(c.toDataURL('image/png'));
      }
      setFullPreviewUrls(urls);
      setShowFullPreviewModal(true);
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const executeRenderAndRecord = async (
    exportType: 'carousel-png' | 'carousel-zip'
  ): Promise<{
    slides: Array<{ slideNumber: number; filename: string; blob: Blob }>;
    record: ExportRecord;
  }> => {
    const rendered = await exportAllSlidesToPngBlobs(
      carousel.slides,
      theme,
      activeWorkspace,
      carousel.aspectRatio,
      (done, total) => setExportProgress(`Rendering slide ${done} of ${total}...`)
    );

    const blobKeys: string[] = [];
    for (const item of rendered) {
      const key = createId('exp-blob');
      await putMediaBlob(key, item.blob);
      blobKeys.push(key);
    }

    const exportHash = computeCarouselExportHash(
      project.id,
      theme.id,
      carousel.aspectRatio,
      carousel.slides
    );

    const record: ExportRecord = {
      id: createId('exp'),
      workspaceId: activeWorkspace.id,
      projectId: project.id,
      projectName: project.title,
      exportType,
      themeName: theme.name,
      format: exportType === 'carousel-zip' ? 'ZIP (PNG)' : 'PNG',
      dimensions: carousel.aspectRatio.replace('x', '×'),
      slideCount: rendered.length,
      blobKeys,
      exportHash,
      savedToMediaLibrary: false,
      createdAt: new Date().toISOString(),
    };

    addExportRecord(record);
    saveProject({ ...project, status: 'exported' });
    return { slides: rendered, record };
  };

  const handleDownloadIndividualPngs = async () => {
    setIsExporting(true);
    try {
      const { slides } = await executeRenderAndRecord('carousel-png');
      const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
      for (const s of slides) {
        triggerBlobDownload(s.blob, `${slug}_${s.filename}`);
      }
      notify('success', `Exported ${slides.length} PNG slides`, 'Files downloaded in sequence.');
    } catch (err) {
      notify('error', 'PNG export failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const handleDownloadZip = async () => {
    setIsExporting(true);
    try {
      const { slides } = await executeRenderAndRecord('carousel-zip');
      setExportProgress('Packaging ordered ZIP archive...');
      const zipBlob = await packagePngSlidesToZip(slides);
      const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
      triggerBlobDownload(zipBlob, `${slug}_carousel.zip`);
      notify('success', 'ZIP archive downloaded', `${slides.length} ordered PNG slides packaged.`);
    } catch (err) {
      notify('error', 'ZIP export failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const handleSaveToMediaLibrary = async (allowDuplicateCopy = false) => {
    setIsExporting(true);
    setDuplicateConfirmHash(null);
    try {
      const { slides, record } = await executeRenderAndRecord('carousel-png');
      const result = await saveExportToMediaLibrary(
        record,
        slides,
        activeWorkspace.id,
        allowDuplicateCopy
      );
      if (result.skippedDuplicate) {
        setDuplicateConfirmHash(record.exportHash);
        notify(
          'warning',
          'Already saved in Media Library',
          'Identical export exists. Click "Save New Copy" if you want a duplicate.'
        );
      } else {
        notify(
          'success',
          'Saved to Media Library',
          `${result.savedAssets.length} ordered PNG slides stored in ${activeWorkspace.name}.`
        );
      }
    } catch (err) {
      notify('error', 'Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const handleCreateInstagramPost = async () => {
    setIsExporting(true);
    try {
      const { slides, record } = await executeRenderAndRecord('carousel-png');
      const { savedAssets } = await saveExportToMediaLibrary(
        record,
        slides,
        activeWorkspace.id,
        false
      );
      openPostComposerWithDraft({
        title: project.title,
        platform: 'instagram-carousel',
        caption: carousel.suggestedCaption || `${project.title} — created in ${activeWorkspace.name}.`,
        hashtags: carousel.suggestedHashtags || ['#BehindTheRelease', '#MusicIndustry'],
        mediaAssetIds: savedAssets.map((a) => a.id),
        sourceProjectId: project.id,
      });
    } catch (err) {
      notify('error', 'Failed to prepare Instagram post', err instanceof Error ? err.message : '');
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const handleConfirmScheduleCalendar = async () => {
    setIsExporting(true);
    try {
      const { slides, record } = await executeRenderAndRecord('carousel-png');
      const { savedAssets } = await saveExportToMediaLibrary(
        record,
        slides,
        activeWorkspace.id,
        false
      );
      schedulePostToCalendar({
        title: project.title,
        platform: 'instagram-carousel',
        caption: carousel.suggestedCaption || project.title,
        hashtags: carousel.suggestedHashtags || ['#BehindTheRelease'],
        mediaAssetIds: savedAssets.map((a) => a.id),
        scheduledDate: calDate,
        scheduledTime: calTime,
        sourceProjectId: project.id,
      });
      setShowCalendarModal(false);
    } catch (err) {
      notify('error', 'Failed to schedule carousel', err instanceof Error ? err.message : '');
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <input
            type="text"
            value={project.title}
            onChange={(e) => saveProject({ ...project, title: e.target.value })}
            className="bg-transparent text-lg font-bold text-zinc-100 border-b border-transparent hover:border-zinc-700 focus:border-zinc-400 focus:outline-none px-1 py-0.5 truncate max-w-xs sm:max-w-md"
          />
          <span className="text-xs font-mono text-zinc-500">
            {carousel.aspectRatio.replace('x', '×')} · {carousel.slides.length} slides
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            className="p-2 rounded-md border border-zinc-800 text-zinc-300 hover:border-zinc-600 disabled:opacity-30"
            title="Undo"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            className="p-2 rounded-md border border-zinc-800 text-zinc-300 hover:border-zinc-600 disabled:opacity-30"
            title="Redo"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={openFullPreview}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Preview Deck</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              setStudioSubView('carousel-creator');
            }}
            className="px-3 py-2 rounded-md border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200"
          >
            New Carousel
          </button>
        </div>
      </div>

      {/* Main 3-Column Editor Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Column 1: Slide Navigation Strip */}
        <div className="xl:col-span-3 rounded-xl bg-[#111114] border border-zinc-800 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-200">Slides</span>
            <button
              type="button"
              onClick={handleAddSlide}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-100"
            >
              <Plus className="w-3 h-3" />
              <span>Add</span>
            </button>
          </div>

          <div className="space-y-2 max-h-[580px] overflow-y-auto pr-1">
            {carousel.slides.map((s, idx) => {
              const active = s.id === selectedSlide?.id;
              return (
                <div
                  key={s.id}
                  onClick={() => saveProject({ ...project, carouselState: { ...carousel, selectedSlideId: s.id } })}
                  className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#1a1a20] border-zinc-300'
                      : 'bg-[#09090b] border-zinc-800/80 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono text-[11px] font-semibold text-zinc-400">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => handleMoveSlide(idx, -1)}
                        disabled={idx === 0}
                        className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                        title="Move up"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveSlide(idx, 1)}
                        disabled={idx === carousel.slides.length - 1}
                        className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                        title="Move down"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateSlide(idx)}
                        className="p-1 text-zinc-500 hover:text-zinc-200"
                        title="Duplicate"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSlide(s.id)}
                        disabled={carousel.slides.length <= 1}
                        className="p-1 text-zinc-500 hover:text-red-400 disabled:opacity-30"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs font-medium text-zinc-100 truncate">{s.headline || 'Untitled Slide'}</div>
                  <div className="text-[11px] text-zinc-500 truncate mt-0.5">{s.body}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Large Interactive Canvas Preview + Direct Click-to-Edit */}
        <div className="xl:col-span-5 rounded-xl bg-[#111114] border border-zinc-800 p-4 flex flex-col items-center space-y-3">
          <div className="w-full flex items-center justify-between text-xs text-zinc-400">
            <span>Live High-DPI Slide Preview</span>
            {isRenderingPreview && (
              <span className="inline-flex items-center gap-1.5 text-zinc-300">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Rendering...</span>
              </span>
            )}
          </div>

          <div className="relative w-full max-w-[440px] rounded-lg overflow-hidden border border-zinc-800 bg-[#09090b] shadow-2xl">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={`Slide preview: ${selectedSlide?.headline}`}
                className="w-full h-auto block"
              />
            ) : (
              <div className="aspect-[4/5] flex items-center justify-center text-xs text-zinc-500">
                Rendering slide canvas...
              </div>
            )}
          </div>

          {/* Inline Quick Direct Edit Bar */}
          {selectedSlide && (
            <div className="w-full pt-2 border-t border-zinc-800/80 space-y-2">
              <div className="text-[11px] font-medium text-zinc-400">
                Direct Text Editing (Live Synced)
              </div>
              <input
                type="text"
                value={selectedSlide.headline}
                onChange={(e) => updateSelectedSlide({ headline: e.target.value })}
                placeholder="Click to edit headline directly"
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs font-semibold text-zinc-100"
              />
              <textarea
                rows={2}
                value={selectedSlide.body}
                onChange={(e) => updateSelectedSlide({ body: e.target.value })}
                placeholder="Click to edit body copy directly"
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              />
            </div>
          )}
        </div>

        {/* Column 3: Slide Inspector, Theme Controls & Export Hub */}
        <div className="xl:col-span-4 space-y-4">
          {selectedSlide && (
            <div className="rounded-xl bg-[#111114] border border-zinc-800 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                  Slide & Theme Controls
                </h3>
                <select
                  value={project.themeId}
                  onChange={(e) => commitCarouselChange(carousel, e.target.value)}
                  className="px-2.5 py-1 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                >
                  {workspaceThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Aspect Ratio</label>
                  <select
                    value={carousel.aspectRatio}
                    onChange={(e) =>
                      commitCarouselChange({
                        ...carousel,
                        aspectRatio: e.target.value as SlideAspectRatio,
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-200"
                  >
                    <option value="1080x1350">1080×1350 (IG Portrait)</option>
                    <option value="1080x1080">1080×1080 (Square)</option>
                    <option value="1080x1920">1080×1920 (Vertical)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Layout Variant</label>
                  <select
                    value={selectedSlide.layoutVariant}
                    onChange={(e) =>
                      updateSelectedSlide({ layoutVariant: e.target.value as SlideLayoutVariant })
                    }
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  >
                    <option value="hero-center">Hero Center</option>
                    <option value="editorial-split">Editorial Split</option>
                    <option value="stat-focus">Stat Focus</option>
                    <option value="quote-card">Quote Card</option>
                    <option value="minimal-list">Minimal List</option>
                    <option value="cta-end">CTA Closing</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Kicker Label</label>
                  <input
                    type="text"
                    value={selectedSlide.kicker}
                    onChange={(e) => updateSelectedSlide({ kicker: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Text Alignment</label>
                  <select
                    value={selectedSlide.textAlignOverride || theme.typography.alignment}
                    onChange={(e) =>
                      updateSelectedSlide({
                        textAlignOverride: e.target.value as 'left' | 'center' | 'right',
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Highlight Callout</label>
                <input
                  type="text"
                  value={selectedSlide.highlight}
                  onChange={(e) => updateSelectedSlide({ highlight: e.target.value })}
                  placeholder="Optional boxed stat or takeaway"
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                />
              </div>

              <div className="grid grid-cols-3 gap-2 items-end">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Slide BG</label>
                  <input
                    type="color"
                    value={selectedSlide.customBgColor || theme.colors.background}
                    onChange={(e) => updateSelectedSlide({ customBgColor: e.target.value })}
                    className="w-full h-8 rounded bg-[#09090b] border border-zinc-800 p-0.5 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Accent</label>
                  <input
                    type="color"
                    value={selectedSlide.customAccentColor || theme.colors.accent}
                    onChange={(e) => updateSelectedSlide({ customAccentColor: e.target.value })}
                    className="w-full h-8 rounded bg-[#09090b] border border-zinc-800 p-0.5 cursor-pointer"
                  />
                </div>
                <label className="h-8 px-2.5 rounded border border-zinc-700 hover:border-zinc-500 flex items-center justify-center gap-1.5 text-[11px] text-zinc-200 cursor-pointer">
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>Image</span>
                  <input type="file" accept="image/*" onChange={handleSlideImageUpload} className="hidden" />
                </label>
              </div>

              {selectedSlide.imageUrl && (
                <button
                  type="button"
                  onClick={() => updateSelectedSlide({ imageUrl: '' })}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200"
                >
                  Clear custom slide image
                </button>
              )}

              {/* Regenerate Selected Slide Only */}
              <div className="pt-3 border-t border-zinc-800/80 space-y-2">
                <label className="block text-[11px] text-zinc-400">
                  Regenerate Selected Slide Only (AI)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={regenInstruction}
                    onChange={(e) => setRegenInstruction(e.target.value)}
                    placeholder="e.g., Make headline punchier"
                    className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  />
                  <button
                    type="button"
                    disabled={isRegeneratingSlide}
                    onClick={handleRegenerateSelectedSlide}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 inline-flex items-center gap-1.5 shrink-0"
                  >
                    {isRegeneratingSlide ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    <span>Regenerate</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Export & Social Hub Integration Panel */}
          <div className="rounded-xl bg-[#111114] border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                Export & Publish
              </h3>
              {exportProgress && <span className="text-[11px] text-zinc-300">{exportProgress}</span>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isExporting}
                onClick={handleDownloadIndividualPngs}
                className="px-3 py-2.5 rounded-md border border-zinc-700 bg-[#09090b] hover:border-zinc-500 text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>PNG Slides</span>
              </button>
              <button
                type="button"
                disabled={isExporting}
                onClick={handleDownloadZip}
                className="px-3 py-2.5 rounded-md border border-zinc-700 bg-[#09090b] hover:border-zinc-500 text-xs font-medium text-zinc-100 flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Download ZIP</span>
              </button>
            </div>

            <button
              type="button"
              disabled={isExporting}
              onClick={() => handleSaveToMediaLibrary(false)}
              className="w-full py-2.5 px-3 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs font-medium text-zinc-100 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Save All Slides to Media Library</span>
            </button>

            {duplicateConfirmHash && (
              <button
                type="button"
                disabled={isExporting}
                onClick={() => handleSaveToMediaLibrary(true)}
                className="w-full py-2 px-3 rounded-md bg-amber-500/20 border border-amber-500/40 text-xs text-amber-200 flex items-center justify-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Save as New Copy Anyway</span>
              </button>
            )}

            <button
              type="button"
              disabled={isExporting}
              onClick={handleCreateInstagramPost}
              className="w-full py-2.5 px-4 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Create Instagram Post</span>
            </button>

            <button
              type="button"
              disabled={isExporting}
              onClick={() => setShowCalendarModal(true)}
              className="w-full py-2 px-3 rounded-md border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <CalendarPlus className="w-3.5 h-3.5" />
              <span>Add to Content Calendar</span>
            </button>
          </div>
        </div>
      </div>

      {/* Complete Carousel Preview Modal */}
      {showFullPreviewModal && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Full Carousel Preview — {project.title}
                </h3>
                <p className="text-xs text-zinc-400">
                  {fullPreviewUrls.length} ordered slides at {carousel.aspectRatio.replace('x', '×')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFullPreviewModal(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-x-auto flex gap-5">
              {fullPreviewUrls.map((url, i) => (
                <div key={i} className="w-[280px] shrink-0 space-y-2">
                  <div className="text-[11px] font-mono text-zinc-400">
                    Slide {String(i + 1).padStart(2, '0')}
                  </div>
                  <img
                    src={url}
                    alt={`Slide ${i + 1}`}
                    className="w-full rounded-lg border border-zinc-800"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Calendar Quick-Schedule Modal */}
      {showCalendarModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-[#111114] border border-zinc-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Schedule Carousel to Calendar</h3>
              <button
                type="button"
                onClick={() => setShowCalendarModal(false)}
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
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCalendarModal(false)}
                className="px-3.5 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isExporting}
                onClick={handleConfirmScheduleCalendar}
                className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
              >
                {isExporting ? 'Exporting & Scheduling...' : 'Save & Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
