import express, { type Express, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Type } from '@google/genai';
import type { LongFormDocumentManifest } from '../src/types/aiProviders';
import type {
  BuyerIntentLevel,
  SalesActivityRecord,
  SalesKnowledgeBase,
  SalesLeadRecord,
  SalesLeadSegment,
  SalesOutputRecord,
  SalesOutputType,
  SalesPipelineStage,
} from '../src/types/sales';
import {
  type AuthenticatedRequest,
  requireServerOperator,
} from './aiProviders/authMiddleware';
import {
  initializeManifestFromHeadings,
  executeSectionManifestGeneration,
} from './aiProviders/longFormEngine';
import { executeAiTask } from './aiProviders/providerManager';
import { ProviderExecutionError } from './aiProviders/types';

interface SalesTenantState {
  knowledgeBase: SalesKnowledgeBase;
  leads: SalesLeadRecord[];
  outputs: SalesOutputRecord[];
  activities: SalesActivityRecord[];
}

interface SalesPersistedRoot {
  tenants: Record<string, SalesTenantState>;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_PATH = path.join(DATA_DIR, 'sales-intelligence.json');

const VALID_SEGMENTS = new Set<SalesLeadSegment>([
  'Independent recording artist',
  'Established recording artist',
  'Music producer',
  'Beatmaker',
  'Songwriter',
  'Record label',
  'Music manager',
  'Music business',
]);

const VALID_INTENTS = new Set<BuyerIntentLevel>(['high', 'medium', 'low', 'exploratory']);

const VALID_STAGES = new Set<SalesPipelineStage>([
  'new-lead',
  'researched',
  'qualified',
  'proposal-sent',
  'follow-up',
  'won',
  'archived',
]);

function createDefaultSalesKnowledgeBase(): SalesKnowledgeBase {
  return {
    id: 'kb-74-studio-sales',
    workspaceId: 'ws-74-studio-sales',
    businessName: '74 STUDIO',
    websiteUrl: 'https://74-studio.com',
    brandVoice:
      'Consultative, studio-credible, direct, music-industry literate, zero hype, transparent about custom scoping.',
    positioning:
      '74 STUDIO is a visual creative studio specializing in music videos (AI-assisted, 3D & 2D animated), music visualizers, Spotify Canvas & short-form edits, and promotional video editing for recording artists, producers, songwriters, and record labels.',
    pricingPolicy:
      'All 74 STUDIO engagements are custom-quoted based on track scope, animation/production complexity, visual direction, and release timeline. Never quote unverified flat prices or fabricated package rates.',
    contactSummary: 'Website: https://74-studio.com · Project enquiries: inquire@74-studio.com',
    knownUrls: [
      { label: '74 STUDIO Home', url: 'https://74-studio.com' },
      { label: 'Music Videos', url: 'https://74-studio.com/music-videos' },
      { label: 'Music Visualizers', url: 'https://74-studio.com/visualizers' },
      { label: 'Spotify Canvas & Short-Form Edits', url: 'https://74-studio.com/spotify-canvas' },
      { label: 'Video Editing & Promotional Ads', url: 'https://74-studio.com/promos' },
    ],
    services: [
      {
        id: 'svc-music-videos',
        name: 'Music Videos (AI-Assisted, 3D & 2D Animated)',
        summary:
          'Custom narrative, AI-assisted, 3D, and 2D animated music videos tailored to a single or album campaign.',
        deliverables: [
          'Creative concept & visual treatment',
          'Full-length animated or hybrid music video master (16:9)',
          'Cutdowns for social teasers',
        ],
        idealFor: ['Independent recording artist', 'Established recording artist', 'Record label'],
        differentiator:
          'Delivers distinctive world-building without traditional physical-shoot crew logistics when timeline or location demands flexibility.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-visualizers',
        name: 'Music Visualizers',
        summary:
          'Cohesive YouTube & DSP audio-reactive or looping visualizers designed around cover artwork and sonic mood.',
        deliverables: ['16:9 YouTube visualizer master', 'Cover-art motion extension'],
        idealFor: ['Independent recording artist', 'Music producer', 'Beatmaker', 'Songwriter'],
        differentiator:
          'Turns single or beat uploads into elevated visual experiences ready for YouTube and release day.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-spotify-canvas',
        name: 'Spotify Canvas & Short-Form Edits',
        summary:
          'Vertical 9:16 looping Spotify Canvas assets and short-form vertical visual edits built for Reels, Shorts, and TikTok.',
        deliverables: ['3-8s seamless 9:16 Spotify Canvas loop', 'Vertical social promo loops'],
        idealFor: ['Independent recording artist', 'Established recording artist', 'Music manager'],
        differentiator:
          'Matches Spotify technical specs cleanly while staying visually unified with the primary single aesthetic.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-promos',
        name: 'Video Editing & Promotional Ads',
        summary:
          'High-retention promotional trailers, release countdowns, and campaign ad cutdowns edited from studio or performance assets.',
        deliverables: ['9:16 / 4:5 / 16:9 promo ad cutdowns', 'Hook-first pacing variants'],
        idealFor: ['Record label', 'Music manager', 'Music business'],
        differentiator:
          'Built specifically for release rollout conversion rather than generic post-production.',
        verifiedFromWebsite: true,
      },
    ],
    qualificationCriteria:
      'Evaluate fit across: (1) upcoming or active release timeline, (2) asset readiness (master audio, cover art, visual concept), (3) alignment with 74 STUDIO visual specialties, and (4) decision-maker authority & custom-quote readiness.',
    approvedMessagingNotes:
      'Lead with clarity on release timeline and visual format fit. Invite prospects to share audio/reference links and scope details via 74-studio.com or inquire@74-studio.com.',
    noFabricationGuard:
      'STRICT TRUTH GUARD: Never invent testimonials, client case studies, view counts, streaming lift percentages, partner names, or fixed prices not verified in this knowledge base or supplied directly by the operator.',
    updatedAt: new Date().toISOString(),
  };
}

function createDefaultTenantState(): SalesTenantState {
  const kb = createDefaultSalesKnowledgeBase();
  return {
    knowledgeBase: kb,
    leads: [],
    outputs: [],
    activities: [],
  };
}

function readRoot(): SalesPersistedRoot {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { tenants: {} };
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SalesPersistedRoot>;
    return {
      tenants: parsed.tenants && typeof parsed.tenants === 'object' ? parsed.tenants : {},
    };
  } catch {
    return { tenants: {} };
  }
}

