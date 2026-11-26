import crypto from 'crypto';
import express, { type Express, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { LongFormDocumentManifest } from '../src/types/aiProviders';
import type {
  SalesActivityRecord,
  SalesChatMessage,
  SalesConversation,
  SalesKbCustomEntry,
  SalesKnowledgeBase,
  SalesLeadRecord,
  SalesOutputRecord,
  SalesStudioSettings,
} from '../src/types/sales';
import {
  type AuthenticatedRequest,
  requireServerOperator,
} from './aiProviders/authMiddleware';
import {
  executeSectionManifestGeneration,
  initializeManifestFromHeadings,
} from './aiProviders/longFormEngine';
import { executeAiTask } from './aiProviders/providerManager';
import { ProviderExecutionError } from './aiProviders/types';
import { aiGenerationLimiter } from './rateLimiters';
import { deleteRowFromSupabase, syncRowsToSupabase } from './supabase/syncHelper';

interface SalesTenantState {
  knowledgeBase: SalesKnowledgeBase;
  settings: SalesStudioSettings;
  conversations: SalesConversation[];
  // Archived legacy CRM stores preserved permanently (never deleted)
  leads: SalesLeadRecord[];
  outputs: SalesOutputRecord[];
  activities: SalesActivityRecord[];
}

interface SalesPersistedRoot {
  tenants: Record<string, SalesTenantState>;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_PATH = path.join(DATA_DIR, 'sales-intelligence.json');

export function enforceStrictLowercaseReply(raw: string): string {
  // Strip accidental markdown formatting, bullets, headings, bold/italic wrappers, and force lowercase
  const stripped = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*•]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!+/g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLowerCase();
  return stripped;
}

export function createDefaultSalesSettings(): SalesStudioSettings {
  return {
    promoEnabled: true,
    promoPercentage: 10,
    promoLabel: '10% off all orders',
    promoScope: 'applies to everything including custom quotes (no coupon code needed)',
    enforceLowercase: true,
    defaultLengthGuidance: '1 to 3 short casual sentences (around 15-55 words unless more breakdown is requested)',
    extraToneNotes: 'discord-style relaxed human reply, light punctuation, zero sales fluff or fake urgency',
    updatedAt: new Date().toISOString(),
  };
}

export function createDefaultSalesKnowledgeBase(): SalesKnowledgeBase {
  const nowIso = new Date().toISOString();
  return {
    id: 'kb-74-studio-sales',
    workspaceId: 'ws-74-studio-sales',
    businessName: '74 studio',
    websiteUrl: 'https://74-studio.com',
    contactPageUrl: 'https://74-studio.com/contact',
    brandVoice:
      'strictly lowercase, relaxed, friendly, music-scene natural (like texting or replying on discord). 1-3 short sentences, zero corporate jargon, zero bullet lists, zero fake hype.',
    positioning:
      '74 studio makes visuals for recording artists, producers, songwriters, labels, and music brands: ai music videos, 2d animation, 3d music videos, lyric videos, strictly human-made cover art, short-form editing, complete single release promo bundles, and ugc/product ads.',
    pricingPolicy:
      'always state exact verified tier pricing accurately. keep the + sign on starting prices ($99+, $199+, $349+, $249+, $449+) so artists know those start there depending on scope. cover art, release bundles, short-form editing, and ugc ads are custom quote. never invent timelines, turnaround guarantees, or unconfigured discounts.',
    contactSummary: 'send project details through https://74-studio.com/contact',
    knownUrls: [
      { label: '74 studio contact', url: 'https://74-studio.com/contact' },
      { label: '74 studio home', url: 'https://74-studio.com' },
    ],
    services: [
      {
        id: 'svc-ai-music-videos',
        name: 'ai music videos',
        summary: 'spark $29 (up to 10s), hook $49 (up to 20s), full frame $99+ (up to 45s)',
        deliverables: ['spark: $29 (<=10s)', 'hook: $49 (<=20s)', 'full frame: $99+ starting price (<=45s)'],
        idealFor: ['Independent recording artist', 'Songwriter', 'Music producer'],
        differentiator: 'fast concept-driven ai visuals sized cleanly for hooks or longer cuts.',
        tiers: [
          { id: 'ai-spark', tierName: 'spark', priceLabel: '$29', durationOrScope: 'up to 10s' },
          { id: 'ai-hook', tierName: 'hook', priceLabel: '$49', durationOrScope: 'up to 20s' },
          { id: 'ai-full-frame', tierName: 'full frame', priceLabel: '$99+', durationOrScope: 'up to 45s (starting price)' },
        ],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-2d-animation',
        name: '2d animation',
        summary: 'teaser $69 (up to 20s), visualizer $199+ (up to 60s), full video $349+ (up to 60s)',
        deliverables: ['teaser: $69 (<=20s)', 'visualizer: $199+ starting price (<=60s)', 'full video: $349+ starting price (<=60s)'],
        idealFor: ['Independent recording artist', 'Established recording artist', 'Record label'],
        differentiator: 'custom illustrated 2d animated storytelling, teasers, and visualizers.',
        tiers: [
          { id: '2d-teaser', tierName: 'teaser', priceLabel: '$69', durationOrScope: 'up to 20s' },
          { id: '2d-visualizer', tierName: 'visualizer', priceLabel: '$199+', durationOrScope: 'up to 60s (starting price)' },
          { id: '2d-full', tierName: 'full video', priceLabel: '$349+', durationOrScope: 'up to 60s (starting price)' },
        ],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-3d-music-videos',
        name: '3d music videos',
        summary: 'teaser $149 (up to 20s), visualizer $249+ (up to 60s), full video $449+ (up to 60s)',
        deliverables: ['teaser: $149 (<=20s)', 'visualizer: $249+ starting price (<=60s)', 'full video: $449+ starting price (<=60s)'],
        idealFor: ['Established recording artist', 'Independent recording artist', 'Record label'],
        differentiator: '3d visual worlds, teasers, and custom animated scenes.',
        tiers: [
          { id: '3d-teaser', tierName: 'teaser', priceLabel: '$149', durationOrScope: 'up to 20s' },
          { id: '3d-visualizer', tierName: 'visualizer', priceLabel: '$249+', durationOrScope: 'up to 60s (starting price)' },
          { id: '3d-full', tierName: 'full video', priceLabel: '$449+', durationOrScope: 'up to 60s (starting price)' },
        ],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-lyric-videos',
        name: 'lyric videos',
        summary: '30 sec $50 (up to 30s), full $250',
        deliverables: ['30 sec: $50 (<=30s)', 'full: $250'],
        idealFor: ['Independent recording artist', 'Songwriter', 'Music manager'],
        differentiator: 'clean kinetic & expressive typography matched to the track.',
        tiers: [
          { id: 'lyric-30', tierName: '30 sec', priceLabel: '$50', durationOrScope: 'up to 30s' },
          { id: 'lyric-full', tierName: 'full', priceLabel: '$250', durationOrScope: 'full song' },
        ],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-cover-artwork',
        name: 'human-designed cover artwork',
        summary: 'custom quote — strictly non-ai, 100% human-made custom cover art.',
        deliverables: ['hand-crafted custom cover artwork (zero ai)'],
        idealFor: ['Independent recording artist', 'Established recording artist', 'Music producer'],
        differentiator: 'explicitly human-made artwork for artists who do not want ai covers.',
        tiers: [{ id: 'cover-custom', tierName: 'custom quote', priceLabel: 'custom quote', durationOrScope: 'non-ai human-made' }],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-complete-release-promo',
        name: 'complete single release promo content',
        summary: 'custom quote — includes non-ai human cover art + music video + short visualizer. only recommend when an artist needs all three.',
        deliverables: ['human-made cover art', 'music video', 'short visualizer'],
        idealFor: ['Independent recording artist', 'Music manager', 'Record label'],
        differentiator: 'unified release pack only pitched when all 3 elements fit what the artist asked for.',
        tiers: [{ id: 'bundle-custom', tierName: 'custom quote', priceLabel: 'custom quote', durationOrScope: 'all 3 deliverables' }],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-short-form-editing',
        name: 'short-form video editing',
        summary: 'custom quote — turning raw footage into engaging reels, promos, and short vertical videos.',
        deliverables: ['reels / tiktok / shorts promo cuts from raw footage'],
        idealFor: ['Independent recording artist', 'Music manager', 'Music producer'],
        differentiator: 'built for artists who already have raw clips and want tight edits.',
        tiers: [{ id: 'edit-custom', tierName: 'custom quote', priceLabel: 'custom quote', durationOrScope: 'raw footage to reels/promos' }],
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-ugc-ads',
        name: 'ugc / product ads',
        summary: 'custom quote — strictly for businesses & brands only.',
        deliverables: ['product/brand ad creatives'],
        idealFor: ['Music business'],
        differentiator: 'for brands and companies, not standalone recording artists.',
        tiers: [{ id: 'ugc-custom', tierName: 'custom quote', priceLabel: 'custom quote', durationOrScope: 'businesses & brands only' }],
        verifiedFromWebsite: true,
      },
    ],
    customEntries: [
      {
        id: 'kb-entry-promo-rule',
        title: 'active promo rule (10% off)',
        category: 'policy',
        content: '10% off all orders is currently active (applies to everything including custom quotes). no code needed. mention naturally when relevant without faking urgency or expiration dates.',
        updatedAt: nowIso,
      },
      {
        id: 'kb-entry-contact-cta',
        title: 'contact link cta',
        category: 'policy',
        content: 'when an artist is ready to start, get a custom quote, or share their track/idea, point them to https://74-studio.com/contact',
        updatedAt: nowIso,
      },
    ],
    qualificationCriteria:
      'silently gauge eugene schwartz awareness stage (unaware, problem aware, solution aware, product aware, most aware) from the message without ever naming stages in the reply.',
    approvedMessagingNotes:
      'write strictly in lowercase. keep it 1-3 short casual sentences like discord. only mention services relevant to what the artist actually said.',
    noFabricationGuard:
      'strict truth guard: never invent turnaround times, discounts beyond settings, case studies, or flat rates for custom-quoted services.',
    updatedAt: nowIso,
  };
}

function createDefaultTenantState(): SalesTenantState {
  return {
    knowledgeBase: createDefaultSalesKnowledgeBase(),
    settings: createDefaultSalesSettings(),
    conversations: [],
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
  const tmpPath = `${STORE_PATH}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(root, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

function getTenantScopeKey(req: AuthenticatedRequest): string {
  return req.operatorContext?.ownerScopeKey || 'local-operator';
}

function loadTenant(scopeKey: string): { root: SalesPersistedRoot; tenant: SalesTenantState } {
  const root = readRoot();
  if (!root.tenants[scopeKey]) {
    root.tenants[scopeKey] = createDefaultTenantState();
    writeRoot(root);
  } else {
    // Hydrate newly added chat-first fields seamlessly without erasing legacy leads/outputs/activities
    const t = root.tenants[scopeKey] as Partial<SalesTenantState>;
    const defaults = createDefaultSalesKnowledgeBase();
    const migratedKb: SalesKnowledgeBase = {
      ...defaults,
      ...(t.knowledgeBase || {}),
      // Upgrade legacy placeholder KB if old service list didn't yet carry verified tier pricing
      services:
        t.knowledgeBase?.services?.some((s) => s.tiers && s.tiers.length > 0)
          ? t.knowledgeBase.services
          : defaults.services,
      contactPageUrl: t.knowledgeBase?.contactPageUrl || 'https://74-studio.com/contact',
      customEntries: Array.isArray(t.knowledgeBase?.customEntries)
        ? t.knowledgeBase!.customEntries
        : defaults.customEntries,
    };
    root.tenants[scopeKey] = {
      knowledgeBase: migratedKb,
      settings: t.settings ? { ...createDefaultSalesSettings(), ...t.settings } : createDefaultSalesSettings(),
      conversations: Array.isArray(t.conversations) ? t.conversations : [],
      leads: Array.isArray(t.leads) ? t.leads : [],
      outputs: Array.isArray(t.outputs) ? t.outputs : [],
      activities: Array.isArray(t.activities) ? t.activities : [],
    };
  }
  return { root, tenant: root.tenants[scopeKey] };
}

function saveTenant(scopeKey: string, root: SalesPersistedRoot, tenant: SalesTenantState): void {
  root.tenants[scopeKey] = tenant;
  writeRoot(root);
}

function createRecordId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function buildKbCatalogPrompt(kb: SalesKnowledgeBase, settings: SalesStudioSettings): string {
  const serviceLines = kb.services
    .map((s) => `- ${s.name}: ${s.summary}`)
    .join('\n');
  const customLines = (kb.customEntries || [])
    .map((e) => `- ${e.title}: ${e.content}`)
    .join('\n');

  const promoBlock = settings.promoEnabled
    ? `active promo: ${settings.promoPercentage}% off all orders (${settings.promoLabel}) — ${settings.promoScope}. do NOT mention any coupon code and do NOT invent any deadline or expiration timer.`
    : 'no active promo right now. do NOT mention any discount.';

  return `74 studio official pricing & catalog (exact truth):
${serviceLines}

important rules:
- always retain the "+" on starting prices ($99+, $199+, $349+, $249+, $449+) when citing those tiers so the artist knows it is a starting price.
- human-designed cover artwork is strictly non-ai and custom quoted.
- only pitch "complete single release promo content" if the artist specifically asks for or needs all 3 (non-ai cover art + music video + short visualizer).
- ugc / product ads are only for businesses & brands, never mention them to solo music artists unless they represent a brand.
- ${promoBlock}
- contact url when ready: ${kb.contactPageUrl || 'https://74-studio.com/contact'}
${customLines ? `\ncustom knowledge notes:\n${customLines}` : ''}`;
}

function buildArtistReplySystemPrompt(kb: SalesKnowledgeBase, settings: SalesStudioSettings): string {
  return `you are replying directly to a recording artist or prospect on behalf of 74 studio in a relaxed discord / dm style.

strict style & formatting rules (non-negotiable):
1. write EVERYTHING in strict lowercase. zero capital letters anywhere (even at the start of sentences, service names, "i", etc.). keep urls exact lowercase (${kb.contactPageUrl || 'https://74-studio.com/contact'}).
2. keep replies natural, conversational, concise: typically 1 to 3 short sentences (~15-55 words). only go slightly longer if they specifically asked for a breakdown of multiple packages/tiers.
3. use light punctuation, no bullet points, no markdown headers, no bold text, no exclamation marks, no hype or corporate marketing talk.
4. internally diagnose the artist's awareness level (eugene schwartz 5 stages) to pick the right angle — meet them where they are (clarity if vague, right-fit option + honest starting price if comparing, easy next step via ${kb.contactPageUrl || 'https://74-studio.com/contact'} if ready) — but NEVER name awareness stages or frameworks in the reply.
5. only cite exact prices from the verified kb below. never fabricate timelines, turnarounds, testimonials, or unapproved discounts.
${settings.extraToneNotes ? `6. operator tone note: ${settings.extraToneNotes}` : ''}

${buildKbCatalogPrompt(kb, settings)}`;
}

function buildFallbackDiscordReply(artistMessage: string, settings: SalesStudioSettings): string {
  const lower = artistMessage.toLowerCase();
  const promoTail = settings.promoEnabled
    ? ` also running ${settings.promoPercentage}% off all orders right now if you want to lock something in.`
    : '';
  let core =
    'hey, appreciate you reaching out. we do ai music videos from $29, 2d/3d animation starting at $69/$149, lyric videos from $50, plus custom-quoted non-ai cover art and short-form edits depending on what fits your track best.';

  if (lower.includes('cover') || lower.includes('artwork')) {
    core =
      'we do strictly human-made cover artwork (no ai) and scope it on a custom quote based on the concept you want.';
  } else if (lower.includes('lyric')) {
    core = 'for lyric videos we do a 30 sec cut for $50 or a full-track lyric video for $250.';
  } else if (lower.includes('3d')) {
    core = '3d music videos run $149 for a 20s teaser, $249+ for a 60s visualizer, or $449+ for a full video.';
  } else if (lower.includes('2d') || lower.includes('animat')) {
    core = '2d animation starts at $69 for a 20s teaser, $199+ for a visualizer up to 60s, and $349+ for a full video.';
  } else if (lower.includes('ai')) {
    core = 'ai music videos are $29 for spark (up to 10s), $49 for hook (up to 20s), or $99+ starting for full frame (up to 45s).';
  }

  return enforceStrictLowercaseReply(
    `${core}${promoTail} if you want to share your track or idea, hit us at https://74-studio.com/contact.`
  );
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

  // 1. Settings & Active Promo Configuration (Isolated to Workspace B)
  app.get('/api/sales/settings', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ settings: tenant.settings });
  });

  app.put('/api/sales/settings', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as Partial<SalesStudioSettings>;
    const pct = Math.max(0, Math.min(80, Math.round(Number(body.promoPercentage ?? tenant.settings.promoPercentage))));
    const updated: SalesStudioSettings = {
      ...tenant.settings,
      promoEnabled: typeof body.promoEnabled === 'boolean' ? body.promoEnabled : tenant.settings.promoEnabled,
      promoPercentage: pct,
      promoLabel:
        String(body.promoLabel ?? `${pct}% off all orders`).trim().toLowerCase().slice(0, 120) ||
        `${pct}% off all orders`,
      promoScope:
        String(body.promoScope ?? tenant.settings.promoScope).trim().toLowerCase().slice(0, 200) ||
        'applies to everything including custom quotes (no coupon code needed)',
      enforceLowercase: true, // Always enforced for Workspace B artist replies
      defaultLengthGuidance: String(
        body.defaultLengthGuidance ?? tenant.settings.defaultLengthGuidance
      ).slice(0, 240),
      extraToneNotes: String(body.extraToneNotes ?? tenant.settings.extraToneNotes).slice(0, 600),
      updatedAt: new Date().toISOString(),
    };
    tenant.settings = updated;
    saveTenant(scope, root, tenant);
    void syncRowsToSupabase(
      'sales_knowledge_bases',
      [
        {
          id: tenant.knowledgeBase.id,
          owner_uid: scope,
          workspace_id: 'ws-74-studio-sales',
          config_json: tenant.knowledgeBase,
          settings_json: updated,
          updated_at: updated.updatedAt,
        },
      ],
      'owner_uid,id'
    );
    return res.json({ settings: updated });
  });

  // 2. Knowledge Base CRUD (74 STUDIO Artist Chat KB)
  app.get('/api/sales/knowledge-base', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ knowledgeBase: tenant.knowledgeBase });
  });

  app.put('/api/sales/knowledge-base', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as Partial<SalesKnowledgeBase>;
    const cur = tenant.knowledgeBase;
    const updated: SalesKnowledgeBase = {
      ...cur,
      businessName: String(body.businessName || cur.businessName).slice(0, 120),
      websiteUrl: String(body.websiteUrl || cur.websiteUrl).slice(0, 240),
      contactPageUrl: String(body.contactPageUrl || cur.contactPageUrl || 'https://74-studio.com/contact').slice(0, 240),
      brandVoice: String(body.brandVoice ?? cur.brandVoice).slice(0, 1500),
      positioning: String(body.positioning ?? cur.positioning).slice(0, 2500),
      pricingPolicy: String(body.pricingPolicy ?? cur.pricingPolicy).slice(0, 1500),
      contactSummary: String(body.contactSummary ?? cur.contactSummary).slice(0, 1000),
      qualificationCriteria: String(body.qualificationCriteria ?? cur.qualificationCriteria).slice(0, 2000),
      approvedMessagingNotes: String(body.approvedMessagingNotes ?? cur.approvedMessagingNotes).slice(0, 2000),
      services: Array.isArray(body.services) ? body.services.slice(0, 24) : cur.services,
      customEntries: Array.isArray(body.customEntries)
        ? (body.customEntries as SalesKbCustomEntry[]).slice(0, 60)
        : cur.customEntries || [],
      knownUrls: Array.isArray(body.knownUrls) ? body.knownUrls.slice(0, 25) : cur.knownUrls,
      workspaceId: 'ws-74-studio-sales',
      updatedAt: new Date().toISOString(),
    };
    tenant.knowledgeBase = updated;
    saveTenant(scope, root, tenant);
    void syncRowsToSupabase(
      'sales_knowledge_bases',
      [
        {
          id: updated.id,
          owner_uid: scope,
          workspace_id: 'ws-74-studio-sales',
          config_json: updated,
          settings_json: tenant.settings,
          updated_at: updated.updatedAt,
        },
      ],
      'owner_uid,id'
    );
    return res.json({ knowledgeBase: updated });
  });

  // 3. Chat Conversations CRUD & Multi-Turn Artist Reply Generation
  app.get('/api/sales/conversations', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    const list = [...tenant.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return res.json({ conversations: list });
  });

  app.post('/api/sales/conversations', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const body = (req.body || {}) as { title?: string; artistName?: string };
    const now = new Date().toISOString();
    const conv: SalesConversation = {
      id: createRecordId('chat'),
      workspaceId: 'ws-74-studio-sales',
      title: String(body.title || 'new artist chat').trim().slice(0, 140) || 'new artist chat',
      artistName: body.artistName ? String(body.artistName).trim().slice(0, 80) : undefined,
      lastMessagePreview: '',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    tenant.conversations.unshift(conv);
    saveTenant(scope, root, tenant);
    void syncRowsToSupabase(
      'sales_conversations',
      [
        {
          id: conv.id,
          owner_uid: scope,
          workspace_id: 'ws-74-studio-sales',
          title: conv.title,
          artist_name: conv.artistName || null,
          last_message_preview: '',
          created_at: conv.createdAt,
          updated_at: conv.updatedAt,
        },
      ],
      'owner_uid,id'
    );
    return res.json({ conversation: conv });
  });

  app.patch('/api/sales/conversations/:id', jsonLimit, salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const id = String(req.params.id || '');
    const idx = tenant.conversations.findIndex((c) => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Conversation not found.' });

    const body = (req.body || {}) as { title?: string; artistName?: string; pinned?: boolean };
    const cur = tenant.conversations[idx];
    const updated: SalesConversation = {
      ...cur,
      ...(body.title !== undefined ? { title: String(body.title).trim().slice(0, 140) || cur.title } : {}),
      ...(body.artistName !== undefined ? { artistName: String(body.artistName).trim().slice(0, 80) } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
      updatedAt: new Date().toISOString(),
    };
    tenant.conversations[idx] = updated;
    saveTenant(scope, root, tenant);
    void syncRowsToSupabase(
      'sales_conversations',
      [
        {
          id: updated.id,
          owner_uid: scope,
          workspace_id: 'ws-74-studio-sales',
          title: updated.title,
          artist_name: updated.artistName || null,
          last_message_preview: updated.lastMessagePreview,
          pinned: Boolean(updated.pinned),
          updated_at: updated.updatedAt,
        },
      ],
      'owner_uid,id'
    );
    return res.json({ conversation: updated });
  });

  app.delete('/api/sales/conversations/:id', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const id = String(req.params.id || '');
    tenant.conversations = tenant.conversations.filter((c) => c.id !== id);
    saveTenant(scope, root, tenant);
    void deleteRowFromSupabase('sales_conversations', scope, id);
    return res.json({ ok: true });
  });

  // Send an Artist Message + Generate Discord-Style Lowercase Reply with Full Conversation Memory
  app.post('/api/sales/conversations/:id/reply', jsonLimit, salesGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const convId = String(req.params.id || '');
    const convIdx = tenant.conversations.findIndex((c) => c.id === convId);
    if (convIdx === -1) return res.status(404).json({ error: 'Conversation not found.' });

    const body = (req.body || {}) as {
      artistMessage?: string;
      artistNote?: string;
      attachmentName?: string;
      attachmentPreviewUrl?: string;
      customGuidance?: string;
      regenerateForMessageId?: string;
    };

    const conv = tenant.conversations[convIdx];
    const now = new Date().toISOString();
    let userMsg: SalesChatMessage | undefined;

    if (body.regenerateForMessageId) {
      // Regenerate reply using thread up to the preceding artist message
      const targetIdx = conv.messages.findIndex((m) => m.id === body.regenerateForMessageId);
      if (targetIdx === -1) return res.status(404).json({ error: 'Target message not found.' });
      const prevArtist = [...conv.messages.slice(0, targetIdx)].reverse().find((m) => m.role === 'artist');
      userMsg = prevArtist;
    } else {
      const cleanText = String(body.artistMessage || '').trim();
      if (!cleanText) {
        return res.status(400).json({ error: 'Paste or type the artist message first.' });
      }
      userMsg = {
        id: createRecordId('smsg'),
        conversationId: conv.id,
        role: 'artist',
        content: cleanText.slice(0, 6000),
        artistNote: body.artistNote ? String(body.artistNote).trim().slice(0, 1000) : undefined,
        attachmentName: body.attachmentName ? String(body.attachmentName).trim().slice(0, 200) : undefined,
        attachmentPreviewUrl: body.attachmentPreviewUrl
          ? String(body.attachmentPreviewUrl).slice(0, 500_000)
          : undefined,
        createdAt: now,
        updatedAt: now,
      };
      conv.messages.push(userMsg);
      if (conv.title === 'new artist chat' || conv.messages.length === 1) {
        conv.title = cleanText.replace(/\s+/g, ' ').slice(0, 48).toLowerCase();
      }
    }

    const historySlice = body.regenerateForMessageId
      ? conv.messages.slice(0, conv.messages.findIndex((m) => m.id === body.regenerateForMessageId))
      : conv.messages;
    const transcript = historySlice
      .slice(-14)
      .map(
        (m) =>
          `${m.role === 'artist' ? 'ARTIST' : '74 STUDIO'}: ${m.content}${m.artistNote ? ` [operator note: ${m.artistNote}]` : ''}${m.attachmentName ? ` [attachment: ${m.attachmentName}]` : ''}`
      )
      .join('\n');

    const prompt = `conversation thread so far:\n${transcript}\n\n${
      body.customGuidance ? `operator direction for this reply: ${body.customGuidance}\n\n` : ''
    }write ONLY the next reply from 74 studio to the artist. follow every lowercase and pricing rule strictly.`;

    let replyText = '';
    let providerId: SalesChatMessage['providerId'] = 'gemini';
    let model = 'unknown';
    let wasFallback = false;

    try {
      const aiResp = await executeAiTask({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'sales-response',
        systemPrompt: buildArtistReplySystemPrompt(tenant.knowledgeBase, tenant.settings),
        prompt,
        responseFormat: 'text',
        maxOutputTokens: 360,
        temperature: 0.45,
      });
      replyText = enforceStrictLowercaseReply(aiResp.text);
      providerId = aiResp.providerId;
      model = aiResp.model;
      wasFallback = aiResp.wasFallback;
    } catch (err) {
      const onlyUnconfigured =
        err instanceof ProviderExecutionError &&
        err.message.includes('[UNCONFIGURED]') &&
        !err.message.includes('[RATE_LIMIT]') &&
        !err.message.includes('[BUDGET_EXHAUSTED]');
      if (err instanceof ProviderExecutionError && err.errorClass === 'BUDGET_EXHAUSTED' && !onlyUnconfigured) {
        saveTenant(scope, root, tenant);
        return handleSalesError(res, 'Sales AI quota reached', err);
      }
      if (err instanceof ProviderExecutionError && !err.allowFallback && err.errorClass === 'AUTH_INVALID') {
        saveTenant(scope, root, tenant);
        return handleSalesError(res, 'Sales AI key invalid', err);
      }
      // Graceful fallback when API keys aren't configured in preview dev
      replyText = buildFallbackDiscordReply(userMsg?.content || '', tenant.settings);
      providerId = 'fallback';
      model = 'verified-kb-fallback';
      wasFallback = true;
    }

    const replyNow = new Date().toISOString();
    let assistantMsg: SalesChatMessage;

    if (body.regenerateForMessageId) {
      const targetIdx = conv.messages.findIndex((m) => m.id === body.regenerateForMessageId);
      assistantMsg = {
        ...conv.messages[targetIdx],
        content: replyText,
        providerId,
        model,
        wasFallback,
        edited: false,
        updatedAt: replyNow,
      };
      conv.messages[targetIdx] = assistantMsg;
    } else {
      assistantMsg = {
        id: createRecordId('smsg'),
        conversationId: conv.id,
        role: 'assistant',
        content: replyText,
        providerId,
        model,
        wasFallback,
        edited: false,
        createdAt: replyNow,
        updatedAt: replyNow,
      };
      conv.messages.push(assistantMsg);
    }

    conv.lastMessagePreview = assistantMsg.content.slice(0, 120);
    conv.updatedAt = replyNow;
    tenant.conversations[convIdx] = conv;
    saveTenant(scope, root, tenant);

    void syncRowsToSupabase(
      'sales_conversations',
      [
        {
          id: conv.id,
          owner_uid: scope,
          workspace_id: 'ws-74-studio-sales',
          title: conv.title,
          artist_name: conv.artistName || null,
          last_message_preview: conv.lastMessagePreview,
          pinned: Boolean(conv.pinned),
          created_at: conv.createdAt,
          updated_at: conv.updatedAt,
        },
      ],
      'owner_uid,id'
    );
    const msgsToSync = [userMsg, assistantMsg].filter((m): m is SalesChatMessage => Boolean(m));
    void syncRowsToSupabase(
      'sales_messages',
      msgsToSync.map((m) => ({
        id: m.id,
        owner_uid: scope,
        conversation_id: conv.id,
        workspace_id: 'ws-74-studio-sales',
        role: m.role,
        content: m.content,
        artist_note: m.artistNote || null,
        attachment_name: m.attachmentName || null,
        provider_id: m.providerId || null,
        model: m.model || null,
        was_fallback: Boolean(m.wasFallback),
        edited: Boolean(m.edited),
        created_at: m.createdAt,
        updated_at: m.updatedAt,
      })),
      'owner_uid,id'
    );

    return res.json({
      conversation: conv,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
    });
  });

  // Inline Edit of an Existing Assistant Message (preserves lowercase rule if enforceLowercase)
  app.patch(
    '/api/sales/conversations/:convId/messages/:msgId',
    jsonLimit,
    salesGuard,
    (req: AuthenticatedRequest, res: Response) => {
      const scope = getTenantScopeKey(req);
      const { root, tenant } = loadTenant(scope);
      const convId = String(req.params.convId || '');
      const msgId = String(req.params.msgId || '');
      const convIdx = tenant.conversations.findIndex((c) => c.id === convId);
      if (convIdx === -1) return res.status(404).json({ error: 'Conversation not found.' });

      const msgIdx = tenant.conversations[convIdx].messages.findIndex((m) => m.id === msgId);
      if (msgIdx === -1) return res.status(404).json({ error: 'Message not found.' });

      const rawContent = String((req.body as { content?: string } | undefined)?.content || '').trim();
      if (!rawContent) return res.status(400).json({ error: 'Message content cannot be empty.' });

      const prevMsg = tenant.conversations[convIdx].messages[msgIdx];
      const nextContent =
        prevMsg.role === 'assistant' ? enforceStrictLowercaseReply(rawContent) : rawContent;
      const now = new Date().toISOString();
      const updatedMsg: SalesChatMessage = {
        ...prevMsg,
        content: nextContent,
        edited: true,
        updatedAt: now,
      };
      tenant.conversations[convIdx].messages[msgIdx] = updatedMsg;
      if (msgIdx === tenant.conversations[convIdx].messages.length - 1) {
        tenant.conversations[convIdx].lastMessagePreview = nextContent.slice(0, 120);
      }
      tenant.conversations[convIdx].updatedAt = now;
      saveTenant(scope, root, tenant);
      void syncRowsToSupabase(
        'sales_messages',
        [
          {
            id: updatedMsg.id,
            owner_uid: scope,
            conversation_id: convId,
            workspace_id: 'ws-74-studio-sales',
            role: updatedMsg.role,
            content: updatedMsg.content,
            edited: true,
            created_at: updatedMsg.createdAt,
            updated_at: updatedMsg.updatedAt,
          },
        ],
        'owner_uid,id'
      );
      return res.json({ message: updatedMsg, conversation: tenant.conversations[convIdx] });
    }
  );

  // ============================================================================
  // Archived Legacy CRM Read-Only / Recovery Routes (Preserved Without Data Loss)
  // ============================================================================
  app.get('/api/sales/leads', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ leads: tenant.leads });
  });

  app.get('/api/sales/outputs', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ outputs: tenant.outputs });
  });

  app.get('/api/sales/activities', salesGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { tenant } = loadTenant(scope);
    return res.json({ activities: tenant.activities.slice(0, 120) });
  });

  // Checkpoint-enabled proposal continuation kept for existing outputs
  app.post('/api/sales/proposals/continue-manifest', jsonLimit, salesGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = getTenantScopeKey(req);
    const { root, tenant } = loadTenant(scope);
    const { outputId, manifest, proposalTitle } = (req.body || {}) as {
      outputId?: string;
      manifest?: LongFormDocumentManifest;
      proposalTitle?: string;
    };

    const existingOutput = outputId ? tenant.outputs.find((o) => o.id === outputId) : undefined;
    const effectiveManifest = manifest || existingOutput?.manifest;
    if (!effectiveManifest || !Array.isArray(effectiveManifest.sections)) {
      return res.status(400).json({ error: 'manifest or valid outputId with manifest is required.' });
    }

    try {
      const result = await executeSectionManifestGeneration({
        workspaceId: 'ws-74-studio-sales',
        taskType: 'sales-proposal-longform',
        manifest: effectiveManifest,
        documentTitle: proposalTitle || existingOutput?.title || '74 studio proposal',
        contextSummary: buildKbCatalogPrompt(tenant.knowledgeBase, tenant.settings),
        targetWordsPerSection: 200,
        stream: false,
        onSectionDone: (_sec, updatedManifest) => {
          if (existingOutput) {
            const idx = tenant.outputs.findIndex((o) => o.id === existingOutput.id);
            if (idx >= 0) {
              tenant.outputs[idx] = {
                ...tenant.outputs[idx],
                manifest: updatedManifest,
                updatedAt: new Date().toISOString(),
              };
              saveTenant(scope, root, tenant);
            }
          }
        },
      });
      return res.json({
        output: existingOutput,
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
}
