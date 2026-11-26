import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Briefcase,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  Mail,
  Megaphone,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import { salesClient } from '../../services/salesClient';
import {
  deleteSalesLeadFromFirestore,
  syncSalesActivityToFirestore,
  syncSalesLeadToFirestore,
  syncSalesOutputToFirestore,
  syncSalesProfileToFirestore,
} from '../../services/firebaseClient';
import type { LongFormDocumentManifest } from '../../types/aiProviders';
import type {
  BuyerIntentLevel,
  SalesActivityRecord,
  SalesKnowledgeBase,
  SalesLeadRecord,
  SalesLeadSegment,
  SalesOutputRecord,
  SalesPipelineStage,
} from '../../types/sales';
import type { SalesSubView } from '../../types/studio';

const SEGMENTS: SalesLeadSegment[] = [
  'Independent recording artist',
  'Established recording artist',
  'Music producer',
  'Beatmaker',
  'Songwriter',
  'Record label',
  'Music manager',
  'Music business',
];

const STAGES: SalesPipelineStage[] = [
  'new-lead',
  'researched',
  'qualified',
  'proposal-sent',
  'follow-up',
  'won',
  'archived',
];

const SUB_TABS: Array<{ id: SalesSubView; label: string }> = [
  { id: 'dashboard', label: 'Sales Overview' },
  { id: 'leads', label: 'Leads & Prospects' },
  { id: 'intelligence', label: 'Lead Intelligence' },
  { id: 'responses', label: 'Responses & Proposals' },
  { id: 'campaigns', label: 'Sales Campaigns' },
  { id: 'activity', label: 'Activity History' },
  { id: 'knowledge-base', label: '74 STUDIO Sales Profile' },
];

const INTENT_STYLE: Record<BuyerIntentLevel, string> = {
  high: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  medium: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  low: 'border-zinc-700 bg-zinc-800/70 text-zinc-400',
  exploratory: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
};

