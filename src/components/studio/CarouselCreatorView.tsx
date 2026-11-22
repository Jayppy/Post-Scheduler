import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  FileText,
  Image as ImageIcon,
  Layers,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { aiClient, AiApiError } from '../../services/aiClient';
import { extractTextFromDocument } from '../../services/documentParser';
import { fileToDataUrl } from '../../services/idb';
import { createId } from '../../services/storage';
import {
  CarouselSlide,
  CreativeProject,
  SlideAspectRatio,
  SlideLayoutVariant,
} from '../../types/studio';

const PRESET_SLIDE_COUNTS = [3, 5, 7, 10];

export const CarouselCreatorView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceThemes,
    saveProject,
    setActiveProjectId,
    setStudioSubView,
    notify,
  } = useStudio();

  const [mode, setMode] = useState<'content-first' | 'topic-first'>('content-first');
  const [contentSubMode, setContentSubMode] = useState<'paste' | 'slide-by-slide'>('paste');

  // Common configuration
  const [slideCountChoice, setSlideCountChoice] = useState<number | 'custom'>(5);
  const [customSlideCount, setCustomSlideCount] = useState(6);
  const [selectedThemeId, setSelectedThemeId] = useState<string>(
    activeWorkspace.defaultThemeId || workspaceThemes[0]?.id || 'theme-dark-luxury'
  );
  const [aspectRatio, setAspectRatio] = useState<SlideAspectRatio>('1080x1350');
  const [referenceImages, setReferenceImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const [customLogoUrl, setCustomLogoUrl] = useState<string>(activeWorkspace.logoDataUrl || '');

  // Mode A: Content-first
  const [rawContent, setRawContent] = useState('');
  const [uploadedDocName, setUploadedDocName] = useState('');
  const [designInstructions, setDesignInstructions] = useState('');
  const [manualSlides, setManualSlides] = useState<CarouselSlide[]>([
    {
      id: createId('sl'),
      role: 'cover',
      kicker: '01 · OPENING',
      headline: 'Slide 1 Headline',
      body: 'Introduce the main point clearly.',
      highlight: '',
      layoutVariant: 'hero-center',
    },
    {
      id: createId('sl'),
      role: 'body',
      kicker: '02 · INSIGHT',
      headline: 'Key Breakdown',
      body: 'Explain the primary takeaway with concrete detail.',
      highlight: '',
      layoutVariant: 'editorial-split',
    },
    {
      id: createId('sl'),
      role: 'cta',
      kicker: '03 · NEXT STEP',
      headline: 'Save & Share',
      body: activeWorkspace.defaultOutroText,
      highlight: '',
      layoutVariant: 'cta-end',
    },
  ]);

  // Mode B: Topic-first
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState(
    activeWorkspace.id === 'ws-behind-the-release'
      ? 'Independent artists, self-releasing musicians, and DIY managers'
      : 'Music artists, creative directors, and independent record labels'
  );
  const [objective, setObjective] = useState('Educate, build authority, and drive high-intent saves');
  const [tone, setTone] = useState('Editorial, confident, and practical');
  const [cta, setCta] = useState('Save this breakdown and follow for more');
  const [keywords, setKeywords] = useState('');
  const [referenceMaterial, setReferenceMaterial] = useState('');

  // Draft Review Step
  const [reviewStep, setReviewStep] = useState(false);
  const [projectTitle, setProjectTitle] = useState('');
  const [suggestedCaption, setSuggestedCaption] = useState('');
  const [suggestedHashtags, setSuggestedHashtags] = useState<string[]>([]);
  const [draftSlides, setDraftSlides] = useState<CarouselSlide[]>([]);

  const [isExtractingDoc, setIsExtractingDoc] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiWarning, setAiWarning] = useState<string | null>(null);

  const effectiveSlideCount =
    slideCountChoice === 'custom'
      ? Math.max(2, Math.min(15, Number(customSlideCount) || 5))
      : slideCountChoice;

  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsExtractingDoc(true);
    try {
      const result = await extractTextFromDocument(file);
      setRawContent(result.text);
      setUploadedDocName(file.name);
      notify(
        'success',
        'Document extracted',
        `${file.name} (${result.charCount.toLocaleString()} characters) loaded.`
      );
    } catch (err) {
      notify(
        'error',
        'Document extraction failed',
        err instanceof Error ? err.message : 'Could not read document.'
      );
    } finally {
      setIsExtractingDoc(false);
    }
  };

  const handleRefImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const loaded: Array<{ name: string; dataUrl: string }> = [];
    for (const file of files) {
      const dataUrl = await fileToDataUrl(file);
      loaded.push({ name: file.name, dataUrl });
    }
    setReferenceImages((prev) => [...prev, ...loaded]);
    notify('success', `${loaded.length} reference image(s) added`);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setCustomLogoUrl(dataUrl);
  };

  const buildFallbackSlidesFromContent = (sourceText: string, count: number): CarouselSlide[] => {
    const chunks = sourceText
      .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);
    const slides: CarouselSlide[] = [];
    for (let i = 0; i < count; i++) {
      const chunk = chunks[i] || `Point ${i + 1}: Add your slide content here.`;
      const words = chunk.split(/\s+/);
      const headline = words.slice(0, 7).join(' ');
      const body = words.slice(7).join(' ') || chunk;
      slides.push({
        id: createId('sl'),
        role: i === 0 ? 'cover' : i === count - 1 ? 'cta' : 'body',
        kicker: `${String(i + 1).padStart(2, '0')} · ${i === 0 ? 'OVERVIEW' : i === count - 1 ? 'TAKEAWAY' : 'BREAKDOWN'}`,
        headline,
        body,
        highlight: '',
        layoutVariant: i === 0 ? 'hero-center' : i === count - 1 ? 'cta-end' : 'editorial-split',
        imageUrl: referenceImages[i % Math.max(1, referenceImages.length)]?.dataUrl,
      });
    }
    return slides;
  };

  const handleGenerateOutline = async () => {
    setAiWarning(null);

    if (mode === 'content-first' && contentSubMode === 'slide-by-slide') {
      setProjectTitle(manualSlides[0]?.headline || `${activeWorkspace.name} Carousel`);
      setDraftSlides(
        manualSlides.map((s, idx) => ({
          ...s,
          imageUrl: s.imageUrl || referenceImages[idx]?.dataUrl,
        }))
      );
      setReviewStep(true);
      return;
    }

    if (mode === 'content-first' && !rawContent.trim()) {
      notify('warning', 'Paste content or upload a document first.');
      return;
    }

    if (mode === 'topic-first' && !topic.trim()) {
      notify('warning', 'Enter a carousel topic first.');
      return;
    }

    setIsGenerating(true);
    try {
      const res =
        mode === 'content-first'
          ? await aiClient.structureContentCarousel({
              content: rawContent,
              slideCount: effectiveSlideCount,
              designInstructions,
              workspaceName: activeWorkspace.name,
              brandVoice: activeWorkspace.brandVoice,
            })
          : await aiClient.generateTopicCarousel({
              topic,
              audience,
              objective,
              tone,
              slideCount: effectiveSlideCount,
              cta,
              keywords,
              referenceMaterial,
              workspaceName: activeWorkspace.name,
              brandVoice: activeWorkspace.brandVoice,
            });

      const mappedSlides: CarouselSlide[] = (res.slides || []).map((s, idx) => ({
        id: createId('sl'),
        role: s.role || (idx === 0 ? 'cover' : 'body'),
        kicker: s.kicker || `${String(idx + 1).padStart(2, '0')} · SLIDE`,
        headline: s.headline,
        body: s.body,
        highlight: s.highlight || '',
        layoutVariant: (s.layoutVariant as SlideLayoutVariant) || 'editorial-split',
        imageUrl: referenceImages[idx]?.dataUrl,
      }));

      setProjectTitle(res.projectTitle || topic || `${activeWorkspace.name} Carousel`);
      setSuggestedCaption(res.suggestedCaption || '');
      setSuggestedHashtags(res.hashtags || []);
      setDraftSlides(mappedSlides);
      setReviewStep(true);
    } catch (err) {
      const msg =
        err instanceof AiApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Gemini generation unavailable.';
      setAiWarning(msg);
      notify('warning', 'AI unavailable — manual outline ready', msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleManualBypassToReview = () => {
    if (mode === 'content-first' && rawContent.trim()) {
      const built = buildFallbackSlidesFromContent(rawContent, effectiveSlideCount);
      setProjectTitle(built[0]?.headline || `${activeWorkspace.name} Carousel`);
      setDraftSlides(built);
    } else {
      const built: CarouselSlide[] = Array.from({ length: effectiveSlideCount }).map((_, idx) => ({
        id: createId('sl'),
        role: idx === 0 ? 'cover' : idx === effectiveSlideCount - 1 ? 'cta' : 'body',
        kicker: `${String(idx + 1).padStart(2, '0')} · SECTION`,
        headline: idx === 0 ? topic || 'Cover Headline' : `Key Point ${idx + 1}`,
        body: idx === effectiveSlideCount - 1 ? cta || activeWorkspace.defaultOutroText : 'Write your clear insight here.',
        highlight: '',
        layoutVariant: idx === 0 ? 'hero-center' : idx === effectiveSlideCount - 1 ? 'cta-end' : 'editorial-split',
        imageUrl: referenceImages[idx]?.dataUrl,
      }));
      setProjectTitle(topic || `${activeWorkspace.name} Carousel`);
      setDraftSlides(built);
    }
    setReviewStep(true);
  };

  const updateDraftSlide = (id: string, patch: Partial<CarouselSlide>) => {
    setDraftSlides((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const moveDraftSlide = (index: number, dir: -1 | 1) => {
    const next = [...draftSlides];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraftSlides(next);
  };

  const duplicateDraftSlide = (index: number) => {
    const orig = draftSlides[index];
    const copy: CarouselSlide = { ...orig, id: createId('sl') };
    const next = [...draftSlides];
    next.splice(index + 1, 0, copy);
    setDraftSlides(next);
  };

  const deleteDraftSlide = (id: string) => {
    if (draftSlides.length <= 1) return;
    setDraftSlides((prev) => prev.filter((s) => s.id !== id));
  };

  const addDraftSlide = () => {
    setDraftSlides((prev) => [
      ...prev,
      {
        id: createId('sl'),
        role: 'body',
        kicker: `${String(prev.length + 1).padStart(2, '0')} · POINT`,
        headline: 'New Slide Headline',
        body: 'Add concise supporting copy here.',
        highlight: '',
        layoutVariant: 'editorial-split',
      },
    ]);
  };

  const handleProceedToVisualEditor = () => {
    if (draftSlides.length === 0) return;
    const now = new Date().toISOString();
    const project: CreativeProject = {
      id: createId('proj'),
      workspaceId: activeWorkspace.id,
      title: projectTitle.trim() || `${activeWorkspace.name} Carousel`,
      type: 'carousel',
      themeId: selectedThemeId,
      status: 'draft',
      carouselState: {
        mode,
        aspectRatio,
        slides: draftSlides,
        selectedSlideId: draftSlides[0].id,
        rawContentInput: rawContent,
        uploadedDocName,
        designInstructions,
        topicConfig:
          mode === 'topic-first'
            ? {
                topic,
                audience,
                objective,
                tone,
                slideCount: effectiveSlideCount,
                cta,
                keywords,
                referenceMaterial,
              }
            : undefined,
        suggestedCaption,
        suggestedHashtags,
        brandLogoUrl: customLogoUrl || undefined,
      },
      createdAt: now,
      updatedAt: now,
    };
    saveProject(project);
    setActiveProjectId(project.id);
    setStudioSubView('carousel-editor');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>AI Carousel Creator</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">
            {reviewStep ? 'Review & Edit Slide Outline' : 'Create Carousel Production'}
          </h1>
        </div>

        {!reviewStep ? (
          <div className="inline-flex p-1 rounded-lg bg-[#141418] border border-zinc-800">
            <button
              type="button"
              onClick={() => setMode('content-first')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mode === 'content-first' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Mode A: Content-First
            </button>
            <button
              type="button"
              onClick={() => setMode('topic-first')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                mode === 'topic-first' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Mode B: Topic-First
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setReviewStep(false)}
              className="px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-300 hover:text-white"
            >
              Back to Brief
            </button>
            <button
              type="button"
              onClick={handleProceedToVisualEditor}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
            >
              <span>Open Visual Carousel Editor</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {aiWarning && (
        <div className="p-4 rounded-lg border border-amber-500/40 bg-amber-950/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Gemini Service Notice</div>
              <div className="text-amber-300/80 mt-0.5">{aiWarning}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleManualBypassToReview}
            className="px-3.5 py-2 rounded-md bg-amber-200 text-zinc-950 text-xs font-semibold shrink-0"
          >
            Continue Manually Without AI
          </button>
        </div>
      )}

      {!reviewStep ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 Columns: Content / Topic Input */}
          <div className="lg:col-span-2 space-y-6">
            {mode === 'content-first' ? (
              <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">Supply Your Carousel Content</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Gemini preserves your exact meaning and organizes it cleanly across slides.
                    </p>
                  </div>
                  <div className="inline-flex p-1 rounded-md bg-[#09090b] border border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setContentSubMode('paste')}
                      className={`px-3 py-1 rounded text-xs font-medium ${
                        contentSubMode === 'paste' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
                      }`}
                    >
                      Paste / Document
                    </button>
                    <button
                      type="button"
                      onClick={() => setContentSubMode('slide-by-slide')}
                      className={`px-3 py-1 rounded text-xs font-medium ${
                        contentSubMode === 'slide-by-slide' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
                      }`}
                    >
                      Slide-by-Slide Entry
                    </button>
                  </div>
                </div>

                {contentSubMode === 'paste' ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-zinc-700 bg-[#09090b] hover:border-zinc-500 text-xs text-zinc-200 cursor-pointer">
                        {isExtractingDoc ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                        <span>Upload TXT, PDF, or DOCX</span>
                        <input
                          type="file"
                          accept=".txt,.md,.pdf,.docx"
                          onChange={handleDocumentUpload}
                          className="hidden"
                        />
                      </label>
                      {uploadedDocName && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
                          <FileText className="w-3.5 h-3.5 text-zinc-400" />
                          <span>{uploadedDocName}</span>
                        </span>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                        Complete Carousel Content
                      </label>
                      <textarea
                        rows={10}
                        value={rawContent}
                        onChange={(e) => setRawContent(e.target.value)}
                        placeholder="Paste your article notes, release strategy breakdown, artist manifesto, or extracted document text here..."
                        className="w-full px-3.5 py-3 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                        Design & Pacing Instructions (Optional)
                      </label>
                      <input
                        type="text"
                        value={designInstructions}
                        onChange={(e) => setDesignInstructions(e.target.value)}
                        placeholder="e.g., Keep slide 1 minimal, emphasize numeric stats on slide 3..."
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-600"
                      />
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    {manualSlides.map((s, idx) => (
                      <div key={s.id} className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono text-zinc-400">
                            Slide {String(idx + 1).padStart(2, '0')}
                          </span>
                          {manualSlides.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setManualSlides((prev) => prev.filter((item) => item.id !== s.id))
                              }
                              className="text-xs text-zinc-500 hover:text-red-400"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={s.headline}
                          onChange={(e) =>
                            setManualSlides((prev) =>
                              prev.map((item) =>
                                item.id === s.id ? { ...item, headline: e.target.value } : item
                              )
                            )
                          }
                          placeholder="Slide Headline"
                          className="w-full px-3 py-2 rounded bg-[#141418] border border-zinc-800 text-xs font-semibold text-zinc-100"
                        />
                        <textarea
                          rows={2}
                          value={s.body}
                          onChange={(e) =>
                            setManualSlides((prev) =>
                              prev.map((item) =>
                                item.id === s.id ? { ...item, body: e.target.value } : item
                              )
                            )
                          }
                          placeholder="Slide Body Copy"
                          className="w-full px-3 py-2 rounded bg-[#141418] border border-zinc-800 text-xs text-zinc-200"
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setManualSlides((prev) => [
                          ...prev,
                          {
                            id: createId('sl'),
                            role: 'body',
                            kicker: `${String(prev.length + 1).padStart(2, '0')} · SLIDE`,
                            headline: '',
                            body: '',
                            highlight: '',
                            layoutVariant: 'editorial-split',
                          },
                        ])
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Slide</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Topic-First Carousel Brief</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Gemini develops a sharp narrative sequence with zero filler—and lets you edit before design.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Topic</label>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g., How Independent Artists Build Press Kits That Labels Actually Read"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Target Audience</label>
                    <input
                      type="text"
                      value={audience}
                      onChange={(e) => setAudience(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Preferred Tone</label>
                    <input
                      type="text"
                      value={tone}
                      onChange={(e) => setTone(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Main Objective</label>
                    <input
                      type="text"
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">Closing Call to Action</label>
                    <input
                      type="text"
                      value={cta}
                      onChange={(e) => setCta(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Relevant Keywords (Optional)
                  </label>
                  <input
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="e.g., EPK, sync licensing, editorial pitching, release timeline"
                    className="w-full px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Optional Reference Material
                  </label>
                  <textarea
                    rows={4}
                    value={referenceMaterial}
                    onChange={(e) => setReferenceMaterial(e.target.value)}
                    placeholder="Paste any stats, quotes, or studio case-study facts you want included..."
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-600"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Slide Count, Theme, Reference Media & Generate */}
          <div className="space-y-5">
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
              <div>
                <label className="block text-xs font-semibold text-zinc-200 mb-2">Slide Count</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {PRESET_SLIDE_COUNTS.map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setSlideCountChoice(cnt)}
                      className={`py-2 rounded-md text-xs font-mono font-semibold border transition-colors ${
                        slideCountChoice === cnt
                          ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
                          : 'bg-[#09090b] text-zinc-300 border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      {cnt}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSlideCountChoice('custom')}
                    className={`py-2 rounded-md text-xs font-medium border transition-colors ${
                      slideCountChoice === 'custom'
                        ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
                        : 'bg-[#09090b] text-zinc-300 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {slideCountChoice === 'custom' && (
                  <input
                    type="number"
                    min={2}
                    max={15}
                    value={customSlideCount}
                    onChange={(e) => setCustomSlideCount(Number(e.target.value))}
                    className="mt-2 w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-100"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-200 mb-2">Canvas Dimensions</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['1080x1350', '1080x1080', '1080x1920'] as SlideAspectRatio[]).map((ar) => (
                    <button
                      key={ar}
                      type="button"
                      onClick={() => setAspectRatio(ar)}
                      className={`py-2 px-2 rounded-md text-[11px] font-mono border transition-colors ${
                        aspectRatio === ar
                          ? 'bg-zinc-100 text-zinc-950 border-zinc-100 font-semibold'
                          : 'bg-[#09090b] text-zinc-300 border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      {ar.replace('x', '×')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-200 mb-2">Design Theme</label>
                <select
                  value={selectedThemeId}
                  onChange={(e) => setSelectedThemeId(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {workspaceThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.category})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-200 mb-2">
                  Reference Images & Brand Logo
                </label>
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-800 bg-[#09090b] hover:border-zinc-600 text-xs text-zinc-300 cursor-pointer">
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>Add Images ({referenceImages.length})</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleRefImageUpload}
                      className="hidden"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-800 bg-[#09090b] hover:border-zinc-600 text-xs text-zinc-300 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{customLogoUrl ? 'Logo Loaded' : 'Brand Logo'}</span>
                    <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                  </label>
                </div>
              </div>

              <div className="pt-2 space-y-2.5">
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={handleGenerateOutline}
                  className="w-full py-2.5 px-4 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-60 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Structuring Carousel...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>
                        {mode === 'content-first' && contentSubMode === 'slide-by-slide'
                          ? 'Review Slide Deck'
                          : 'Generate Carousel Outline'}
                      </span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleManualBypassToReview}
                  className="w-full py-2 px-4 rounded-md border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center justify-center gap-2 transition-colors"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Build Manually Without AI</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Review & Edit Outline Before Opening Visual Editor */
        <div className="space-y-5">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Project Title</label>
              <input
                type="text"
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                className="w-full px-3.5 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-sm font-semibold text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Design Theme</label>
              <select
                value={selectedThemeId}
                onChange={(e) => setSelectedThemeId(e.target.value)}
                className="w-full px-3.5 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                {workspaceThemes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-3">
            {draftSlides.map((slide, idx) => (
              <div
                key={slide.id}
                className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-semibold text-zinc-300">
                      SLIDE {String(idx + 1).padStart(2, '0')}
                    </span>
                    <select
                      value={slide.layoutVariant}
                      onChange={(e) =>
                        updateDraftSlide(slide.id, {
                          layoutVariant: e.target.value as SlideLayoutVariant,
                        })
                      }
                      className="px-2.5 py-1 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-300"
                    >
                      <option value="hero-center">Hero Center</option>
                      <option value="editorial-split">Editorial Split</option>
                      <option value="stat-focus">Stat Focus</option>
                      <option value="quote-card">Quote Card</option>
                      <option value="minimal-list">Minimal List</option>
                      <option value="cta-end">CTA Closing</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => moveDraftSlide(idx, -1)}
                      disabled={idx === 0}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                      title="Move up"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDraftSlide(idx, 1)}
                      disabled={idx === draftSlides.length - 1}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                      title="Move down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateDraftSlide(idx)}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100"
                      title="Duplicate slide"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteDraftSlide(slide.id)}
                      disabled={draftSlides.length <= 1}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-red-400 disabled:opacity-30"
                      title="Delete slide"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] text-zinc-500 mb-1">Kicker</label>
                    <input
                      type="text"
                      value={slide.kicker}
                      onChange={(e) => updateDraftSlide(slide.id, { kicker: e.target.value })}
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[11px] text-zinc-500 mb-1">Headline</label>
                    <input
                      type="text"
                      value={slide.headline}
                      onChange={(e) => updateDraftSlide(slide.id, { headline: e.target.value })}
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs font-semibold text-zinc-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] text-zinc-500 mb-1">Body Copy</label>
                    <textarea
                      rows={2}
                      value={slide.body}
                      onChange={(e) => updateDraftSlide(slide.id, { body: e.target.value })}
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-zinc-500 mb-1">Highlight Callout (Optional)</label>
                    <input
                      type="text"
                      value={slide.highlight}
                      onChange={(e) => updateDraftSlide(slide.id, { highlight: e.target.value })}
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={addDraftSlide}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Another Slide</span>
            </button>

            <button
              type="button"
              onClick={handleProceedToVisualEditor}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
            >
              <span>Proceed to Visual Carousel Editor</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
