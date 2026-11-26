import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Globe2,
  Library,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import { marketingClient, type MarketingIntegrationsResponse } from '../../services/marketingClient';
import {
  deleteMarketingDraftFromFirestore,
  syncMarketingDraftToFirestore,
  syncMarketingProfileToFirestore,
  syncResearchSourcesToFirestore,
} from '../../services/firebaseClient';
import type {
  AwarenessStage,
  BlogArticleOutput,
  BusinessKnowledgeBase,
  ContentCategory15,
  DataClassification,
  GenerateMarketingContentInput,
  MarketingDraft,
  ResearchCategory,
  ResearchSourceRecord,
  TargetAudienceSegment,
  TopicOpportunity,
  VerifiedProofItem,
} from '../../types/marketing';
import type { MarketingSubView } from '../../types/studio';
import { ResearchEvidencePanel } from './ResearchEvidencePanel';

const AUDIENCE_SEGMENTS: TargetAudienceSegment[] = [
  'Independent recording artists',
  'Established recording artists',
  'Music producers',
  'Beatmakers',
  'Songwriters',
  'Independent music entrepreneurs',
  'Record labels',
  'Music managers',
  'Artist development teams',
  'Music businesses',
];

const AWARENESS_STAGES: AwarenessStage[] = [
  'Unaware',
  'Problem Aware',
  'Solution Aware',
  'Product / Studio Aware',
  'Most Aware / Decision Ready',
];

const CONTENT_CATEGORIES_15: ContentCategory15[] = [
  'Problem awareness',
  'Industry education',
  'Expert authority',
  'Myth correction',
  'Common mistakes',
  'Buyer objection handling',
  'Service education',
  'Case-study storytelling',
  'Industry trend analysis',
  'Customer transformation',
  'Service comparison and differentiation',
  'Lead generation',
  'Purchase-intent content',
  'Brand positioning',
  'Conversion-focused content',
];

const RESEARCH_CATEGORIES: Array<{ id: ResearchCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All Categories' },
  { id: 'industry-report', label: 'Industry Reports' },
  { id: 'charts-discovery', label: 'Charts & Discovery' },
  { id: 'audience-insight', label: 'Audience Insights' },
  { id: 'buyer-objection', label: 'Buyer Objections' },
  { id: 'platform-trend', label: 'Platform Trends' },
];

const SUB_TABS: Array<{ id: MarketingSubView; label: string }> = [
  { id: 'dashboard', label: 'Marketing Dashboard' },
  { id: 'research', label: 'Research Intelligence' },
  { id: 'generate', label: 'Generate Content' },
  { id: 'editor', label: 'Cross-Platform Editor' },
  { id: 'library', label: 'Content Library' },
  { id: 'knowledge-base', label: '74 STUDIO Profile' },
];