export const SalesIntelligenceView: React.FC = () => {
  const { salesSubView, setSalesSubView, notify } = useStudio();
  const { user } = useFirebase();

  const [loading, setLoading] = useState(true);
  const [kb, setKb] = useState<SalesKnowledgeBase | null>(null);
  const [leads, setLeads] = useState<SalesLeadRecord[]>([]);
  const [outputs, setOutputs] = useState<SalesOutputRecord[]>([]);
  const [activities, setActivities] = useState<SalesActivityRecord[]>([]);

  const [selectedLeadId, setSelectedLeadId] = useState<string>('');
  const [showNewLeadForm, setShowNewLeadForm] = useState(false);
  const [newLeadForm, setNewLeadForm] = useState<{
    name: string;
    handleOrOrg: string;
    contactChannel: string;
    segment: SalesLeadSegment;
    channelSource: string;
    releaseOrProjectContext: string;
    rawInquiryNotes: string;
  }>({
    name: '',
    handleOrOrg: '',
    contactChannel: 'Email',
    segment: 'Independent recording artist',
    channelSource: '74-studio.com Inquiry',
    releaseOrProjectContext: '',
    rawInquiryNotes: '',
  });

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [segmentFilter, setSegmentFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<string>('all');

  // AI Operations states
  const [analyzingLeadId, setAnalyzingLeadId] = useState<string | null>(null);
  const [quickTagging, setQuickTagging] = useState(false);
  const [focusNotes, setFocusNotes] = useState('');
  const [generatingOutput, setGeneratingOutput] = useState<string | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [campaignFocus, setCampaignFocus] = useState('Upcoming Q4/Q1 Single & EP Visual Rollouts');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Proposal SSE Streaming & Section Manifest state
  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalOutlineText, setProposalOutlineText] = useState(
    '1. Release Context & Visual Objectives\n2. Recommended 74 STUDIO Service Scope & Deliverables\n3. Creative Workflow, Asset Requirements & Timeline\n4. Custom Quote Process & Next Steps'
  );
  const [streamingProposal, setStreamingProposal] = useState(false);
  const [liveManifest, setLiveManifest] = useState<LongFormDocumentManifest | null>(null);
  const [liveMarkdownPreview, setLiveMarkdownPreview] = useState('');
  const [activeOutputId, setActiveOutputId] = useState<string>('');
  const [resumingProposal, setResumingProposal] = useState(false);
  const [savingKb, setSavingKb] = useState(false);

  const loadAllSalesData = useCallback(async () => {
    setLoading(true);
    try {
      const [kbRes, leadsRes, outputsRes, actRes] = await Promise.all([
        salesClient.getKnowledgeBase(),
        salesClient.listLeads(),
        salesClient.listOutputs(),
        salesClient.listActivities(),
      ]);
      setKb(kbRes);
      setLeads(leadsRes);
      setOutputs(outputsRes);
      setActivities(actRes);
      if (!selectedLeadId && leadsRes.length > 0) {
        setSelectedLeadId(leadsRes[0].id);
      }
      if (!activeOutputId && outputsRes.length > 0) {
        setActiveOutputId(outputsRes[0].id);
      }
    } catch (err) {
      notify(
        'error',
        'Sales Intelligence load failed',
        err instanceof Error ? err.message : 'Unable to reach Sales Intelligence API.'
      );
    } finally {
      setLoading(false);
    }
  }, [activeOutputId, notify, selectedLeadId]);

  useEffect(() => {
    void loadAllSalesData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedLead = useMemo(
    () => leads.find((l) => l.id === selectedLeadId) || leads[0] || null,
    [leads, selectedLeadId]
  );

  const activeOutput = useMemo(
    () => outputs.find((o) => o.id === activeOutputId) || outputs[0] || null,
    [outputs, activeOutputId]
  );

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return leads.filter((l) => {
      if (segmentFilter !== 'all' && l.segment !== segmentFilter) return false;
      if (stageFilter !== 'all' && l.stage !== stageFilter) return false;
      if (q) {
        const hay = `${l.name} ${l.handleOrOrg} ${l.releaseOrProjectContext} ${l.rawInquiryNotes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [leads, searchQuery, segmentFilter, stageFilter]);

  const dashboardMetrics = useMemo(() => {
    const total = leads.length;
    const highIntent = leads.filter((l) => l.buyerIntentLevel === 'high').length;
    const avgOpp =
      total > 0 ? Math.round(leads.reduce((s, l) => s + (l.opportunityScore || 0), 0) / total) : 0;
    const proposalsCount = outputs.filter((o) => o.outputType === 'proposal').length;
    return { total, highIntent, avgOpp, proposalsCount };
  }, [leads, outputs]);

  const handleCopy = async (id: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
      notify('success', `Copied ${label}`, 'Ready to send via Email or DM.');
    } catch {
      notify('error', 'Clipboard copy failed');
    }
  };

  const handleQuickTagNewLead = async () => {
    const raw = `${newLeadForm.releaseOrProjectContext}\n${newLeadForm.rawInquiryNotes}`.trim();
    if (!raw) {
      notify('warning', 'Enter inquiry notes first', 'Add release notes or raw message to auto-tag.');
      return;
    }
    setQuickTagging(true);
    try {
      const res = await salesClient.quickTagNotes(raw);
      setNewLeadForm((prev) => ({
        ...prev,
        segment: res.classification.segment || prev.segment,
      }));
      notify(
        'success',
        `Auto-Tagged via ${res.providerMeta.providerId.toUpperCase()}`,
        `Segment: ${res.classification.segment} · Intent: ${res.classification.buyerIntentLevel} · ${res.classification.tags.join(', ')}`
      );
    } catch (err) {
      notify('error', 'Quick tag failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setQuickTagging(false);
    }
  };

  const handleCreateLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLeadForm.name.trim()) {
      notify('warning', 'Prospect name is required');
      return;
    }
    try {
      const res = await salesClient.saveLead(newLeadForm);
      setLeads((prev) => [res.lead, ...prev]);
      if (res.activities) setActivities(res.activities);
      setSelectedLeadId(res.lead.id);
      setShowNewLeadForm(false);
      setNewLeadForm({
        name: '',
        handleOrOrg: '',
        contactChannel: 'Email',
        segment: 'Independent recording artist',
        channelSource: '74-studio.com Inquiry',
        releaseOrProjectContext: '',
        rawInquiryNotes: '',
      });
      if (user && user.emailVerified) {
        await syncSalesLeadToFirestore(user, res.lead).catch(() => {});
        if (res.activities?.[0]) {
          await syncSalesActivityToFirestore(user, res.activities[0]).catch(() => {});
        }
      }
      notify('success', 'Prospect Added', `${res.lead.name} saved to 74 STUDIO Sales Intelligence.`);
    } catch (err) {
      notify('error', 'Failed to add prospect', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleAnalyzeLead = async (leadId: string) => {
    setAnalyzingLeadId(leadId);
    try {
      const res = await salesClient.analyzeLead(leadId, focusNotes || undefined);
      setLeads((prev) => prev.map((l) => (l.id === res.lead.id ? res.lead : l)));
      setActivities((prev) => [res.activity, ...prev]);
      setSelectedLeadId(res.lead.id);
      if (user && user.emailVerified) {
        await syncSalesLeadToFirestore(user, res.lead).catch(() => {});
        await syncSalesActivityToFirestore(user, res.activity).catch(() => {});
      }
      notify(
        'success',
        `Intelligence Complete (${res.providerMeta.providerId.toUpperCase()})`,
        `${res.lead.name}: Opportunity ${res.lead.opportunityScore}/100 · Intent: ${res.lead.buyerIntentLevel}`
      );
    } catch (err) {
      notify('error', 'Lead intelligence failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setAnalyzingLeadId(null);
    }
  };

  const handleStageChange = async (leadId: string, stage: SalesPipelineStage) => {
    try {
      const updated = await salesClient.patchLead(leadId, { stage });
      setLeads((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      const latestActs = await salesClient.listActivities();
      setActivities(latestActs);
      if (user && user.emailVerified) {
        await syncSalesLeadToFirestore(user, updated).catch(() => {});
      }
      notify('info', `Stage updated to ${stage}`);
    } catch (err) {
      notify('error', 'Stage update failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleDeleteLead = async (leadId: string) => {
    try {
      await salesClient.deleteLead(leadId);
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
      if (selectedLeadId === leadId) setSelectedLeadId('');
      if (user && user.emailVerified) {
        await deleteSalesLeadFromFirestore(user, leadId).catch(() => {});
      }
      notify('info', 'Prospect removed');
    } catch (err) {
      notify('error', 'Delete failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleGenerateOutput = async (
    outputType: 'personalized-response' | 'follow-up' | 'sales-campaign-intel'
  ) => {
    if (outputType !== 'sales-campaign-intel' && !selectedLead) {
      notify('warning', 'Select a prospect first');
      return;
    }
    setGeneratingOutput(outputType);
    try {
      const res = await salesClient.generateOutput({
        leadId: outputType === 'sales-campaign-intel' ? selectedLead?.id : selectedLead?.id,
        outputType,
        customInstruction: customInstruction || undefined,
        campaignFocus: outputType === 'sales-campaign-intel' ? campaignFocus : undefined,
      });
      setOutputs((prev) => [res.output, ...prev]);
      setActivities((prev) => [res.activity, ...prev]);
      setActiveOutputId(res.output.id);
      if (user && user.emailVerified) {
        await syncSalesOutputToFirestore(user, res.output).catch(() => {});
        await syncSalesActivityToFirestore(user, res.activity).catch(() => {});
      }
      notify(
        'success',
        `Generated via ${res.providerMeta.providerId.toUpperCase()}`,
        res.output.title
      );
    } catch (err) {
      notify('error', 'Generation failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setGeneratingOutput(null);
    }
  };

  const handleStreamProposal = async () => {
    if (!selectedLead) {
      notify('warning', 'Select a prospect before generating a proposal');
      return;
    }
    setStreamingProposal(true);
    setLiveManifest(null);
    setLiveMarkdownPreview('');
    try {
      const sectionsOutline = proposalOutlineText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await salesClient.streamProposalManifest(
        {
          leadId: selectedLead.id,
          proposalTitle: proposalTitle.trim() || undefined,
          sectionsOutline,
          customInstruction: customInstruction || undefined,
          targetWordsPerSection: 200,
        },
        {
          onManifest: (manifest) => setLiveManifest(manifest),
          onDelta: (_idx, chunk) => setLiveMarkdownPreview((prev) => prev + chunk),
          onFallback: (fromP, toP, reason) =>
            notify('warning', `Switched ${fromP} → ${toP}`, reason),
        }
      );

      setLiveManifest(res.manifest);
      setLiveMarkdownPreview(res.markdown);
      setOutputs((prev) => [res.output, ...prev]);
      setActiveOutputId(res.output.id);
      const [latestLeads, latestActs] = await Promise.all([
        salesClient.listLeads(),
        salesClient.listActivities(),
      ]);
      setLeads(latestLeads);
      setActivities(latestActs);

      if (user && user.emailVerified) {
        await syncSalesOutputToFirestore(user, res.output).catch(() => {});
      }

      notify(
        res.manifest.status === 'incomplete' ? 'warning' : 'success',
        `Proposal ${res.manifest.status === 'incomplete' ? 'Partially Generated' : 'Verified Complete'}`,
        `${res.manifest.completedSections}/${res.manifest.totalExpectedSections} sections · ${res.providerId.toUpperCase()}`
      );
    } catch (err) {
      notify('error', 'Proposal generation failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStreamingProposal(false);
    }
  };

  const handleResumeProposal = async (output: SalesOutputRecord) => {
    if (!output.manifest) return;
    setResumingProposal(true);
    try {
      const res = await salesClient.continueProposalManifest({
        outputId: output.id,
        leadId: output.leadId,
        manifest: output.manifest,
        proposalTitle: output.title,
      });
      if (res.output) {
        setOutputs((prev) => prev.map((o) => (o.id === res.output!.id ? res.output! : o)));
      }
      setLiveManifest(res.manifest);
      setLiveMarkdownPreview(res.markdown);
      if (user && user.emailVerified && res.output) {
        await syncSalesOutputToFirestore(user, res.output).catch(() => {});
      }
      notify(
        'success',
        'Proposal Sections Resumed',
        `${res.manifest.completedSections}/${res.manifest.totalExpectedSections} sections now complete.`
      );
    } catch (err) {
      notify('error', 'Resume failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setResumingProposal(false);
    }
  };

  const handleSaveKb = async () => {
    if (!kb) return;
    setSavingKb(true);
    try {
      const saved = await salesClient.saveKnowledgeBase(kb);
      setKb(saved);
      if (user && user.emailVerified) {
        await syncSalesProfileToFirestore(user, saved).catch(() => {});
      }
      notify('success', '74 STUDIO Sales Profile Saved');
    } catch (err) {
      notify('error', 'Failed to save Sales Profile', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSavingKb(false);
    }
  };

  if (loading && !kb) {
    return (
      <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-xs text-zinc-400">
        Loading 74 STUDIO Sales Intelligence Workspace...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Workspace B Sub-Navigation Bar (Distinct Slate/Sky Accent) */}
      <div className="p-4 rounded-xl bg-[#0e131b] border border-sky-900/50 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-sky-400">
            <Briefcase className="w-3.5 h-3.5" />
            <span>Workspace B · Isolated Sales Intelligence</span>
          </div>
          <h1 className="text-lg font-bold text-zinc-100 mt-0.5">
            74 STUDIO Sales Intelligence &amp; Prospecting Console
          </h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SUB_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSalesSubView(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                salesSubView === tab.id
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'bg-[#121822] text-zinc-300 border border-slate-800 hover:border-sky-700/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 1. SALES DASHBOARD */}
      {salesSubView === 'dashboard' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Active Prospects</span>
                <Users className="w-4 h-4 text-sky-400" />
              </div>
              <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100 mt-2">
                {dashboardMetrics.total}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">Isolated from Behind The Release</div>
            </div>
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>High Buyer-Intent Leads</span>
                <Target className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="font-mono text-2xl font-bold tabular-nums text-emerald-300 mt-2">
                {dashboardMetrics.highIntent}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">Ready for custom scoping</div>
            </div>
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Avg Opportunity Score</span>
                <TrendingUp className="w-4 h-4 text-sky-400" />
              </div>
              <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100 mt-2">
                {dashboardMetrics.avgOpp} / 100
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">Across qualified prospects</div>
            </div>
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Proposals Generated</span>
                <FileText className="w-4 h-4 text-sky-400" />
              </div>
              <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100 mt-2">
                {dashboardMetrics.proposalsCount}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">
                {outputs.length} total sales deliverables
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">
                  Verified 74 STUDIO Service Offers
                </h2>
                <button
                  type="button"
                  onClick={() => setSalesSubView('knowledge-base')}
                  className="text-xs text-sky-400 hover:underline"
                >
                  Edit Sales KB
                </button>
              </div>
              <div className="space-y-2.5">
                {kb?.services.map((svc) => (
                  <div key={svc.id} className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80">
                    <div className="text-xs font-semibold text-zinc-100">{svc.name}</div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">{svc.summary}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Quick Sales Actions</h2>
                <button
                  type="button"
                  onClick={() => {
                    setSalesSubView('leads');
                    setShowNewLeadForm(true);
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-sky-500 text-slate-950 text-xs font-semibold"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Prospect</span>
                </button>
              </div>
              {leads.length === 0 ? (
                <div className="p-5 rounded-lg bg-[#09090b] border border-zinc-800 text-center space-y-2">
                  <div className="text-xs text-zinc-300 font-medium">No prospects logged yet</div>
                  <p className="text-[11px] text-zinc-500">
                    Add your first artist, producer, or label prospect to run qualification, buyer-intent scoring, custom responses, and multi-section proposals.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {leads.slice(0, 5).map((lead) => (
                    <div
                      key={lead.id}
                      className="p-3 rounded-lg bg-[#09090b] border border-zinc-800 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-100 truncate">{lead.name}</div>
                        <div className="text-[11px] text-zinc-400 truncate">
                          {lead.segment} · Opportunity {lead.opportunityScore}/100
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedLeadId(lead.id);
                          setSalesSubView('intelligence');
                        }}
                        className="px-2.5 py-1 rounded border border-zinc-700 text-[11px] text-zinc-200 hover:bg-zinc-800 shrink-0"
                      >
                        Inspect
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. LEADS & PROSPECTS */}
      {salesSubView === 'leads' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search prospects, release context, notes..."
                  className="w-full pl-8 pr-3 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <select
                value={segmentFilter}
                onChange={(e) => setSegmentFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              >
                <option value="all">All Segments</option>
                {SEGMENTS.map((seg) => (
                  <option key={seg} value={seg}>
                    {seg}
                  </option>
                ))}
              </select>
              <select
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              >
                <option value="all">All Stages</option>
                {STAGES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => setShowNewLeadForm((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showNewLeadForm ? 'Close Form' : 'New Prospect'}</span>
            </button>
          </div>

          {showNewLeadForm && (
            <form
              onSubmit={handleCreateLead}
              className="p-5 rounded-xl bg-[#111114] border border-sky-900/50 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Add Prospect to Sales Pipeline</h2>
                <button
                  type="button"
                  disabled={quickTagging}
                  onClick={() => void handleQuickTagNewLead()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 text-[11px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-50"
                >
                  <Sparkles className="w-3 h-3" />
                  <span>{quickTagging ? 'Tagging...' : 'Lightweight AI Auto-Tag'}</span>
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Prospect Name *</label>
                  <input
                    type="text"
                    required
                    value={newLeadForm.name}
                    onChange={(e) => setNewLeadForm({ ...newLeadForm, name: e.target.value })}
                    placeholder="e.g., Maya K / Nightshift Records"
                    className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Handle / Label / Org</label>
                  <input
                    type="text"
                    value={newLeadForm.handleOrOrg}
                    onChange={(e) => setNewLeadForm({ ...newLeadForm, handleOrOrg: e.target.value })}
                    placeholder="@artist or Label Name"
                    className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Segment</label>
                  <select
                    value={newLeadForm.segment}
                    onChange={(e) =>
                      setNewLeadForm({ ...newLeadForm, segment: e.target.value as SalesLeadSegment })
                    }
                    className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                  >
                    {SEGMENTS.map((seg) => (
                      <option key={seg} value={seg}>
                        {seg}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Release / Project Context</label>
                  <input
                    type="text"
                    value={newLeadForm.releaseOrProjectContext}
                    onChange={(e) =>
                      setNewLeadForm({ ...newLeadForm, releaseOrProjectContext: e.target.value })
                    }
                    placeholder="e.g., Single dropping in 4 weeks, needs visualizer + Spotify Canvas"
                    className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Contact &amp; Lead Source</label>
                  <input
                    type="text"
                    value={newLeadForm.contactChannel}
                    onChange={(e) => setNewLeadForm({ ...newLeadForm, contactChannel: e.target.value })}
                    placeholder="Email / IG DM / Referral"
                    className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Raw Inquiry / Discovery Notes</label>
                <textarea
                  rows={3}
                  value={newLeadForm.rawInquiryNotes}
                  onChange={(e) => setNewLeadForm({ ...newLeadForm, rawInquiryNotes: e.target.value })}
                  placeholder="Paste prospect email, DM inquiry, goals, timeline, and asset status..."
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewLeadForm(false)}
                  className="px-3 py-2 rounded border border-zinc-700 text-xs text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold"
                >
                  Save Prospect
                </button>
              </div>
            </form>
          )}

          {filteredLeads.length === 0 ? (
            <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-center text-xs text-zinc-400">
              No matching prospects found. Add a prospect or adjust filters.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredLeads.map((lead) => (
                <div
                  key={lead.id}
                  className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-100">{lead.name}</span>
                      {lead.handleOrOrg && (
                        <span className="text-xs font-mono text-zinc-400">{lead.handleOrOrg}</span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase ${
                          INTENT_STYLE[lead.buyerIntentLevel]
                        }`}
                      >
                        {lead.buyerIntentLevel} intent
                      </span>
                      <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-300">
                        {lead.segment}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 truncate">
                      {lead.releaseOrProjectContext || lead.rawInquiryNotes || 'No project notes yet'}
                    </p>
                    {lead.recommendedServices.length > 0 && (
                      <div className="text-[11px] text-sky-300">
                        Recommended: {lead.recommendedServices.join(' · ')}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <div className="px-2.5 py-1 rounded bg-[#09090b] border border-zinc-800 text-right">
                      <div className="text-[10px] text-zinc-500">Opportunity</div>
                      <div className="font-mono text-xs font-bold tabular-nums text-zinc-100">
                        {lead.opportunityScore}/100
                      </div>
                    </div>
                    <select
                      value={lead.stage}
                      onChange={(e) => void handleStageChange(lead.id, e.target.value as SalesPipelineStage)}
                      className="px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                    >
                      {STAGES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={analyzingLeadId === lead.id}
                      onClick={() => void handleAnalyzeLead(lead.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{analyzingLeadId === lead.id ? 'Analyzing...' : 'Analyze'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedLeadId(lead.id);
                        setSalesSubView('intelligence');
                      }}
                      className="px-2.5 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Deep View
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteLead(lead.id)}
                      className="p-1.5 rounded border border-zinc-800 text-zinc-500 hover:text-red-400"
                      title="Delete lead"
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

      {/* 3. LEAD INTELLIGENCE (Research, Pain Points, Buyer Intent, Opportunity Score, Service Rec) */}
      {salesSubView === 'intelligence' && (
        <div className="space-y-4">
          {!selectedLead ? (
            <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-xs text-zinc-400">
              Select or add a prospect in Leads &amp; Prospects to inspect deep intelligence.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={selectedLead.id}
                    onChange={(e) => setSelectedLeadId(e.target.value)}
                    className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs font-semibold text-zinc-100"
                  >
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.segment})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={focusNotes}
                    onChange={(e) => setFocusNotes(e.target.value)}
                    placeholder="Optional analyst focus note..."
                    className="px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200 min-w-[240px]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={analyzingLeadId === selectedLead.id}
                    onClick={() => void handleAnalyzeLead(selectedLead.id)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${analyzingLeadId === selectedLead.id ? 'animate-spin' : ''}`}
                    />
                    <span>Run Full Sales Intelligence</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSalesSubView('responses')}
                    className="px-3 py-2 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
                  >
                    Draft Response / Proposal
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="text-[11px] font-mono uppercase text-zinc-500">
                    Qualification &amp; Opportunity Score
                  </div>
                  <div className="flex items-baseline gap-4">
                    <div>
                      <span className="font-mono text-2xl font-bold tabular-nums text-sky-300">
                        {selectedLead.opportunityScore}
                      </span>
                      <span className="text-xs text-zinc-500"> / 100 Opp</span>
                    </div>
                    <div>
                      <span className="font-mono text-lg font-semibold tabular-nums text-zinc-200">
                        {selectedLead.qualificationScore}
                      </span>
                      <span className="text-xs text-zinc-500"> / 100 Fit</span>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    {selectedLead.qualificationRationale || 'Run analysis to compute qualification rationale.'}
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="text-[11px] font-mono uppercase text-zinc-500">
                    Buyer-Intent Analysis ({selectedLead.buyerIntentLevel})
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-xs text-zinc-300">
                    {selectedLead.buyerIntentSignals.length === 0 ? (
                      <li className="text-zinc-500">No intent signals extracted yet.</li>
                    ) : (
                      selectedLead.buyerIntentSignals.map((sig, i) => <li key={i}>{sig}</li>)
                    )}
                  </ul>
                </div>

                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="text-[11px] font-mono uppercase text-zinc-500">
                    Service Recommendation Intelligence
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedLead.recommendedServices.map((svc, i) => (
                      <span
                        key={i}
                        className="px-2.5 py-1 rounded bg-sky-500/10 border border-sky-500/30 text-xs text-sky-200"
                      >
                        {svc}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-emerald-300 pt-1">
                    Next Step: {selectedLead.recommendedNextStep || 'Run analysis for next action.'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="text-[11px] font-mono uppercase text-zinc-500">
                    Research &amp; Discovery Synthesis
                  </div>
                  <p className="text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap">
                    {selectedLead.researchSummary || selectedLead.rawInquiryNotes || 'No summary yet.'}
                  </p>
                </div>
                <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="text-[11px] font-mono uppercase text-zinc-500">
                    Identified Prospect Pain Points
                  </div>
                  <ul className="list-disc list-inside space-y-1.5 text-xs text-zinc-200">
                    {selectedLead.painPoints.length === 0 ? (
                      <li className="text-zinc-500">Run analysis to extract prospect pain points.</li>
                    ) : (
                      selectedLead.painPoints.map((pt, i) => <li key={i}>{pt}</li>)
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. RESPONSES, FOLLOW-UPS & SSE LONG-FORM PROPOSALS */}
      {salesSubView === 'responses' && (
        <div className="space-y-6">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Target Prospect</label>
                <select
                  value={selectedLead?.id || ''}
                  onChange={(e) => setSelectedLeadId(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {leads.length === 0 && <option value="">Add a prospect first</option>}
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} — {l.segment} ({l.buyerIntentLevel} intent)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">
                  Custom Operator Direction (Optional)
                </label>
                <input
                  type="text"
                  value={customInstruction}
                  onChange={(e) => setCustomInstruction(e.target.value)}
                  placeholder="e.g., Emphasize 3-week turnaround before Spotify playlist pitch"
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!selectedLead || generatingOutput === 'personalized-response'}
                onClick={() => void handleGenerateOutput('personalized-response')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>
                  {generatingOutput === 'personalized-response'
                    ? 'Drafting Response...'
                    : 'Generate Personalized Response'}
                </span>
              </button>
              <button
                type="button"
                disabled={!selectedLead || generatingOutput === 'follow-up'}
                onClick={() => void handleGenerateOutput('follow-up')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {generatingOutput === 'follow-up' ? 'Drafting Follow-Up...' : 'Draft Follow-Up Sequence'}
                </span>
              </button>
            </div>
          </div>

          {/* Long-Form Proposal SSE Generator with Section-Level Completion Manifest */}
          <div className="p-5 rounded-xl bg-[#111114] border border-sky-900/40 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  Custom-Quoted Proposal Generator (Section-Resumable SSE)
                </h2>
                <p className="text-[11px] text-zinc-400">
                  Streams section-by-section, tracks a completion manifest, prevents duplicate headings, and never invents flat prices or unverified testimonials.
                </p>
              </div>
              <button
                type="button"
                disabled={!selectedLead || streamingProposal}
                onClick={() => void handleStreamProposal()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold disabled:opacity-50 shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{streamingProposal ? 'Streaming Proposal...' : 'Stream Custom Proposal'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Proposal Title (Optional)</label>
                <input
                  type="text"
                  value={proposalTitle}
                  onChange={(e) => setProposalTitle(e.target.value)}
                  placeholder={
                    selectedLead
                      ? `74 STUDIO Custom Visual Proposal — ${selectedLead.name}`
                      : 'Select a prospect'
                  }
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">
                  Expected Proposal Sections (1 per line)
                </label>
                <textarea
                  rows={4}
                  value={proposalOutlineText}
                  onChange={(e) => setProposalOutlineText(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 font-mono text-[11px] text-zinc-200"
                />
              </div>
            </div>

            {(liveManifest || liveMarkdownPreview) && (
              <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
                {liveManifest && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono text-sky-300">
                        Manifest: {liveManifest.completedSections} / {liveManifest.totalExpectedSections}{' '}
                        sections ({liveManifest.status})
                      </span>
                      {liveManifest.duplicateHeadingsDetected.length > 0 && (
                        <span className="text-amber-400 flex items-center gap-1 text-[11px]">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>
                            Duplicate stripped: {liveManifest.duplicateHeadingsDetected.join(', ')}
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {liveManifest.sections.map((sec) => (
                        <div
                          key={sec.index}
                          className="p-2.5 rounded border border-zinc-800 bg-[#111114] text-[11px] flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-zinc-200 truncate">
                              {sec.expectedHeading}
                            </div>
                            <div className="font-mono text-[10px] text-zinc-500">
                              {sec.wordCount} words {sec.providerId ? `· ${sec.providerId}` : ''}
                            </div>
                          </div>
                          <span
                            className={`px-1.5 py-0.5 rounded font-mono text-[10px] uppercase shrink-0 ${
                              sec.completionStatus === 'verified'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : sec.generationStatus === 'streaming'
                                  ? 'bg-sky-500/15 text-sky-300'
                                  : 'bg-amber-500/15 text-amber-300'
                            }`}
                          >
                            {sec.generationStatus === 'streaming' ? 'streaming' : sec.completionStatus}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {liveMarkdownPreview && (
                  <div className="p-3 rounded border border-zinc-800/80 text-xs text-zinc-200 whitespace-pre-wrap max-h-72 overflow-y-auto leading-relaxed">
                    {liveMarkdownPreview}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Saved Outputs & Continuation List */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 space-y-2.5">
              <div className="text-xs font-semibold text-zinc-200">
                Saved Sales Deliverables ({outputs.length})
              </div>
              {outputs.length === 0 ? (
                <div className="text-xs text-zinc-500 py-4">No generated sales outputs yet.</div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {outputs.map((out) => (
                    <button
                      key={out.id}
                      type="button"
                      onClick={() => setActiveOutputId(out.id)}
                      className={`w-full text-left p-3 rounded-lg border text-xs transition-colors ${
                        activeOutput?.id === out.id
                          ? 'bg-sky-500/10 border-sky-500/40 text-zinc-100'
                          : 'bg-[#09090b] border-zinc-800 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <div className="font-semibold truncate">{out.title}</div>
                      <div className="font-mono text-[10px] text-zinc-500 mt-0.5">
                        {out.outputType} · {out.providerId}
                        {out.manifest ? ` · ${out.manifest.completedSections}/${out.manifest.totalExpectedSections}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-2 p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
              {!activeOutput ? (
                <div className="text-xs text-zinc-500 py-8 text-center">
                  Select a deliverable on the left to inspect, copy, or resume incomplete sections.
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-100">{activeOutput.title}</h3>
                      <div className="font-mono text-[11px] text-zinc-400">
                        {activeOutput.leadName} · {activeOutput.providerId} ({activeOutput.model})
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {activeOutput.manifest?.status === 'incomplete' && (
                        <button
                          type="button"
                          disabled={resumingProposal}
                          onClick={() => void handleResumeProposal(activeOutput)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-amber-500 text-slate-950 text-xs font-semibold disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${resumingProposal ? 'animate-spin' : ''}`} />
                          <span>Resume Incomplete Sections</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopy(activeOutput.id, activeOutput.contentMarkdown, activeOutput.title)
                        }
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
                      >
                        {copiedId === activeOutput.id ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed max-h-[460px] overflow-y-auto">
                    {activeOutput.contentMarkdown}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. SALES CAMPAIGNS INTELLIGENCE */}
      {salesSubView === 'campaigns' && (
        <div className="space-y-4">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="flex items-center gap-2 text-xs font-mono uppercase text-sky-400">
              <Megaphone className="w-4 h-4" />
              <span>Sales Content &amp; Campaign Intelligence (Workspace B)</span>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={campaignFocus}
                onChange={(e) => setCampaignFocus(e.target.value)}
                placeholder="Campaign focus (e.g., Label Visualizer Retainers, Single Rollout Canvas Packs)"
                className="flex-1 px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
              <button
                type="button"
                disabled={generatingOutput === 'sales-campaign-intel'}
                onClick={() => void handleGenerateOutput('sales-campaign-intel')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>
                  {generatingOutput === 'sales-campaign-intel'
                    ? 'Building Brief...'
                    : 'Generate Sales Campaign Brief'}
                </span>
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {outputs
              .filter((o) => o.outputType === 'sales-campaign-intel')
              .map((out) => (
                <div key={out.id} className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-zinc-100">{out.title}</h3>
                    <button
                      type="button"
                      onClick={() => void handleCopy(out.id, out.contentMarkdown, out.title)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
                    >
                      <Copy className="w-3 h-3" />
                      <span>Copy Brief</span>
                    </button>
                  </div>
                  <div className="p-3.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                    {out.contentMarkdown}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 6. SALES ACTIVITY HISTORY */}
      {salesSubView === 'activity' && (
        <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-200">
            <Activity className="w-4 h-4 text-sky-400" />
            <span>Lead &amp; Sales Activity Timeline ({activities.length})</span>
          </div>
          {activities.length === 0 ? (
            <div className="text-xs text-zinc-500 py-6">No sales activities recorded yet.</div>
          ) : (
            <div className="space-y-2">
              {activities.map((act) => (
                <div
                  key={act.id}
                  className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                >
                  <div>
                    <span className="font-semibold text-zinc-100">{act.summary}</span>
                    {act.detail && <div className="text-[11px] text-zinc-400 mt-0.5">{act.detail}</div>}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 shrink-0">
                    {act.providerId ? `${act.providerId} · ` : ''}
                    {new Date(act.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 7. 74 STUDIO SALES KNOWLEDGE BASE */}
      {salesSubView === 'knowledge-base' && kb && (
        <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-zinc-100">
                74 STUDIO Verified Sales Knowledge Base
              </h2>
            </div>
            <button
              type="button"
              disabled={savingKb}
              onClick={() => void handleSaveKb()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingKb ? 'Saving...' : 'Save Sales Profile'}</span>
            </button>
          </div>

          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[11px] text-emerald-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{kb.noFabricationGuard}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Business Name &amp; Website</label>
              <input
                type="text"
                value={kb.websiteUrl}
                onChange={(e) => setKb({ ...kb, websiteUrl: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Contact Summary</label>
              <input
                type="text"
                value={kb.contactSummary}
                onChange={(e) => setKb({ ...kb, contactSummary: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] text-zinc-400 mb-1">Brand Positioning</label>
              <textarea
                rows={2}
                value={kb.positioning}
                onChange={(e) => setKb({ ...kb, positioning: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Custom-Quote Pricing Policy</label>
              <textarea
                rows={3}
                value={kb.pricingPolicy}
                onChange={(e) => setKb({ ...kb, pricingPolicy: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Qualification Criteria</label>
              <textarea
                rows={3}
                value={kb.qualificationCriteria}
                onChange={(e) => setKb({ ...kb, qualificationCriteria: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-zinc-100"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