function writeRoot(root: SalesPersistedRoot): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(root, null, 2), 'utf8');
}

function getTenantScopeKey(req: AuthenticatedRequest): string {
  return req.operatorContext?.ownerScopeKey || 'local-operator';
}

function loadTenant(scopeKey: string): { root: SalesPersistedRoot; tenant: SalesTenantState } {
  const root = readRoot();
  if (!root.tenants[scopeKey]) {
    root.tenants[scopeKey] = createDefaultTenantState();
    writeRoot(root);
  }
  return { root, tenant: root.tenants[scopeKey] };
}

function saveTenant(scopeKey: string, root: SalesPersistedRoot, tenant: SalesTenantState): void {
  root.tenants[scopeKey] = tenant;
  writeRoot(root);
}

function createRecordId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function safeParseJson<T>(raw: string, fallback: T): T {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

function buildKbPromptBlock(kb: SalesKnowledgeBase): string {
  const svcList = kb.services
    .map(
      (s) =>
        `- ${s.name}: ${s.summary} | Deliverables: ${s.deliverables.join(', ')} | Ideal for: ${s.idealFor.join(', ')}`
    )
    .join('\n');
  return `74 STUDIO VERIFIED SALES KNOWLEDGE BASE:
- Business: ${kb.businessName} (${kb.websiteUrl})
- Brand Voice: ${kb.brandVoice}
- Positioning: ${kb.positioning}
- Pricing Policy: ${kb.pricingPolicy}
- Contact: ${kb.contactSummary}
- Qualification Criteria: ${kb.qualificationCriteria}
- Messaging Notes: ${kb.approvedMessagingNotes}
- ${kb.noFabricationGuard}
Services:
${svcList}`;
}

function handleSalesError(res: Response, prefix: string, err: unknown) {
  if (err instanceof ProviderExecutionError) {
    return res.status(err.statusCode || 503).json({
      error: `${prefix}: ${err.message}`,
      code: err.errorClass,
      providerId: err.providerId,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: `${prefix}: ${msg}` });
}

export function registerSalesIntelligence(app: Express): void {
  const jsonLimit = express.json({ limit: '2mb' });
  const salesGuard = requireServerOperator('ws-74-studio-sales');

  // 1. Sales Knowledge Base (Isolated to Workspace B)
  app.get('/api/sales/knowledge-base', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ knowledgeBase: tenant.knowledgeBase });
  });

  app.put('/api/sales/knowledge-base', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as Partial<SalesKnowledgeBase>;
    const updated: SalesKnowledgeBase = {
      ...tenant.knowledgeBase,
      businessName: String(body.businessName || tenant.knowledgeBase.businessName).slice(0, 120),
      websiteUrl: String(body.websiteUrl || tenant.knowledgeBase.websiteUrl).slice(0, 240),
      brandVoice: String(body.brandVoice ?? tenant.knowledgeBase.brandVoice).slice(0, 1500),
      positioning: String(body.positioning ?? tenant.knowledgeBase.positioning).slice(0, 2500),
      pricingPolicy: String(body.pricingPolicy ?? tenant.knowledgeBase.pricingPolicy).slice(0, 1500),
      contactSummary: String(body.contactSummary ?? tenant.knowledgeBase.contactSummary).slice(0, 1000),
      qualificationCriteria: String(
        body.qualificationCriteria ?? tenant.knowledgeBase.qualificationCriteria
      ).slice(0, 2000),
      approvedMessagingNotes: String(
        body.approvedMessagingNotes ?? tenant.knowledgeBase.approvedMessagingNotes
      ).slice(0, 2000),
      services: Array.isArray(body.services) ? body.services.slice(0, 20) : tenant.knowledgeBase.services,
      knownUrls: Array.isArray(body.knownUrls) ? body.knownUrls.slice(0, 25) : tenant.knowledgeBase.knownUrls,
      workspaceId: 'ws-74-studio-sales',
      updatedAt: new Date().toISOString(),
    };
    tenant.knowledgeBase = updated;
    saveTenant(scope, root, tenant);
    return res.json({ knowledgeBase: updated });
  });

  // 2. Leads CRUD
  app.get('/api/sales/leads', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ leads: tenant.leads });
  });

  app.post('/api/sales/leads', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as Partial<SalesLeadRecord>;
    const name = String(body.name || '').trim().slice(0, 160);
    if (!name) {
      return res.status(400).json({ error: 'Prospect name is required.' });
    }
    const now = new Date().toISOString();
    const segment: SalesLeadSegment = VALID_SEGMENTS.has(body.segment as SalesLeadSegment)
      ? (body.segment as SalesLeadSegment)
      : 'Independent recording artist';
    const intent: BuyerIntentLevel = VALID_INTENTS.has(body.buyerIntentLevel as BuyerIntentLevel)
      ? (body.buyerIntentLevel as BuyerIntentLevel)
      : 'exploratory';
    const stage: SalesPipelineStage = VALID_STAGES.has(body.stage as SalesPipelineStage)
      ? (body.stage as SalesPipelineStage)
      : 'new-lead';

    const lead: SalesLeadRecord = {
      id: body.id ? String(body.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128) : createRecordId('lead'),
      workspaceId: 'ws-74-studio-sales',
      name,
      handleOrOrg: String(body.handleOrOrg || '').trim().slice(0, 160),
      contactChannel: String(body.contactChannel || 'Email / DM').trim().slice(0, 120),
      segment,
      channelSource: String(body.channelSource || 'Inbound Website').trim().slice(0, 120),
      releaseOrProjectContext: String(body.releaseOrProjectContext || '').trim().slice(0, 2000),
      rawInquiryNotes: String(body.rawInquiryNotes || '').trim().slice(0, 5000),
      researchSummary: String(body.researchSummary || '').trim().slice(0, 4000),
      painPoints: Array.isArray(body.painPoints)
        ? body.painPoints.map((p) => String(p).slice(0, 300)).slice(0, 15)
        : [],
      buyerIntentLevel: intent,
      buyerIntentSignals: Array.isArray(body.buyerIntentSignals)
        ? body.buyerIntentSignals.map((s) => String(s).slice(0, 300)).slice(0, 15)
        : [],
      qualificationScore: Math.max(0, Math.min(100, Number(body.qualificationScore) || 0)),
      qualificationRationale: String(body.qualificationRationale || '').trim().slice(0, 2000),
      opportunityScore: Math.max(0, Math.min(100, Number(body.opportunityScore) || 0)),
      recommendedServices: Array.isArray(body.recommendedServices)
        ? body.recommendedServices.map((s) => String(s).slice(0, 160)).slice(0, 10)
        : [],
      recommendedNextStep: String(body.recommendedNextStep || '').trim().slice(0, 500),
      stage,
      lastAiProvider: body.lastAiProvider,
      lastAiModel: body.lastAiModel,
      createdAt: now,
      updatedAt: now,
    };

    const existingIdx = tenant.leads.findIndex((l) => l.id === lead.id);
    if (existingIdx >= 0) {
      lead.createdAt = tenant.leads[existingIdx].createdAt;
      tenant.leads[existingIdx] = lead;
    } else {
      tenant.leads.unshift(lead);
      tenant.activities.unshift({
        id: createRecordId('sact'),
        workspaceId: 'ws-74-studio-sales',
        leadId: lead.id,
        leadName: lead.name,
        activityType: 'lead-created',
        summary: `Added lead ${lead.name} (${lead.segment})`,
        detail: lead.releaseOrProjectContext || lead.channelSource,
        timestamp: now,
      });
    }
    saveTenant(scope, root, tenant);
    return res.json({ lead, activities: tenant.activities.slice(0, 100) });
  });

  app.patch('/api/sales/leads/:id', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const idx = tenant.leads.findIndex((l) => l.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Lead not found.' });
    const prev = tenant.leads[idx];
    const patch = (req.body || {}) as Partial<SalesLeadRecord>;
    const now = new Date().toISOString();

    const updated: SalesLeadRecord = {
      ...prev,
      ...patch,
      id: prev.id,
      workspaceId: 'ws-74-studio-sales',
      segment: VALID_SEGMENTS.has(patch.segment as SalesLeadSegment)
        ? (patch.segment as SalesLeadSegment)
        : prev.segment,
      buyerIntentLevel: VALID_INTENTS.has(patch.buyerIntentLevel as BuyerIntentLevel)
        ? (patch.buyerIntentLevel as BuyerIntentLevel)
        : prev.buyerIntentLevel,
      stage: VALID_STAGES.has(patch.stage as SalesPipelineStage)
        ? (patch.stage as SalesPipelineStage)
        : prev.stage,
      createdAt: prev.createdAt,
      updatedAt: now,
    };
    tenant.leads[idx] = updated;
    if (patch.stage && patch.stage !== prev.stage) {
      tenant.activities.unshift({
        id: createRecordId('sact'),
        workspaceId: 'ws-74-studio-sales',
        leadId: updated.id,
        leadName: updated.name,
        activityType: 'stage-updated',
        summary: `Moved ${updated.name} from ${prev.stage} to ${updated.stage}`,
        timestamp: now,
      });
    }
    saveTenant(scope, root, tenant);
    return res.json({ lead: updated });
  });

  app.delete('/api/sales/leads/:id', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    tenant.leads = tenant.leads.filter((l) => l.id !== req.params.id);
    saveTenant(scope, root, tenant);
    return res.json({ ok: true });
  });

  // 3. Full Lead Research, Segmentation, Buyer Intent, Pain Points, Opportunity Scoring & Service Recommendation
  app.post('/api/sales/leads/:id/analyze', jsonLimit, salesGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const idx = tenant.leads.findIndex((l) => l.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = tenant.leads[idx];
    const kb = tenant.knowledgeBase;
    const body = (req.body || {}) as { focusNotes?: string };

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'sales-qualification',
        responseFormat: 'json',
        prompt: `You are the senior 74 STUDIO Sales Intelligence Strategist.
Analyze the prospect below strictly against the verified 74 STUDIO knowledge base.
NEVER fabricate client case studies, streaming counts, testimonials, or fixed prices.

${buildKbPromptBlock(kb)}

PROSPECT RECORD:
- Name: ${lead.name}
- Handle / Organization: ${lead.handleOrOrg || 'Not specified'}
- Current Segment: ${lead.segment}
- Contact Channel: ${lead.contactChannel}
- Source: ${lead.channelSource}
- Release / Project Context: ${lead.releaseOrProjectContext || 'None provided'}
- Raw Inquiry / Discovery Notes: ${lead.rawInquiryNotes || 'None provided'}
${body.focusNotes ? `- Additional Analyst Context: ${body.focusNotes}` : ''}

Return a rigorous JSON intelligence object:
{
  "segment": one of ["Independent recording artist", "Established recording artist", "Music producer", "Beatmaker", "Songwriter", "Record label", "Music manager", "Music business"],
  "researchSummary": "Concise synthesis of what we know, release context, and gaps to verify in discovery",
  "painPoints": ["3 to 5 specific visual release or marketing pain points grounded in their notes"],
  "buyerIntentLevel": "high" | "medium" | "low" | "exploratory",
  "buyerIntentSignals": ["Specific textual signals indicating urgency or readiness"],
  "qualificationScore": number 0-100,
  "qualificationRationale": "Why this qualification score makes sense based on timeline, asset readiness, and scope fit",
  "opportunityScore": number 0-100,
  "recommendedServices": ["Exact matching 74 STUDIO service name(s)"],
  "recommendedNextStep": "Concrete next consultative sales action"
}`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            segment: { type: Type.STRING },
            researchSummary: { type: Type.STRING },
            painPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
            buyerIntentLevel: { type: Type.STRING },
            buyerIntentSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
            qualificationScore: { type: Type.INTEGER },
            qualificationRationale: { type: Type.STRING },
            opportunityScore: { type: Type.INTEGER },
            recommendedServices: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommendedNextStep: { type: Type.STRING },
          },
          required: [
            'segment',
            'researchSummary',
            'painPoints',
            'buyerIntentLevel',
            'buyerIntentSignals',
            'qualificationScore',
            'qualificationRationale',
            'opportunityScore',
            'recommendedServices',
            'recommendedNextStep',
          ],
        },
      });

      const parsed = safeParseJson<Partial<SalesLeadRecord>>(aiResp.text, {});
      const now = new Date().toISOString();
      const updatedLead: SalesLeadRecord = {
        ...lead,
        segment: VALID_SEGMENTS.has(parsed.segment as SalesLeadSegment)
          ? (parsed.segment as SalesLeadSegment)
          : lead.segment,
        researchSummary: String(parsed.researchSummary || lead.researchSummary).slice(0, 4000),
        painPoints: Array.isArray(parsed.painPoints)
          ? parsed.painPoints.map((p) => String(p).slice(0, 300)).slice(0, 8)
          : lead.painPoints,
        buyerIntentLevel: VALID_INTENTS.has(parsed.buyerIntentLevel as BuyerIntentLevel)
          ? (parsed.buyerIntentLevel as BuyerIntentLevel)
          : lead.buyerIntentLevel,
        buyerIntentSignals: Array.isArray(parsed.buyerIntentSignals)
          ? parsed.buyerIntentSignals.map((s) => String(s).slice(0, 300)).slice(0, 8)
          : lead.buyerIntentSignals,
        qualificationScore: Math.max(0, Math.min(100, Number(parsed.qualificationScore) || lead.qualificationScore)),
        qualificationRationale: String(parsed.qualificationRationale || lead.qualificationRationale).slice(0, 2000),
        opportunityScore: Math.max(0, Math.min(100, Number(parsed.opportunityScore) || lead.opportunityScore)),
        recommendedServices: Array.isArray(parsed.recommendedServices)
          ? parsed.recommendedServices.map((s) => String(s).slice(0, 160)).slice(0, 6)
          : lead.recommendedServices,
        recommendedNextStep: String(parsed.recommendedNextStep || lead.recommendedNextStep).slice(0, 500),
        stage: lead.stage === 'new-lead' ? 'qualified' : lead.stage,
        lastAiProvider: aiResp.providerId,
        lastAiModel: aiResp.model,
        updatedAt: now,
      };

      tenant.leads[idx] = updatedLead;
      const activity: SalesActivityRecord = {
        id: createRecordId('sact'),
        workspaceId: 'ws-74-studio-sales',
        leadId: updatedLead.id,
        leadName: updatedLead.name,
        activityType: 'lead-qualified',
        summary: `Analyzed & scored ${updatedLead.name} (${updatedLead.opportunityScore}/100 · ${updatedLead.buyerIntentLevel} intent)`,
        detail: `Recommended: ${updatedLead.recommendedServices.join(', ') || 'Custom Visual Scoping'}`,
        providerId: aiResp.providerId,
        model: aiResp.model,
        timestamp: now,
      };
      tenant.activities.unshift(activity);
      saveTenant(scope, root, tenant);

      return res.json({
        lead: updatedLead,
        activity,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
          fallbackChain: aiResp.fallbackChain,
        },
      });
    } catch (err) {
      return handleSalesError(res, 'Lead intelligence analysis failed', err);
    }
  });

  // 4. Lightweight Tagging & Quick Summary (Safe for Cloudflare Workers AI when enabled)
  app.post('/api/sales/leads/quick-tag', jsonLimit, salesGuard, async (req: AuthenticatedRequest, res: Response) => {
    const { rawNotes } = (req.body || {}) as { rawNotes?: string };
    if (!rawNotes || !rawNotes.trim()) {
      return res.status(400).json({ error: 'rawNotes is required for lightweight tagging.' });
    }
    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'lightweight-classification',
        responseFormat: 'json',
        prompt: `Classify this raw prospect inquiry for 74 STUDIO (Music Videos, Music Visualizers, Spotify Canvas & Short-Form Edits, Video Editing & Promotional Ads).
Return concise JSON:
{
  "segment": one of ["Independent recording artist", "Established recording artist", "Music producer", "Beatmaker", "Songwriter", "Record label", "Music manager", "Music business"],
  "buyerIntentLevel": "high" | "medium" | "low" | "exploratory",
  "shortSummary": "1-2 sentence clean summary",
  "tags": ["up to 4 short tags"]
}

INQUIRY:
${rawNotes.slice(0, 3000)}`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            segment: { type: Type.STRING },
            buyerIntentLevel: { type: Type.STRING },
            shortSummary: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['segment', 'buyerIntentLevel', 'shortSummary', 'tags'],
        },
      });
      const parsed = safeParseJson(aiResp.text, {
        segment: 'Independent recording artist',
        buyerIntentLevel: 'exploratory',
        shortSummary: rawNotes.slice(0, 180),
        tags: [],
      });
      return res.json({
        classification: parsed,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
        },
      });
    } catch (err) {
      return handleSalesError(res, 'Lightweight classification failed', err);
    }
  });

  // 5. Sales Outputs (Personalized Responses, Follow-Ups, Proposals, Sales Campaign Intelligence)
  app.get('/api/sales/outputs', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ outputs: tenant.outputs });
  });

  app.delete('/api/sales/outputs/:id', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    tenant.outputs = tenant.outputs.filter((o) => o.id !== req.params.id);
    saveTenant(scope, root, tenant);
    return res.json({ ok: true });
  });

  app.post('/api/sales/generate-output', jsonLimit, salesGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const {
      leadId,
      outputType,
      customInstruction,
      campaignFocus,
    } = (req.body || {}) as {
      leadId?: string;
      outputType: Exclude<SalesOutputType, 'proposal'>;
      customInstruction?: string;
      campaignFocus?: string;
    };

    if (!outputType || !['personalized-response', 'follow-up', 'sales-campaign-intel'].includes(outputType)) {
      return res.status(400).json({ error: 'Valid outputType (personalized-response | follow-up | sales-campaign-intel) is required.' });
    }

    const lead = leadId ? tenant.leads.find((l) => l.id === leadId) : undefined;
    if (outputType !== 'sales-campaign-intel' && !lead) {
      return res.status(400).json({ error: 'Valid leadId is required for lead response or follow-up drafting.' });
    }

    const kb = tenant.knowledgeBase;
    const taskType =
      outputType === 'personalized-response'
        ? 'sales-response'
        : outputType === 'follow-up'
          ? 'sales-follow-up'
          : 'sales-campaign-intel';

    const leadContextBlock = lead
      ? `PROSPECT:
- Name: ${lead.name} (${lead.handleOrOrg || 'Independent'})
- Segment: ${lead.segment}
- Contact Channel: ${lead.contactChannel}
- Release Context: ${lead.releaseOrProjectContext}
- Raw Notes: ${lead.rawInquiryNotes}
- Pain Points: ${lead.painPoints.join('; ') || 'Not analyzed yet'}
- Buyer Intent: ${lead.buyerIntentLevel} (${lead.buyerIntentSignals.join('; ') || 'n/a'})
- Opportunity Score: ${lead.opportunityScore}/100
- Recommended Services: ${lead.recommendedServices.join(', ') || 'Custom 74 STUDIO visual scoping'}`
      : `PIPELINE SUMMARY:
Total active leads: ${tenant.leads.length}
Segments represented: ${Array.from(new Set(tenant.leads.map((l) => l.segment))).join(', ') || 'Independent recording artists, producers, labels'}`;

    const directive =
      outputType === 'personalized-response'
        ? 'Write a tailored, non-pushy, studio-credible first response addressing their exact release context, naming the relevant 74 STUDIO service(s), clarifying discovery questions (timeline, audio/artwork readiness), and inviting a custom quote via 74-studio.com or inquire@74-studio.com.'
        : outputType === 'follow-up'
          ? 'Draft a concise, high-signal follow-up sequence (Primary follow-up message + 5-day check-in note) tailored to their release timeline without fabricated urgency or pressure tactics.'
          : `Create a 74 STUDIO Sales Campaign Intelligence brief for ${campaignFocus || 'upcoming single/EP release season'} including: Priority Segment Plays, Buyer Objections & Verified Rebuttals, Outreach Angles per Service, and Recommended Discovery Questions.`;

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-74-studio-sales',
        taskType,
        responseFormat: 'json',
        prompt: `${buildKbPromptBlock(kb)}

${leadContextBlock}

TASK: ${directive}
${customInstruction ? `CUSTOM OPERATOR INSTRUCTION: ${customInstruction}` : ''}

Return clean JSON:
{
  "title": "Descriptive title for this asset",
  "contentMarkdown": "Complete ready-to-send Markdown output"
}`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            contentMarkdown: { type: Type.STRING },
          },
          required: ['title', 'contentMarkdown'],
        },
      });

      const parsed = safeParseJson<{ title: string; contentMarkdown: string }>(aiResp.text, {
        title: `${outputType} — ${lead?.name || '74 STUDIO'}`,
        contentMarkdown: aiResp.text,
      });

      const now = new Date().toISOString();
      const record: SalesOutputRecord = {
        id: createRecordId('sout'),
        workspaceId: 'ws-74-studio-sales',
        leadId: lead?.id || 'pipeline-wide',
        leadName: lead?.name || '74 STUDIO Pipeline',
        outputType,
        title: String(parsed.title || `${outputType} — ${lead?.name || '74 STUDIO'}`).slice(0, 220),
        contentMarkdown: String(parsed.contentMarkdown || '').trim(),
        providerId: aiResp.providerId,
        model: aiResp.model,
        wasFallback: aiResp.wasFallback,
        createdAt: now,
        updatedAt: now,
      };
      tenant.outputs.unshift(record);

      const actType =
        outputType === 'personalized-response'
          ? 'response-generated'
          : outputType === 'follow-up'
            ? 'follow-up-drafted'
            : 'campaign-intel-generated';

      const activity: SalesActivityRecord = {
        id: createRecordId('sact'),
        workspaceId: 'ws-74-studio-sales',
        leadId: lead?.id,
        leadName: lead?.name,
        activityType: actType,
        summary: `Generated ${outputType} for ${lead?.name || 'Sales Pipeline'}`,
        providerId: aiResp.providerId,
        model: aiResp.model,
        timestamp: now,
      };
      tenant.activities.unshift(activity);
      saveTenant(scope, root, tenant);

      return res.json({
        output: record,
        activity,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
        },
      });
    } catch (err) {
      return handleSalesError(res, 'Sales output generation failed', err);
    }
  });

  // 6. Long-Form Sales Proposal SSE Streaming with Section-Level Completion Manifest
  app.post('/api/sales/proposals/stream-manifest', jsonLimit, salesGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const {
      leadId,
      proposalTitle,
      sectionsOutline,
      customInstruction,
      targetWordsPerSection,
    } = (req.body || {}) as {
      leadId?: string;
      proposalTitle?: string;
      sectionsOutline?: string[];
      customInstruction?: string;
      targetWordsPerSection?: number;
    };

    const lead = leadId ? tenant.leads.find((l) => l.id === leadId) : undefined;
    if (!lead) {
      return res.status(400).json({ error: 'Valid leadId is required to generate a sales proposal.' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (eventName: string, payload: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const kb = tenant.knowledgeBase;
      const headings =
        Array.isArray(sectionsOutline) && sectionsOutline.length >= 2
          ? sectionsOutline.map((h) => String(h).trim()).filter(Boolean).slice(0, 10)
          : [
              '1. Release Context & Visual Objectives',
              '2. Recommended 74 STUDIO Service Scope & Deliverables',
              '3. Creative Workflow, Asset Requirements & Timeline',
              '4. Custom Quote Process & Next Steps',
            ];

      const docTitle = (
        proposalTitle?.trim() || `74 STUDIO Custom Visual Proposal — ${lead.name}`
      ).slice(0, 220);

      let manifest: LongFormDocumentManifest = initializeManifestFromHeadings(headings);
      const contextSummary = `${buildKbPromptBlock(kb)}

PROSPECT:
- Name: ${lead.name} (${lead.handleOrOrg || 'Independent'})
- Segment: ${lead.segment}
- Release / Project Context: ${lead.releaseOrProjectContext}
- Raw Inquiry Notes: ${lead.rawInquiryNotes}
- Pain Points: ${lead.painPoints.join('; ') || 'Needs release visual consistency'}
- Recommended Services: ${lead.recommendedServices.join(', ') || 'Music Video / Visualizer / Spotify Canvas / Promo Edits'}
${customInstruction ? `- Custom Proposal Notes: ${customInstruction}` : ''}`;

      const result = await executeSectionManifestGeneration({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'sales-proposal-longform',
        manifest,
        documentTitle: docTitle,
        contextSummary,
        targetWordsPerSection: Math.max(120, Math.min(450, Number(targetWordsPerSection) || 200)),
        stream: true,
        onSectionChunk: (sectionIndex, _heading, chunk, providerId, model) => {
          sendEvent('delta', { sectionIndex, chunk, providerId, model });
        },
        onSectionDone: (_item, updated) => {
          manifest = updated;
          sendEvent('manifest', updated);
        },
        onFallback: (fromProvider, toProvider, reason) => {
          sendEvent('fallback', { fromProvider, toProvider, reason });
        },
      });

      const now = new Date().toISOString();
      const outputRecord: SalesOutputRecord = {
        id: createRecordId('prop'),
        workspaceId: 'ws-74-studio-sales',
        leadId: lead.id,
        leadName: lead.name,
        outputType: 'proposal',
        title: docTitle,
        contentMarkdown: result.markdown,
        manifest: result.manifest,
        providerId: result.lastProviderId || 'fallback',
        model: result.lastModel || 'unknown',
        wasFallback: result.wasFallback,
        createdAt: now,
        updatedAt: now,
      };
      tenant.outputs.unshift(outputRecord);

      if (lead.stage === 'new-lead' || lead.stage === 'qualified' || lead.stage === 'researched') {
        const lIdx = tenant.leads.findIndex((l) => l.id === lead.id);
        if (lIdx >= 0) {
          tenant.leads[lIdx] = { ...tenant.leads[lIdx], stage: 'proposal-sent', updatedAt: now };
        }
      }

      const activity: SalesActivityRecord = {
        id: createRecordId('sact'),
        workspaceId: 'ws-74-studio-sales',
        leadId: lead.id,
        leadName: lead.name,
        activityType: 'proposal-generated',
        summary: `Generated proposal "${docTitle}" (${result.manifest.completedSections}/${result.manifest.totalExpectedSections} sections ${result.manifest.status})`,
        providerId: result.lastProviderId,
        model: result.lastModel,
        timestamp: now,
      };
      tenant.activities.unshift(activity);
      saveTenant(scope, root, tenant);

      sendEvent('done', {
        output: outputRecord,
        manifest: result.manifest,
        markdown: result.markdown,
        providerId: result.lastProviderId,
        model: result.lastModel,
        wasFallback: result.wasFallback,
      });
      res.end();
    } catch (err) {
      sendEvent('error', { error: err instanceof Error ? err.message : String(err) });
      res.end();
    }
  });

  // 7. Incomplete Proposal Continuation (Resume Incomplete Sections Without Duplication)
  app.post('/api/sales/proposals/continue-manifest', jsonLimit, salesGuard, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const { outputId, leadId, manifest, proposalTitle } = (req.body || {}) as {
      outputId?: string;
      leadId?: string;
      manifest?: LongFormDocumentManifest;
      proposalTitle?: string;
    };

    const existingOutput = outputId ? tenant.outputs.find((o) => o.id === outputId) : undefined;
    const effectiveManifest = manifest || existingOutput?.manifest;
    const targetLeadId = leadId || existingOutput?.leadId;
    const lead = targetLeadId ? tenant.leads.find((l) => l.id === targetLeadId) : undefined;

    if (!effectiveManifest || !Array.isArray(effectiveManifest.sections)) {
      return res.status(400).json({ error: 'manifest or valid outputId with manifest is required.' });
    }

    try {
      const kb = tenant.knowledgeBase;
      const docTitle = proposalTitle || existingOutput?.title || `74 STUDIO Proposal — ${lead?.name || 'Prospect'}`;
      const contextSummary = `${buildKbPromptBlock(kb)}
${lead ? `Prospect: ${lead.name} (${lead.segment}) | Context: ${lead.releaseOrProjectContext} | Services: ${lead.recommendedServices.join(', ')}` : ''}`;

      const result = await executeSectionManifestGeneration({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'sales-proposal-longform',
        manifest: effectiveManifest,
        documentTitle: docTitle,
        contextSummary,
        targetWordsPerSection: 200,
        stream: false,
      });

      const now = new Date().toISOString();
      let updatedOutput: SalesOutputRecord | undefined;
      if (existingOutput) {
        const nextOutput: SalesOutputRecord = {
          ...existingOutput,
          contentMarkdown: result.markdown,
          manifest: result.manifest,
          providerId: result.lastProviderId || existingOutput.providerId || 'fallback',
          model: result.lastModel || existingOutput.model || 'unknown',
          wasFallback: result.wasFallback,
          updatedAt: now,
        };
        updatedOutput = nextOutput;
        const outIdx = tenant.outputs.findIndex((o) => o.id === existingOutput.id);
        if (outIdx >= 0) tenant.outputs[outIdx] = nextOutput;
        saveTenant(scope, root, tenant);
      }

      return res.json({
        output: updatedOutput,
        manifest: result.manifest,
        markdown: result.markdown,
        providerId: result.lastProviderId,
        model: result.lastModel,
        wasFallback: result.wasFallback,
      });
    } catch (err) {
      return handleSalesError(res, 'Proposal continuation failed', err);
    }
  });

  // 8. Activity History
  app.get('/api/sales/activities', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ activities: tenant.activities.slice(0, 120) });
  });

  app.post('/api/sales/activities', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as Partial<SalesActivityRecord>;
    if (!body.summary?.trim()) {
      return res.status(400).json({ error: 'Activity summary is required.' });
    }
    const activity: SalesActivityRecord = {
      id: createRecordId('sact'),
      workspaceId: 'ws-74-studio-sales',
      leadId: body.leadId,
      leadName: body.leadName,
      activityType: body.activityType || 'stage-updated',
      summary: String(body.summary).slice(0, 300),
      detail: body.detail ? String(body.detail).slice(0, 800) : undefined,
      timestamp: new Date().toISOString(),
    };
    tenant.activities.unshift(activity);
    saveTenant(scope, root, tenant);
    return res.json({ activity });
  });
}