function countWords(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

export const MarketingStudioView: React.FC = () => {
  const { marketingSubView, setMarketingSubView, notify } = useStudio();
  const { user } = useFirebase();

  const addToast = useCallback(
    (t: { tone: 'info' | 'success' | 'warning' | 'error'; title: string; detail?: string }) =>
      notify(t.tone, t.title, t.detail),
    [notify]
  );

  const [loading, setLoading] = useState(true);
  const [kb, setKb] = useState<BusinessKnowledgeBase | null>(null);
  const [researchSources, setResearchSources] = useState<ResearchSourceRecord[]>([]);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [lastLiveResearchAt, setLastLiveResearchAt] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<MarketingDraft[]>([]);
  const [integrationsInfo, setIntegrationsInfo] = useState<MarketingIntegrationsResponse | null>(null);

  // Generator state
  const [genForm, setGenForm] = useState<GenerateMarketingContentInput>({
    targetAudience: 'Independent recording artists',
    serviceOffer: 'Music Videos (AI-Assisted, 3D & 2D Animated)',
    objective: 'Educate buyers and drive qualified 74 STUDIO project enquiries',
    awarenessStage: 'Problem Aware',
    contentCategory: 'Buyer objection handling',
    topic: 'Why Treating Spotify Canvas & Release Visuals as an Afterthought Weakens First-Week Momentum',
    tone: 'Credible, music-industry literate, practical authority',
    ctaObjective: 'Scope your next release visual package via 74-studio.com or inquire@74-studio.com',
    researchDepth: 'standard',
    xTargetChars: 50,
    blogWordTarget: 1100,
    selectedSourceIds: [],
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDiscoveringTopics, setIsDiscoveringTopics] = useState(false);

  // Active editor draft (either unsaved generation or loaded saved draft)
  const [activeDraft, setActiveDraft] = useState<MarketingDraft | null>(null);
  const [regenPlatform, setRegenPlatform] = useState<'linkedin' | 'x' | 'threads' | 'blog' | null>(null);
  const [regenNotes, setRegenNotes] = useState<{
    linkedin: string;
    x: string;
    threads: string;
    blog: string;
  }>({ linkedin: '', x: '', threads: '', blog: '' });
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [blogPreviewMode, setBlogPreviewMode] = useState(false);
  const [streamingBlogManifest, setStreamingBlogManifest] = useState(false);
  const [resumingBlogManifest, setResumingBlogManifest] = useState(false);

  // Research state
  const [researchFilter, setResearchFilter] = useState<ResearchCategory | 'all'>('all');
  const [researchSearch, setResearchSearch] = useState('');
  const [scanQuery, setScanQuery] = useState('');
  const [scanCategory, setScanCategory] = useState<ResearchCategory>('industry-report');
  const [isScanningLive, setIsScanningLive] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState<{
    sourceName: string;
    sourceUrl: string;
    category: ResearchCategory;
    dataClassification: DataClassification;
    publicationDate: string;
    primaryOrSecondary: 'primary' | 'secondary';
    confidence: 'high' | 'medium' | 'low';
    usageRestrictions: string;
    finding: string;
    implications: string;
    tagsText: string;
  }>({
    sourceName: '',
    sourceUrl: 'https://74-studio.com',
    category: 'audience-insight',
    dataClassification: 'verified-fact',
    publicationDate: new Date().toISOString().slice(0, 10),
    primaryOrSecondary: 'primary',
    confidence: 'high',
    usageRestrictions: 'Owner-verified source',
    finding: '',
    implications: '',
    tagsText: '',
  });

  // Library filters
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryCategory, setLibraryCategory] = useState<string>('all');
  const [libraryStatus, setLibraryStatus] = useState<string>('all');

  // Knowledge Base editor states
  const [isSavingKb, setIsSavingKb] = useState(false);
  const [newProof, setNewProof] = useState<Omit<VerifiedProofItem, 'id'>>({
    title: '',
    clientOrProject: '',
    summary: '',
    sourceNote: '',
  });
  const [newKnownUrl, setNewKnownUrl] = useState({ label: '', url: '' });

  const loadAllMarketingData = useCallback(async () => {
    setLoading(true);
    try {
      const [kbRes, resRes, draftsRes, intRes] = await Promise.all([
        marketingClient.getKnowledgeBase(),
        marketingClient.getResearch(),
        marketingClient.listDrafts(),
        marketingClient.getIntegrations(),
      ]);
      setKb(kbRes);
      setResearchSources(resRes.sources || []);
      setOpportunities(resRes.opportunities || []);
      setLastLiveResearchAt(resRes.lastLiveResearchAt);
      setDrafts(draftsRes || []);
      setIntegrationsInfo(intRes);
      if (kbRes.services.length > 0) {
        setGenForm((prev) => ({
          ...prev,
          serviceOffer: kbRes.services.some((s) => s.name === prev.serviceOffer)
            ? prev.serviceOffer
            : kbRes.services[0].name,
        }));
      }
      if (!activeDraft && draftsRes.length > 0) {
        setActiveDraft(draftsRes[0]);
      }
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Marketing Studio load failed',
        detail: err instanceof Error ? err.message : 'Unable to reach backend marketing API.',
      });
    } finally {
      setLoading(false);
    }
  }, [addToast, activeDraft]);

  useEffect(() => {
    void loadAllMarketingData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyToClipboard = async (key: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
      addToast({ tone: 'success', title: `Copied ${label}`, detail: 'Ready to paste manually.' });
    } catch {
      addToast({ tone: 'error', title: 'Copy failed', detail: 'Clipboard access blocked by browser.' });
    }
  };

  const applyOpportunityToGenerator = (opp: TopicOpportunity) => {
    setGenForm((prev) => ({
      ...prev,
      targetAudience: opp.targetAudience,
      serviceOffer: opp.serviceOffer,
      awarenessStage: opp.awarenessStage,
      contentCategory: opp.contentCategory,
      topic: opp.topic,
      objective: opp.strategicObjective,
      selectedSourceIds: opp.supportingSourceIds || [],
    }));
    setMarketingSubView('generate');
  };

  const handleDiscoverTopics = async () => {
    setIsDiscoveringTopics(true);
    try {
      const res = await marketingClient.discoverTopics({
        targetAudience: genForm.targetAudience,
        serviceOffer: genForm.serviceOffer,
        contentCategory: genForm.contentCategory,
      });
      setOpportunities(res.opportunities || []);
      addToast({
        tone: res.fallback ? 'info' : 'success',
        title: res.fallback ? 'Loaded Baseline Opportunities' : 'Topic Opportunities Refreshed',
        detail: res.fallback
          ? 'Gemini API key unavailable locally; showing verified baseline strategy opportunities.'
          : `Discovered ${(res.opportunities || []).length} targeted marketing topic opportunities.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Topic discovery failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsDiscoveringTopics(false);
    }
  };

  const handleGenerateContent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genForm.topic.trim()) {
      addToast({ tone: 'warning', title: 'Topic required', detail: 'Enter a topic or pick one from Discover Topics.' });
      return;
    }
    setIsGenerating(true);
    try {
      const result = await marketingClient.generateCrossPlatformContent(genForm);
      const nowIso = new Date().toISOString();
      const newDraft: MarketingDraft = {
        id: `mdraft-${Date.now().toString(36)}`,
        title: result.title || genForm.topic,
        status: 'draft',
        targetAudience: genForm.targetAudience,
        serviceOffer: genForm.serviceOffer,
        objective: genForm.objective,
        awarenessStage: genForm.awarenessStage,
        contentCategory: genForm.contentCategory,
        topic: genForm.topic,
        tone: genForm.tone,
        ctaObjective: genForm.ctaObjective,
        researchDepth: genForm.researchDepth,
        xTargetChars: Number(genForm.xTargetChars) || 50,
        blogWordTarget: Number(genForm.blogWordTarget) || 1100,
        centralConcept: result.centralConcept,
        platforms: result.platforms,
        evidenceClaims: result.evidenceClaims || [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setActiveDraft(newDraft);
      setMarketingSubView('editor');
      addToast({
        tone: result.fallbackMode ? 'warning' : 'success',
        title: result.fallbackMode ? 'Structured Draft Created (Offline Fallback)' : '4-Platform Concept Generated',
        detail: result.fallbackMode
          ? 'GEMINI_API_KEY not configured in runtime secrets; review & edit this grounded baseline draft.'
          : 'LinkedIn, X (ultra-short + expanded), Threads, and 74-studio.com Blog ready for review.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Generation failed',
        detail: err instanceof Error ? err.message : 'Failed to generate campaign content.',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegenerateSinglePlatform = async (platform: 'linkedin' | 'x' | 'threads' | 'blog') => {
    if (!activeDraft) return;
    setRegenPlatform(platform);
    try {
      const res = await marketingClient.regeneratePlatform({
        platform,
        centralConcept: activeDraft.centralConcept,
        evidenceClaims: activeDraft.evidenceClaims,
        tone: activeDraft.tone,
        xTargetChars: activeDraft.xTargetChars,
        blogWordTarget: activeDraft.blogWordTarget,
        instruction: regenNotes[platform] || undefined,
      });

      setActiveDraft((prev) => {
        if (!prev) return prev;
        if (platform === 'linkedin' && typeof res.data === 'string') {
          return { ...prev, platforms: { ...prev.platforms, linkedin: res.data } };
        }
        if (platform === 'threads' && typeof res.data === 'string') {
          return { ...prev, platforms: { ...prev.platforms, threads: res.data } };
        }
        if (platform === 'x' && res.data && typeof res.data === 'object') {
          const xData = res.data as MarketingDraft['platforms']['x'];
          return {
            ...prev,
            platforms: {
              ...prev.platforms,
              x: {
                ultraShort: xData.ultraShort ?? prev.platforms.x.ultraShort,
                expanded: xData.expanded ?? prev.platforms.x.expanded,
                targetShortChars: prev.xTargetChars,
              },
            },
          };
        }
        if (platform === 'blog' && res.data && typeof res.data === 'object') {
          return {
            ...prev,
            platforms: {
              ...prev.platforms,
              blog: res.data as BlogArticleOutput,
            },
          };
        }
        return prev;
      });
      addToast({
        tone: 'success',
        title: `Regenerated ${platform.toUpperCase()}`,
        detail: 'Central content concept remained locked and unchanged.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: `Regenerate ${platform} failed`,
        detail: err instanceof Error ? err.message : 'GEMINI_API_KEY required or network error.',
      });
    } finally {
      setRegenPlatform(null);
    }
  };

  const handleStreamBlogSections = async () => {
    if (!activeDraft) return;
    setStreamingBlogManifest(true);
    try {
      const outline =
        activeDraft.platforms.blog.h2Outline.length > 0
          ? activeDraft.platforms.blog.h2Outline
          : [
              'Why This Matters for Your Next Release',
              'Common Mistakes Artists & Teams Make',
              'How 74 STUDIO Approaches Visual Execution',
              'Practical Next Steps for Your Release',
            ];
      const res = await marketingClient.streamBlogManifest(
        {
          title: activeDraft.platforms.blog.seoTitle || activeDraft.title,
          centralConcept: activeDraft.centralConcept,
          h2Outline: outline,
          evidenceClaims: activeDraft.evidenceClaims,
          blogWordTarget: activeDraft.blogWordTarget,
          instruction: regenNotes.blog || undefined,
        },
        {
          onManifest: (manifest) => {
            setActiveDraft((prev) =>
              prev
                ? {
                    ...prev,
                    platforms: {
                      ...prev.platforms,
                      blog: { ...prev.platforms.blog, blogManifest: manifest },
                    },
                  }
                : prev
            );
          },
          onFallback: (fromP, toP, reason) => {
            addToast({ tone: 'warning', title: `Switched ${fromP} -> ${toP}`, detail: reason });
          },
        }
      );

      setActiveDraft((prev) =>
        prev
          ? {
              ...prev,
              platforms: {
                ...prev.platforms,
                blog: {
                  ...prev.platforms.blog,
                  bodyMarkdown: res.bodyMarkdown,
                  blogManifest: res.manifest,
                },
              },
            }
          : prev
      );
      addToast({
        tone: res.manifest.status === 'incomplete' ? 'warning' : 'success',
        title:
          res.manifest.status === 'incomplete'
            ? 'Long-Form Blog Partially Streamed'
            : 'Long-Form Blog Verified Complete',
        detail: `${res.manifest.completedSections}/${res.manifest.totalExpectedSections} sections · ${res.providerId.toUpperCase()}`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Blog SSE streaming failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setStreamingBlogManifest(false);
    }
  };

  const handleResumeIncompleteBlogSections = async () => {
    if (!activeDraft?.platforms.blog.blogManifest) return;
    setResumingBlogManifest(true);
    try {
      const res = await marketingClient.continueBlogManifest({
        title: activeDraft.platforms.blog.seoTitle || activeDraft.title,
        centralConcept: activeDraft.centralConcept,
        manifest: activeDraft.platforms.blog.blogManifest,
        evidenceClaims: activeDraft.evidenceClaims,
        blogWordTarget: activeDraft.blogWordTarget,
      });
      setActiveDraft((prev) =>
        prev
          ? {
              ...prev,
              platforms: {
                ...prev.platforms,
                blog: {
                  ...prev.platforms.blog,
                  bodyMarkdown: res.bodyMarkdown,
                  blogManifest: res.manifest,
                },
              },
            }
          : prev
      );
      addToast({
        tone: 'success',
        title: 'Incomplete Sections Resumed',
        detail: `${res.manifest.completedSections}/${res.manifest.totalExpectedSections} sections verified without duplicating headings.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Resume failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setResumingBlogManifest(false);
    }
  };

  const handleSaveDraft = async (draftToSave?: MarketingDraft) => {
    const target = draftToSave || activeDraft;
    if (!target) return;
    setIsSavingDraft(true);
    try {
      const saved = await marketingClient.saveDraft(target);
      setActiveDraft(saved);
      setDrafts((prev) => {
        const exists = prev.some((d) => d.id === saved.id);
        return exists ? prev.map((d) => (d.id === saved.id ? saved : d)) : [saved, ...prev];
      });
      if (user && user.emailVerified) {
        await syncMarketingDraftToFirestore(user, saved).catch(() => {});
      }
      addToast({
        tone: 'success',
        title: 'Saved to Content Library',
        detail: `"${saved.title}" saved cleanly inside Marketing Content Studio.`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Save failed',
        detail: err instanceof Error ? err.message : 'Unable to save marketing draft.',
      });
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleDeleteDraft = async (id: string) => {
    try {
      await marketingClient.deleteDraft(id);
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      if (activeDraft?.id === id) setActiveDraft(null);
      if (user && user.emailVerified) {
        await deleteMarketingDraftFromFirestore(user, id).catch(() => {});
      }
      addToast({ tone: 'info', title: 'Draft deleted' });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Delete failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handleRunLiveResearchScan = async (forceRefresh = false) => {
    setIsScanningLive(true);
    try {
      const res = await marketingClient.runLiveResearchScan({
        focusQuery: scanQuery,
        category: scanCategory,
        forceRefresh,
      });
      setResearchSources(res.sources || []);
      setLastLiveResearchAt(res.lastLiveResearchAt);
      if (user && user.emailVerified && res.addedSources?.length > 0) {
        await syncResearchSourcesToFirestore(user, res.addedSources).catch(() => {});
      }
      addToast({
        tone: res.cached ? 'info' : 'success',
        title: res.cached ? 'Returned Cached Live Scan' : 'Live Grounded Research Complete',
        detail: res.cached
          ? 'Recent scan reused (enable Force Refresh or enter a specific query to run immediately).'
          : `Added ${res.addedSources?.length || 0} grounded research source(s).`,
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Live scan unavailable',
        detail: err instanceof Error ? err.message : 'Could not run grounded web research.',
      });
    } finally {
      setIsScanningLive(false);
    }
  };

  const handleAddOwnerSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSource.sourceName.trim() || !newSource.finding.trim()) {
      addToast({ tone: 'warning', title: 'Missing fields', detail: 'Source name and finding are required.' });
      return;
    }
    try {
      const created = await marketingClient.addResearchSource({
        ...newSource,
        accessMethod: 'owner-supplied',
        tags: newSource.tagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setResearchSources((prev) => [created, ...prev]);
      if (user && user.emailVerified) {
        await syncResearchSourcesToFirestore(user, [created]).catch(() => {});
      }
      setShowAddSource(false);
      setNewSource((prev) => ({ ...prev, sourceName: '', finding: '', implications: '', tagsText: '' }));
      addToast({ tone: 'success', title: 'Owner-Supplied Source Added' });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Could not save source',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handleDeleteResearchSource = async (id: string) => {
    try {
      await marketingClient.deleteResearchSource(id);
      setResearchSources((prev) => prev.filter((s) => s.id !== id));
      addToast({ tone: 'info', title: 'Research source removed' });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Delete failed',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handleSaveKnowledgeBase = async () => {
    if (!kb) return;
    setIsSavingKb(true);
    try {
      const saved = await marketingClient.saveKnowledgeBase(kb);
      setKb(saved);
      if (user && user.emailVerified) {
        await syncMarketingProfileToFirestore(user, saved).catch(() => {});
      }
      addToast({
        tone: 'success',
        title: '74 STUDIO Knowledge Base Saved',
        detail: 'All future generations will ground directly against this verified profile.',
      });
    } catch (err) {
      addToast({
        tone: 'error',
        title: 'Save failed',
        detail: err instanceof Error ? err.message : 'Could not update knowledge base.',
      });
    } finally {
      setIsSavingKb(false);
    }
  };

  const filteredResearch = useMemo(() => {
    return researchSources.filter((src) => {
      if (researchFilter !== 'all' && src.category !== researchFilter) return false;
      if (researchSearch.trim()) {
        const q = researchSearch.toLowerCase();
        return (
          src.sourceName.toLowerCase().includes(q) ||
          src.finding.toLowerCase().includes(q) ||
          src.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [researchSources, researchFilter, researchSearch]);

  const filteredDrafts = useMemo(() => {
    return drafts.filter((d) => {
      if (libraryCategory !== 'all' && d.contentCategory !== libraryCategory) return false;
      if (libraryStatus !== 'all' && d.status !== libraryStatus) return false;
      if (librarySearch.trim()) {
        const q = librarySearch.toLowerCase();
        return (
          d.title.toLowerCase().includes(q) ||
          d.topic.toLowerCase().includes(q) ||
          d.targetAudience.toLowerCase().includes(q) ||
          d.serviceOffer.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [drafts, libraryCategory, libraryStatus, librarySearch]);

  if (loading && !kb) {
    return (
      <div className="p-10 text-center text-sm text-zinc-400">
        Loading 74 STUDIO Marketing Intelligence...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Isolation Disclosure */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
              74 STUDIO Marketing Content Studio
            </h1>
            <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
              https://74-studio.com
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Isolated strategy, grounded music-industry research, and 4-platform generation (LinkedIn, X, Threads, SEO Blog). Manual copy &amp; draft workflow only — never auto-publishes.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {SUB_TABS.map((tab) => {
            const active = marketingSubView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMarketingSubView(tab.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-zinc-100 text-zinc-950 font-semibold'
                    : 'bg-[#121216] text-zinc-400 border border-zinc-800 hover:text-zinc-100'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. MARKETING DASHBOARD */}
      {marketingSubView === 'dashboard' && (
        <div className="space-y-6">
          {/* Metrics Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Verified &amp; Live Sources</div>
              <div className="text-2xl font-mono font-semibold text-zinc-100 mt-1 tabular-nums">
                {researchSources.length}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">
                {lastLiveResearchAt ? `Last scan ${lastLiveResearchAt.slice(0, 10)}` : 'Baseline official references loaded'}
              </div>
            </div>
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Topic Opportunities</div>
              <div className="text-2xl font-mono font-semibold text-zinc-100 mt-1 tabular-nums">
                {opportunities.length}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">Aligned to 74 STUDIO offers</div>
            </div>
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Saved Content Drafts</div>
              <div className="text-2xl font-mono font-semibold text-zinc-100 mt-1 tabular-nums">
                {drafts.length}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">Strictly separate from Behind the Release</div>
            </div>
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider">Live Web Research</div>
              <div className="text-sm font-mono font-semibold text-zinc-100 mt-2">
                {integrationsInfo?.geminiConfigured ? 'Gemini Grounding Active' : 'Offline Fallback Only'}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">
                {integrationsInfo?.geminiConfigured ? 'Google Search grounded' : 'Configure GEMINI_API_KEY in Secrets'}
              </div>
            </div>
          </div>

          {integrationsInfo && (
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs text-zinc-300 leading-relaxed">
                <span className="font-semibold text-zinc-100">Research Data Sources:</span> {integrationsInfo.disclosure}
              </div>
              <button
                type="button"
                onClick={() => setMarketingSubView('research')}
                className="shrink-0 px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200"
              >
                Inspect Research &amp; APIs
              </button>
            </div>
          )}

          {/* Trending Topic Opportunities */}
          <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">High-Intent Topic Opportunities</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Strategic content ideas linking industry research &amp; buyer psychology directly to 74 STUDIO offers.
                </p>
              </div>
              <button
                type="button"
                disabled={isDiscoveringTopics}
                onClick={handleDiscoverTopics}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringTopics ? 'animate-spin' : ''}`} />
                <span>Refresh Opportunities</span>
              </button>
            </div>
            <div className="divide-y divide-zinc-800/70">
              {opportunities.slice(0, 4).map((opp) => (
                <div key={opp.id} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-1.5 max-w-3xl">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400">
                      <span className="text-zinc-200">{opp.targetAudience}</span>
                      <span>·</span>
                      <span>{opp.awarenessStage}</span>
                      <span>·</span>
                      <span>{opp.contentCategory}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-zinc-100">{opp.topic}</h3>
                    <p className="text-xs text-zinc-400">{opp.audienceProblem}</p>
                    <p className="text-[11px] text-zinc-500">
                      Service Fit: <span className="text-zinc-300">{opp.serviceOffer}</span> · Principle: {opp.psychologyPrinciple}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => applyOpportunityToGenerator(opp)}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>Use Opportunity</span>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Two columns: Recent Drafts + Latest Research */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Recent Saved Drafts</h2>
                <button
                  type="button"
                  onClick={() => setMarketingSubView('library')}
                  className="text-xs text-zinc-400 hover:text-zinc-100"
                >
                  View Library →
                </button>
              </div>
              {drafts.length === 0 ? (
                <div className="p-6 text-xs text-zinc-500">
                  No drafts saved yet. Use Generate Content to build a 4-platform campaign and save it here.
                </div>
              ) : (
                <div className="divide-y divide-zinc-800/70">
                  {drafts.slice(0, 4).map((draft) => (
                    <div key={draft.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-100 truncate">{draft.title}</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5 truncate">
                          {draft.targetAudience} · {draft.contentCategory}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveDraft(draft);
                          setMarketingSubView('editor');
                        }}
                        className="shrink-0 px-2.5 py-1 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                      >
                        Open Editor
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-zinc-800/80 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Latest Research Intelligence</h2>
                <button
                  type="button"
                  onClick={() => setMarketingSubView('research')}
                  className="text-xs text-zinc-400 hover:text-zinc-100"
                >
                  Open Research →
                </button>
              </div>
              <div className="divide-y divide-zinc-800/70">
                {researchSources.slice(0, 4).map((src) => (
                  <div key={src.id} className="p-4 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-zinc-100 truncate">{src.sourceName}</span>
                      <span className="font-mono text-[10px] text-zinc-400 shrink-0">{src.freshnessLabel}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 line-clamp-2">{src.finding}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. RESEARCH INTELLIGENCE */}
      {marketingSubView === 'research' && (
        <div className="space-y-6">
          {/* Live Research Runner */}
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Globe2 className="w-4 h-4 text-zinc-300" />
                  <span>Live Public Music Industry Research Scan</span>
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Runs Gemini Google Search grounding across music business reports, chart/discovery movements, and artist buyer trends. Returns verified URLs only.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddSource((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Owner-Supplied Source</span>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
              <input
                type="text"
                value={scanQuery}
                onChange={(e) => setScanQuery(e.target.value)}
                placeholder="Focus query (e.g., Spotify Canvas engagement, independent music video trends 2026)..."
                className="lg:col-span-6 px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-600"
              />
              <select
                value={scanCategory}
                onChange={(e) => setScanCategory(e.target.value as ResearchCategory)}
                className="lg:col-span-3 px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                {RESEARCH_CATEGORIES.filter((c) => c.id !== 'all').map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={isScanningLive}
                onClick={() => handleRunLiveResearchScan(true)}
                className="lg:col-span-3 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanningLive ? 'animate-spin' : ''}`} />
                <span>{isScanningLive ? 'Scanning Live Sources...' : 'Run Live Research Scan'}</span>
              </button>
            </div>
          </div>

          {/* Add Owner-Supplied Source Form */}
          {showAddSource && (
            <form onSubmit={handleAddOwnerSource} className="p-5 rounded-xl bg-[#111114] border border-zinc-700 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-100">Add Owner-Supplied / Internal Verified Source</h3>
                <button
                  type="button"
                  onClick={() => setShowAddSource(false)}
                  className="text-xs text-zinc-400 hover:text-zinc-100"
                >
                  Cancel
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input
                  type="text"
                  required
                  value={newSource.sourceName}
                  onChange={(e) => setNewSource({ ...newSource, sourceName: e.target.value })}
                  placeholder="Source Name (e.g. Client Discovery Notes Q4)"
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
                <input
                  type="url"
                  value={newSource.sourceUrl}
                  onChange={(e) => setNewSource({ ...newSource, sourceUrl: e.target.value })}
                  placeholder="Source URL"
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
                <input
                  type="text"
                  value={newSource.publicationDate}
                  onChange={(e) => setNewSource({ ...newSource, publicationDate: e.target.value })}
                  placeholder="Publication Date (YYYY-MM-DD)"
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <select
                  value={newSource.category}
                  onChange={(e) => setNewSource({ ...newSource, category: e.target.value as ResearchCategory })}
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {RESEARCH_CATEGORIES.filter((c) => c.id !== 'all').map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.label}
                    </option>
                  ))}
                </select>
                <select
                  value={newSource.dataClassification}
                  onChange={(e) => setNewSource({ ...newSource, dataClassification: e.target.value as DataClassification })}
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="verified-fact">Verified Fact</option>
                  <option value="current">Current</option>
                  <option value="historical">Historical</option>
                  <option value="emerging-pattern">Emerging Pattern</option>
                  <option value="interpretation">Interpretation</option>
                  <option value="hypothesis">Hypothesis</option>
                </select>
                <select
                  value={newSource.primaryOrSecondary}
                  onChange={(e) => setNewSource({ ...newSource, primaryOrSecondary: e.target.value as 'primary' | 'secondary' })}
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="primary">Primary Source</option>
                  <option value="secondary">Secondary Source</option>
                </select>
                <select
                  value={newSource.confidence}
                  onChange={(e) => setNewSource({ ...newSource, confidence: e.target.value as 'high' | 'medium' | 'low' })}
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="high">High Confidence</option>
                  <option value="medium">Medium Confidence</option>
                  <option value="low">Low Confidence</option>
                </select>
              </div>
              <textarea
                rows={3}
                required
                value={newSource.finding}
                onChange={(e) => setNewSource({ ...newSource, finding: e.target.value })}
                placeholder="Verified factual finding or audience insight..."
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={newSource.implications}
                  onChange={(e) => setNewSource({ ...newSource, implications: e.target.value })}
                  placeholder="Strategic implication for 74 STUDIO offers..."
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
                <input
                  type="text"
                  value={newSource.usageRestrictions}
                  onChange={(e) => setNewSource({ ...newSource, usageRestrictions: e.target.value })}
                  placeholder="Usage restrictions / citation constraints"
                  className="px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                >
                  Save Research Source
                </button>
              </div>
            </form>
          )}

          {/* Filter & Search Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {RESEARCH_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setResearchFilter(cat.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium ${
                    researchFilter === cat.id
                      ? 'bg-zinc-200 text-zinc-950'
                      : 'bg-[#111114] text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div className="relative w-full md:w-64">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={researchSearch}
                onChange={(e) => setResearchSearch(e.target.value)}
                placeholder="Filter sources..."
                className="w-full pl-8 pr-3 py-1.5 rounded-md bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
          </div>

          {/* Sources List */}
          <div className="space-y-3">
            {filteredResearch.map((src) => (
              <div key={src.id} className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-100">{src.sourceName}</h3>
                      {src.sourceUrl && (
                        <a
                          href={src.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-zinc-300 underline hover:text-white"
                        >
                          <span>Source URL</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400 mt-1">
                      <span className="text-emerald-400">{src.freshnessLabel}</span>
                      <span>·</span>
                      <span>Class: {src.dataClassification}</span>
                      <span>·</span>
                      <span>{src.primaryOrSecondary}</span>
                      <span>·</span>
                      <span>Confidence: {src.confidence}</span>
                      <span>·</span>
                      <span>Pub: {src.publicationDate}</span>
                      <span>·</span>
                      <span>Accessed: {src.accessedAt}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setGenForm((prev) => ({
                          ...prev,
                          selectedSourceIds: Array.from(new Set([...(prev.selectedSourceIds || []), src.id])),
                        }));
                        setMarketingSubView('generate');
                      }}
                      className="px-2.5 py-1 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Cite in Generator
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteResearchSource(src.id)}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-500 hover:text-red-400 hover:border-red-900/50"
                      aria-label="Delete research source"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-200 leading-relaxed">{src.finding}</p>
                {src.implications && (
                  <p className="text-xs text-zinc-400">
                    <span className="text-zinc-500">Strategic Implication:</span> {src.implications}
                  </p>
                )}
                <p className="text-[11px] text-zinc-500">
                  <span className="text-zinc-400">Usage Restrictions:</span> {src.usageRestrictions}
                </p>
              </div>
            ))}
          </div>

          {/* Optional External APIs Status */}
          {integrationsInfo && (
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                <Database className="w-3.5 h-3.5" />
                <span>Optional Paid Music Industry Research APIs</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {integrationsInfo.integrations.map((item) => (
                  <div key={item.id} className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/90 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-zinc-100">{item.name}</span>
                      <span
                        className={`font-mono text-[10px] ${
                          item.configured ? 'text-emerald-400' : 'text-zinc-500'
                        }`}
                      >
                        {item.configured ? 'Configured' : 'Not Configured'}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400">{item.category}</div>
                    <div className="text-[11px] text-zinc-500">{item.note}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. GENERATE CONTENT */}
      {marketingSubView === 'generate' && (
        <div className="space-y-6">
          {/* Automatic Topic Discovery */}
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Discover Topics Automatically</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Matches selected audience segment, service offer, and live research into conversion-worthy topics.
                </p>
              </div>
              <button
                type="button"
                disabled={isDiscoveringTopics}
                onClick={handleDiscoverTopics}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-100 disabled:opacity-50"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isDiscoveringTopics ? 'animate-pulse' : ''}`} />
                <span>{isDiscoveringTopics ? 'Discovering...' : 'Discover Topics Automatically'}</span>
              </button>
            </div>

            {opportunities.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {opportunities.slice(0, 4).map((opp) => (
                  <button
                    key={opp.id}
                    type="button"
                    onClick={() => applyOpportunityToGenerator(opp)}
                    className="text-left p-3.5 rounded-lg bg-[#09090b] border border-zinc-800 hover:border-zinc-600 transition-colors space-y-1"
                  >
                    <div className="text-[10px] font-mono text-zinc-400">
                      {opp.targetAudience} · {opp.contentCategory}
                    </div>
                    <div className="text-xs font-semibold text-zinc-100">{opp.topic}</div>
                    <div className="text-[11px] text-zinc-400 line-clamp-2">{opp.recommendedAngle}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Main 1-to-4 Generator Brief Form */}
          <form onSubmit={handleGenerateContent} className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                1 Central Strategic Concept → 4 Platform-Native Outputs
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Generates distinct formats for LinkedIn, X (Ultra-Short ~{genForm.xTargetChars} chars + Expanded), Threads, and 74-studio.com Blog.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Target Audience Segment</label>
                <select
                  value={genForm.targetAudience}
                  onChange={(e) => setGenForm({ ...genForm, targetAudience: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {AUDIENCE_SEGMENTS.map((seg) => (
                    <option key={seg} value={seg}>
                      {seg}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">74 STUDIO Service / Offer</label>
                <select
                  value={genForm.serviceOffer}
                  onChange={(e) => setGenForm({ ...genForm, serviceOffer: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {(kb?.services || []).map((svc) => (
                    <option key={svc.id} value={svc.name}>
                      {svc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Customer Awareness Stage</label>
                <select
                  value={genForm.awarenessStage}
                  onChange={(e) => setGenForm({ ...genForm, awarenessStage: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {AWARENESS_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Content Category (15 Strategic Angles)</label>
                <select
                  value={genForm.contentCategory}
                  onChange={(e) => setGenForm({ ...genForm, contentCategory: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {CONTENT_CATEGORIES_15.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Tone</label>
                <input
                  type="text"
                  value={genForm.tone}
                  onChange={(e) => setGenForm({ ...genForm, tone: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Research Depth</label>
                <select
                  value={genForm.researchDepth}
                  onChange={(e) => setGenForm({ ...genForm, researchDepth: e.target.value as 'standard' | 'deep' })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  <option value="standard">Standard Evidence Synthesis</option>
                  <option value="deep">Deep Multi-Source Synthesis</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Core Topic / Problem Statement</label>
              <textarea
                rows={2}
                required
                value={genForm.topic}
                onChange={(e) => setGenForm({ ...genForm, topic: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">Strategic Objective</label>
                <input
                  type="text"
                  value={genForm.objective}
                  onChange={(e) => setGenForm({ ...genForm, objective: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">CTA Objective</label>
                <input
                  type="text"
                  value={genForm.ctaObjective}
                  onChange={(e) => setGenForm({ ...genForm, ctaObjective: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            {/* Platform Length Controls */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-lg bg-[#09090b] border border-zinc-800/90">
              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  X (Twitter) Ultra-Short Target Length: <span className="font-mono text-zinc-100">{genForm.xTargetChars || 50} chars</span>
                </label>
                <input
                  type="range"
                  min={25}
                  max={140}
                  step={5}
                  value={genForm.xTargetChars || 50}
                  onChange={(e) => setGenForm({ ...genForm, xTargetChars: Number(e.target.value) })}
                  className="w-full accent-zinc-200"
                />
                <div className="text-[11px] text-zinc-500 mt-0.5">Default ~50 chars for punchy ultra-short X output (+ expanded version included).</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  74-studio.com Blog Target Words: <span className="font-mono text-zinc-100">{genForm.blogWordTarget || 1100} words</span>
                </label>
                <input
                  type="range"
                  min={800}
                  max={1500}
                  step={100}
                  value={genForm.blogWordTarget || 1100}
                  onChange={(e) => setGenForm({ ...genForm, blogWordTarget: Number(e.target.value) })}
                  className="w-full accent-zinc-200"
                />
                <div className="text-[11px] text-zinc-500 mt-0.5">Long-form SEO article (800–1,500 words adjustable).</div>
              </div>
            </div>

            {/* Grounded Source Selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-zinc-300">
                  Prioritize Specific Verified Research Sources (Optional — leave unchecked to auto-match)
                </label>
                <span className="font-mono text-[11px] text-zinc-500">
                  {(genForm.selectedSourceIds || []).length} selected
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {researchSources.map((src) => {
                  const checked = (genForm.selectedSourceIds || []).includes(src.id);
                  return (
                    <label
                      key={src.id}
                      className={`flex items-start gap-2.5 p-2.5 rounded-md border text-xs cursor-pointer ${
                        checked
                          ? 'bg-zinc-900 border-zinc-600 text-zinc-100'
                          : 'bg-[#09090b] border-zinc-800/80 text-zinc-400'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setGenForm((prev) => {
                            const cur = prev.selectedSourceIds || [];
                            return {
                              ...prev,
                              selectedSourceIds: checked ? cur.filter((x) => x !== src.id) : [...cur, src.id],
                            };
                          })
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-zinc-200 block truncate">{src.sourceName}</span>
                        <span className="text-[10px] font-mono text-zinc-500">
                          {src.dataClassification} · {src.freshnessLabel}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={isGenerating}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
              >
                <Sparkles className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                <span>{isGenerating ? 'Generating 4 Distinct Platform Outputs...' : 'Generate 4 Platform Versions'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 4. CROSS-PLATFORM CONTENT EDITOR */}
      {marketingSubView === 'editor' && (
        <div className="space-y-6">
          {!activeDraft ? (
            <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-center space-y-3">
              <FileText className="w-8 h-8 text-zinc-500 mx-auto" />
              <div className="text-sm font-medium text-zinc-200">No active marketing draft open</div>
              <p className="text-xs text-zinc-400">
                Generate a new 4-platform concept or open a saved item from the Content Library.
              </p>
              <div className="flex justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMarketingSubView('generate')}
                  className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
                >
                  Generate Content
                </button>
                <button
                  type="button"
                  onClick={() => setMarketingSubView('library')}
                  className="px-4 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200"
                >
                  Open Content Library
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Editor Top Actions Bar */}
              <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">Draft Title</label>
                    <input
                      type="text"
                      value={activeDraft.title}
                      onChange={(e) => setActiveDraft({ ...activeDraft, title: e.target.value })}
                      className="w-full px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs font-medium text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">Workflow Status</label>
                    <select
                      value={activeDraft.status}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          status: e.target.value as MarketingDraft['status'],
                        })
                      }
                      className="w-full px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    >
                      <option value="draft">Draft</option>
                      <option value="reviewed">Reviewed</option>
                      <option value="ready-to-copy">Ready to Copy</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setMarketingSubView('generate')}
                    className="px-3 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                  >
                    New Brief
                  </button>
                  <button
                    type="button"
                    disabled={isSavingDraft}
                    onClick={() => handleSaveDraft()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSavingDraft ? 'Saving...' : 'Save to Content Library'}</span>
                  </button>
                </div>
              </div>

              {/* Shared Locked Central Content Concept */}
              <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-200 flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Shared Central Content Concept (Preserved Across Single-Platform Regenerations)</span>
                  </h2>
                  <span className="font-mono text-[11px] text-zinc-400">
                    {activeDraft.awarenessStage} · {activeDraft.contentCategory}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 space-y-1">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase">Audience &amp; Problem</div>
                    <div className="font-medium text-zinc-200">{activeDraft.centralConcept.targetAudience}</div>
                    <p className="text-zinc-400 leading-relaxed">{activeDraft.centralConcept.audienceProblem}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 space-y-1">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase">Core Strategic Message</div>
                    <p className="text-zinc-200 leading-relaxed">{activeDraft.centralConcept.coreMessage}</p>
                    <p className="text-[11px] text-zinc-400">Angle: {activeDraft.centralConcept.recommendedAngle}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 space-y-1">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase">Psychology, Service Tie-In &amp; CTA</div>
                    <div className="text-zinc-300">{activeDraft.centralConcept.psychologyFramework}</div>
                    <p className="text-[11px] text-zinc-400">{activeDraft.centralConcept.serviceTieIn}</p>
                    <p className="text-[11px] text-emerald-400">CTA: {activeDraft.centralConcept.ctaObjective}</p>
                  </div>
                </div>
              </div>

              {/* 3 Short/Mid-Form Social Panes Grid: LinkedIn, X, Threads */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
                {/* LinkedIn */}
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-100">LinkedIn</h3>
                      <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                        {activeDraft.platforms.linkedin.length} chars · {countWords(activeDraft.platforms.linkedin)} words
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard('linkedin', activeDraft.platforms.linkedin, 'LinkedIn Post')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                    >
                      {copiedKey === 'linkedin' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy</span>
                    </button>
                  </div>

                  <textarea
                    rows={12}
                    value={activeDraft.platforms.linkedin}
                    onChange={(e) =>
                      setActiveDraft({
                        ...activeDraft,
                        platforms: { ...activeDraft.platforms, linkedin: e.target.value },
                      })
                    }
                    className="flex-1 w-full p-3 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 leading-relaxed"
                  />

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={regenNotes.linkedin}
                      onChange={(e) => setRegenNotes({ ...regenNotes, linkedin: e.target.value })}
                      placeholder="Refinement note (optional)"
                      className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                    />
                    <button
                      type="button"
                      disabled={regenPlatform === 'linkedin'}
                      onClick={() => handleRegenerateSinglePlatform('linkedin')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${regenPlatform === 'linkedin' ? 'animate-spin' : ''}`} />
                      <span>Regenerate</span>
                    </button>
                  </div>
                </div>

                {/* X (Twitter) — Ultra-Short + Expanded */}
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-100">X (Twitter)</h3>
                      <span className="font-mono text-[11px] text-zinc-400">
                        Short target: ~{activeDraft.xTargetChars} chars
                      </span>
                    </div>
                    <input
                      type="number"
                      min={25}
                      max={280}
                      value={activeDraft.xTargetChars}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          xTargetChars: Math.max(25, Math.min(280, Number(e.target.value) || 50)),
                        })
                      }
                      aria-label="X short target characters"
                      className="w-16 px-2 py-1 rounded bg-[#09090b] border border-zinc-800 font-mono text-xs text-zinc-100 text-right"
                    />
                  </div>

                  {/* Ultra-Short Field */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-zinc-300">Ultra-Short X Post</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-[11px] tabular-nums ${
                            activeDraft.platforms.x.ultraShort.length <= activeDraft.xTargetChars + 10
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }`}
                        >
                          {activeDraft.platforms.x.ultraShort.length} / {activeDraft.xTargetChars} chars
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard('x-short', activeDraft.platforms.x.ultraShort, 'X Ultra-Short')}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-100 text-zinc-950 text-[11px] font-semibold"
                        >
                          {copiedKey === 'x-short' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>Copy</span>
                        </button>
                      </div>
                    </div>
                    <textarea
                      rows={3}
                      value={activeDraft.platforms.x.ultraShort}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          platforms: {
                            ...activeDraft.platforms,
                            x: { ...activeDraft.platforms.x, ultraShort: e.target.value },
                          },
                        })
                      }
                      className="w-full p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>

                  {/* Expanded X Field */}
                  <div className="flex-1 flex flex-col space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-zinc-300">Expanded X Post</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-[11px] tabular-nums ${
                            activeDraft.platforms.x.expanded.length <= 280 ? 'text-zinc-400' : 'text-amber-400'
                          }`}
                        >
                          {activeDraft.platforms.x.expanded.length} chars
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard('x-expanded', activeDraft.platforms.x.expanded, 'X Expanded')}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-200 text-[11px]"
                        >
                          {copiedKey === 'x-expanded' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>Copy</span>
                        </button>
                      </div>
                    </div>
                    <textarea
                      rows={6}
                      value={activeDraft.platforms.x.expanded}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          platforms: {
                            ...activeDraft.platforms,
                            x: { ...activeDraft.platforms.x, expanded: e.target.value },
                          },
                        })
                      }
                      className="flex-1 w-full p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 leading-relaxed"
                    />
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={regenNotes.x}
                      onChange={(e) => setRegenNotes({ ...regenNotes, x: e.target.value })}
                      placeholder="Refinement note (optional)"
                      className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                    />
                    <button
                      type="button"
                      disabled={regenPlatform === 'x'}
                      onClick={() => handleRegenerateSinglePlatform('x')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${regenPlatform === 'x' ? 'animate-spin' : ''}`} />
                      <span>Regenerate</span>
                    </button>
                  </div>
                </div>

                {/* Threads */}
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-100">Threads</h3>
                      <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                        {activeDraft.platforms.threads.length} chars · {countWords(activeDraft.platforms.threads)} words
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard('threads', activeDraft.platforms.threads, 'Threads Post')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                    >
                      {copiedKey === 'threads' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy</span>
                    </button>
                  </div>

                  <textarea
                    rows={12}
                    value={activeDraft.platforms.threads}
                    onChange={(e) =>
                      setActiveDraft({
                        ...activeDraft,
                        platforms: { ...activeDraft.platforms, threads: e.target.value },
                      })
                    }
                    className="flex-1 w-full p-3 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-100 leading-relaxed"
                  />

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={regenNotes.threads}
                      onChange={(e) => setRegenNotes({ ...regenNotes, threads: e.target.value })}
                      placeholder="Refinement note (optional)"
                      className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                    />
                    <button
                      type="button"
                      disabled={regenPlatform === 'threads'}
                      onClick={() => handleRegenerateSinglePlatform('threads')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${regenPlatform === 'threads' ? 'animate-spin' : ''}`} />
                      <span>Regenerate</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* 4th Output: Full 74-studio.com SEO Website Blog Article */}
              <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">74-studio.com Website Blog Article (SEO)</h3>
                    <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
                      {countWords(activeDraft.platforms.blog.bodyMarkdown)} words (target ~{activeDraft.blogWordTarget} words) · Primary Keyword: {activeDraft.platforms.blog.primaryKeyword}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBlogPreviewMode((v) => !v)}
                      className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      {blogPreviewMode ? 'Edit Markdown' : 'Read Mode'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const b = activeDraft.platforms.blog;
                        const fullText = `SEO Title: ${b.seoTitle}\nMeta Description: ${b.metaDescription}\nPrimary Keyword: ${b.primaryKeyword}\nSecondary Keywords: ${b.secondaryKeywords.join(', ')}\nSearch Intent: ${b.searchIntent}\nFeatured Image Concept: ${b.featuredImageConcept}\n\n# ${b.seoTitle}\n\n${b.bodyMarkdown}`;
                        void copyToClipboard('blog', fullText, 'Full SEO Blog Article');
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                    >
                      {copiedKey === 'blog' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy Full Blog + SEO Meta</span>
                    </button>
                  </div>
                </div>

                {/* SEO Metadata Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">
                      SEO Title ({activeDraft.platforms.blog.seoTitle.length} chars)
                    </label>
                    <input
                      type="text"
                      value={activeDraft.platforms.blog.seoTitle}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          platforms: {
                            ...activeDraft.platforms,
                            blog: { ...activeDraft.platforms.blog, seoTitle: e.target.value },
                          },
                        })
                      }
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">Primary Keyword &amp; Search Intent</label>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={activeDraft.platforms.blog.primaryKeyword}
                        onChange={(e) =>
                          setActiveDraft({
                            ...activeDraft,
                            platforms: {
                              ...activeDraft.platforms,
                              blog: { ...activeDraft.platforms.blog, primaryKeyword: e.target.value },
                            },
                          })
                        }
                        className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                      />
                      <input
                        type="text"
                        value={activeDraft.platforms.blog.searchIntent}
                        onChange={(e) =>
                          setActiveDraft({
                            ...activeDraft,
                            platforms: {
                              ...activeDraft.platforms,
                              blog: { ...activeDraft.platforms.blog, searchIntent: e.target.value },
                            },
                          })
                        }
                        className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">
                      Meta Description ({activeDraft.platforms.blog.metaDescription.length} chars)
                    </label>
                    <textarea
                      rows={2}
                      value={activeDraft.platforms.blog.metaDescription}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          platforms: {
                            ...activeDraft.platforms,
                            blog: { ...activeDraft.platforms.blog, metaDescription: e.target.value },
                          },
                        })
                      }
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">Featured Image Concept</label>
                    <textarea
                      rows={2}
                      value={activeDraft.platforms.blog.featuredImageConcept}
                      onChange={(e) =>
                        setActiveDraft({
                          ...activeDraft,
                          platforms: {
                            ...activeDraft.platforms,
                            blog: { ...activeDraft.platforms.blog, featuredImageConcept: e.target.value },
                          },
                        })
                      }
                      className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                </div>

                {/* H2 Outline + Known Internal Links */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/80">
                    <div className="text-[11px] font-mono uppercase text-zinc-500 mb-1.5">H2 Section Outline</div>
                    <ul className="list-disc list-inside space-y-1 text-zinc-300">
                      {activeDraft.platforms.blog.h2Outline.map((h2, idx) => (
                        <li key={idx}>{h2}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/80">
                    <div className="text-[11px] font-mono uppercase text-zinc-500 mb-1.5">Known 74 STUDIO Internal Links</div>
                    <ul className="space-y-1">
                      {activeDraft.platforms.blog.internalLinks.map((lnk, idx) => (
                        <li key={idx} className="text-zinc-300 flex items-center justify-between gap-2">
                          <span className="truncate">{lnk.anchor}</span>
                          <a
                            href={lnk.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[11px] text-zinc-400 underline shrink-0"
                          >
                            {lnk.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Body Markdown / Read View */}
                {blogPreviewMode ? (
                  <div className="p-5 rounded-lg bg-[#09090b] border border-zinc-800 text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
                    {activeDraft.platforms.blog.bodyMarkdown}
                  </div>
                ) : (
                  <textarea
                    rows={16}
                    value={activeDraft.platforms.blog.bodyMarkdown}
                    onChange={(e) =>
                      setActiveDraft({
                        ...activeDraft,
                        platforms: {
                          ...activeDraft.platforms,
                          blog: { ...activeDraft.platforms.blog, bodyMarkdown: e.target.value },
                        },
                      })
                    }
                    className="w-full p-4 rounded-lg bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-100 leading-relaxed"
                  />
                )}

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={regenNotes.blog}
                    onChange={(e) => setRegenNotes({ ...regenNotes, blog: e.target.value })}
                    placeholder="Blog refinement instruction (e.g., deepen section on Spotify Canvas deadlines)"
                    className="flex-1 px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  />
                  <button
                    type="button"
                    disabled={streamingBlogManifest}
                    onClick={() => void handleStreamBlogSections()}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{streamingBlogManifest ? 'Streaming Sections...' : 'Stream Section-Verified Blog'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={regenPlatform === 'blog'}
                    onClick={() => handleRegenerateSinglePlatform('blog')}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${regenPlatform === 'blog' ? 'animate-spin' : ''}`} />
                    <span>Regenerate Blog Only</span>
                  </button>
                </div>

                {activeDraft.platforms.blog.blogManifest && (
                  <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-emerald-300">
                        Section Manifest: {activeDraft.platforms.blog.blogManifest.completedSections} /{' '}
                        {activeDraft.platforms.blog.blogManifest.totalExpectedSections} (
                        {activeDraft.platforms.blog.blogManifest.status})
                      </span>
                      {activeDraft.platforms.blog.blogManifest.status === 'incomplete' && (
                        <button
                          type="button"
                          disabled={resumingBlogManifest}
                          onClick={() => void handleResumeIncompleteBlogSections()}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-amber-500 text-slate-950 text-xs font-semibold disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3 h-3 ${resumingBlogManifest ? 'animate-spin' : ''}`} />
                          <span>Resume Incomplete Sections</span>
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {activeDraft.platforms.blog.blogManifest.sections.map((sec) => (
                        <div
                          key={sec.index}
                          className="p-2.5 rounded border border-zinc-800 bg-[#111114] text-[11px] flex items-center justify-between gap-2"
                        >
                          <span className="text-zinc-200 truncate">{sec.expectedHeading}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded font-mono text-[10px] uppercase shrink-0 ${
                              sec.completionStatus === 'verified'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-amber-500/15 text-amber-300'
                            }`}
                          >
                            {sec.completionStatus} ({sec.wordCount}w)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Research & Sources Verification Panel */}
              <ResearchEvidencePanel claims={activeDraft.evidenceClaims || []} />
            </>
          )}
        </div>
      )}

      {/* 5. CONTENT LIBRARY */}
      {marketingSubView === 'library' && (
        <div className="space-y-5">
          <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <Library className="w-4 h-4 text-zinc-400" />
              <span>
                Saved 74 STUDIO Marketing Concepts ({drafts.length}). Completely isolated from Behind The Release publishing queue.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMarketingSubView('generate')}
              className="px-3.5 py-1.5 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
            >
              + New Marketing Concept
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                placeholder="Search saved drafts..."
                className="w-full pl-8 pr-3 py-2 rounded-md bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <select
              value={libraryCategory}
              onChange={(e) => setLibraryCategory(e.target.value)}
              className="px-3 py-2 rounded-md bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
            >
              <option value="all">All Categories</option>
              {CONTENT_CATEGORIES_15.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={libraryStatus}
              onChange={(e) => setLibraryStatus(e.target.value)}
              className="px-3 py-2 rounded-md bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
            >
              <option value="all">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="reviewed">Reviewed</option>
              <option value="ready-to-copy">Ready to Copy</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          {filteredDrafts.length === 0 ? (
            <div className="p-10 rounded-xl bg-[#111114] border border-zinc-800 text-center text-xs text-zinc-500">
              No saved marketing drafts match your filters.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredDrafts.map((draft) => (
                <div
                  key={draft.id}
                  className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] uppercase px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200">
                        {draft.status}
                      </span>
                      <span className="text-[11px] font-mono text-zinc-400">
                        Updated {draft.updatedAt.slice(0, 10)}
                      </span>
                      <span className="text-[11px] text-zinc-400">· {draft.targetAudience}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-zinc-100 truncate">{draft.title}</h3>
                    <p className="text-xs text-zinc-400 truncate">
                      {draft.serviceOffer} · {draft.contentCategory} · {draft.evidenceClaims?.length || 0} evidence claim(s)
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveDraft(draft);
                        setMarketingSubView('editor');
                      }}
                      className="px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                    >
                      Open in Editor
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const copyDraft: MarketingDraft = {
                          ...draft,
                          id: `mdraft-${Date.now().toString(36)}`,
                          title: `${draft.title} (Copy)`,
                          createdAt: new Date().toISOString(),
                          updatedAt: new Date().toISOString(),
                        };
                        void handleSaveDraft(copyDraft);
                      }}
                      className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGenForm({
                          targetAudience: draft.targetAudience,
                          serviceOffer: draft.serviceOffer,
                          objective: draft.objective,
                          awarenessStage: draft.awarenessStage,
                          contentCategory: draft.contentCategory,
                          topic: draft.topic,
                          tone: draft.tone,
                          ctaObjective: draft.ctaObjective,
                          researchDepth: draft.researchDepth,
                          xTargetChars: draft.xTargetChars,
                          blogWordTarget: draft.blogWordTarget,
                        });
                        setMarketingSubView('generate');
                      }}
                      className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Reuse Topic
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteDraft(draft.id)}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-500 hover:text-red-400"
                      aria-label="Delete draft"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 6. 74 STUDIO KNOWLEDGE BASE PROFILE */}
      {marketingSubView === 'knowledge-base' && kb && (
        <div className="space-y-6">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-zinc-300" />
                <span>74 STUDIO Verified Business Knowledge Base</span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Single source of truth for offers, brand voice, pricing honesty, and verified proof across all marketing outputs.
              </p>
            </div>
            <button
              type="button"
              disabled={isSavingKb}
              onClick={handleSaveKnowledgeBase}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSavingKb ? 'Saving...' : 'Save Knowledge Base'}</span>
            </button>
          </div>

          <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Core Brand &amp; Offer Reality</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Business Name</label>
                <input
                  type="text"
                  value={kb.businessName}
                  onChange={(e) => setKb({ ...kb, businessName: e.target.value })}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Primary Website URL</label>
                <input
                  type="url"
                  value={kb.websiteUrl}
                  onChange={(e) => setKb({ ...kb, websiteUrl: e.target.value })}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Brand Voice</label>
              <textarea
                rows={2}
                value={kb.brandVoice}
                onChange={(e) => setKb({ ...kb, brandVoice: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Positioning Summary</label>
              <textarea
                rows={3}
                value={kb.positioning}
                onChange={(e) => setKb({ ...kb, positioning: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Pricing Policy (Never Fabricate Rates)</label>
                <textarea
                  rows={2}
                  value={kb.pricingSummary}
                  onChange={(e) => setKb({ ...kb, pricingSummary: e.target.value })}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Contact &amp; Enquiry Channels</label>
                <textarea
                  rows={2}
                  value={kb.contactSummary}
                  onChange={(e) => setKb({ ...kb, contactSummary: e.target.value })}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>
          </div>

          {/* Verified Services */}
          <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Verified 74 STUDIO Services ({kb.services.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {kb.services.map((svc, idx) => (
                <div key={svc.id} className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2">
                  <input
                    type="text"
                    value={svc.name}
                    onChange={(e) => {
                      const next = [...kb.services];
                      next[idx] = { ...svc, name: e.target.value };
                      setKb({ ...kb, services: next });
                    }}
                    className="w-full px-2.5 py-1.5 rounded bg-[#111114] border border-zinc-800 text-xs font-semibold text-zinc-100"
                  />
                  <textarea
                    rows={2}
                    value={svc.summary}
                    onChange={(e) => {
                      const next = [...kb.services];
                      next[idx] = { ...svc, summary: e.target.value };
                      setKb({ ...kb, services: next });
                    }}
                    className="w-full px-2.5 py-1.5 rounded bg-[#111114] border border-zinc-800 text-xs text-zinc-300"
                  />
                  <div className="text-[11px] text-zinc-400">
                    Deliverables: {svc.deliverables.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Known Internal URLs */}
          <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Known Official URLs (Used for SEO Blog Internal Links)
            </h3>
            <div className="space-y-2">
              {kb.knownUrls.map((u, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#09090b] border border-zinc-800 text-xs">
                  <span>
                    <strong className="text-zinc-200">{u.label}</strong>{' '}
                    <span className="font-mono text-zinc-400 ml-2">{u.url}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setKb({ ...kb, knownUrls: kb.knownUrls.filter((_, i) => i !== idx) })
                    }
                    className="text-zinc-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input
                type="text"
                value={newKnownUrl.label}
                onChange={(e) => setNewKnownUrl({ ...newKnownUrl, label: e.target.value })}
                placeholder="Page Label (e.g. Portfolio Reels)"
                className="px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <input
                type="url"
                value={newKnownUrl.url}
                onChange={(e) => setNewKnownUrl({ ...newKnownUrl, url: e.target.value })}
                placeholder="https://74-studio.com/..."
                className="px-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newKnownUrl.label.trim() || !newKnownUrl.url.trim()) return;
                  setKb({ ...kb, knownUrls: [...kb.knownUrls, { ...newKnownUrl }] });
                  setNewKnownUrl({ label: '', url: '' });
                }}
                className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
              >
                Add Official URL
              </button>
            </div>
          </div>

          {/* Owner-Verified Proof / Testimonials / Case Studies */}
          <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-950/20 border border-amber-800/40 text-xs text-amber-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <span>
                Anti-Fabrication Safeguard: Leave this empty unless you add real, verified client results or approved testimonials below. The generator never invents unverified client metrics or quotes.
              </span>
            </div>

            {kb.verifiedProofItems.map((item) => (
              <div key={item.id} className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-zinc-100">
                    {item.title} — <span className="text-zinc-400">{item.clientOrProject}</span>
                  </div>
                  <p className="text-xs text-zinc-300">{item.summary}</p>
                  <div className="text-[11px] font-mono text-zinc-500">Verification Note: {item.sourceNote}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setKb({
                      ...kb,
                      verifiedProofItems: kb.verifiedProofItems.filter((p) => p.id !== item.id),
                    })
                  }
                  className="text-xs text-zinc-500 hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              <input
                type="text"
                value={newProof.title}
                onChange={(e) => setNewProof({ ...newProof, title: e.target.value })}
                placeholder="Verified Proof Title"
                className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <input
                type="text"
                value={newProof.clientOrProject}
                onChange={(e) => setNewProof({ ...newProof, clientOrProject: e.target.value })}
                placeholder="Artist / Project Name"
                className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <input
                type="text"
                value={newProof.summary}
                onChange={(e) => setNewProof({ ...newProof, summary: e.target.value })}
                placeholder="Verified factual outcome or approved quote"
                className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newProof.sourceNote}
                  onChange={(e) => setNewProof({ ...newProof, sourceNote: e.target.value })}
                  placeholder="Proof source note (e.g. YouTube release link)"
                  className="flex-1 px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!newProof.title.trim() || !newProof.summary.trim()) return;
                    setKb({
                      ...kb,
                      verifiedProofItems: [
                        ...kb.verifiedProofItems,
                        { id: `proof-${Date.now().toString(36)}`, ...newProof },
                      ],
                    });
                    setNewProof({ title: '', clientOrProject: '', summary: '', sourceNote: '' });
                  }}
                  className="px-3 py-2 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                >
                  Add Proof
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
