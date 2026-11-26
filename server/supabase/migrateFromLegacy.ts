import fs from 'fs';
import path from 'path';
import type { Express, Response } from 'express';
import {
  type AuthenticatedRequest,
  requireServerOperator,
} from '../aiProviders/authMiddleware';
import {
  SUPABASE_BUCKETS,
  ensureSupabaseStorageBuckets,
  getSupabaseAdmin,
  getSupabaseConfigDiagnostics,
} from './client';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const MIGRATION_STATUS_FILE = 'supabase-migration-status.json';

export interface MigrationSummaryReport {
  configured: boolean;
  dryRun: boolean;
  migratedAt: string;
  counts: {
    workspaces: number;
    oauthConnections: number;
    scheduledJobs: number;
    publishHistory: number;
    marketingDrafts: number;
    marketingSources: number;
    salesKnowledgeBases: number;
    salesLegacyLeads: number;
    salesLegacyOutputs: number;
    salesLegacyActivities: number;
    salesConversations: number;
    salesMessages: number;
    aiProfiles: number;
    videoProjects: number;
  };
  buckets: string[];
  warnings: string[];
}

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface DiscoveredVideoProjectEntry {
  project: Record<string, unknown>;
  sourceFile: string;
}

/**
 * Discovers Video Studio projects for `ownerUid` cleanly across both:
 * 1) Modern scoped files written by `server/videoStudio.ts`: `.data/video-studio-${safeScope}.json` (`{ projects, updatedAt }`)
 * 2) Legacy multi-tenant or flat `.data/video-studio.json` (`{ tenants: { [ownerUid]: { projects } } }` or `{ projects }`)
 * Deduplicates by `project.id`, giving precedence to the user's scoped file without mutating or deleting source files.
 */
export function extractLegacyVideoStudioProjectsForOwner(
  dataDir: string,
  ownerUid: string
): DiscoveredVideoProjectEntry[] {
  const safeScope = ownerUid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const candidateFiles = new Set<string>();

  // 1. User-scoped file written by videoStudio.ts
  candidateFiles.add(path.join(dataDir, `video-studio-${safeScope}.json`));

  // 2. Local operator fallback file when migrating preview state into signed-in ownerUid
  if (safeScope !== 'local-operator') {
    candidateFiles.add(path.join(dataDir, 'video-studio-local-operator.json'));
  }

  // 3. Legacy unified/preview filename
  candidateFiles.add(path.join(dataDir, 'video-studio.json'));

  const deduped = new Map<string, DiscoveredVideoProjectEntry>();

  const ingestList = (items: unknown, sourceFile: string) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const proj = raw as Record<string, unknown>;
      const id = String(proj.id || '').trim();
      if (!id || deduped.has(id)) continue;
      deduped.set(id, { project: proj, sourceFile });
    }
  };

  for (const filePath of candidateFiles) {
    const parsed = readJsonIfExists<{
      projects?: unknown;
      tenants?: Record<string, { projects?: unknown }>;
    }>(filePath);
    if (!parsed) continue;

    if (Array.isArray(parsed.projects)) {
      ingestList(parsed.projects, path.basename(filePath));
    }
    if (parsed.tenants && typeof parsed.tenants === 'object') {
      const ownerBucket = parsed.tenants[ownerUid];
      if (ownerBucket && Array.isArray(ownerBucket.projects)) {
        ingestList(ownerBucket.projects, path.basename(filePath));
      }
      const localBucket = parsed.tenants['local-operator'];
      if (localBucket && Array.isArray(localBucket.projects)) {
        ingestList(localBucket.projects, path.basename(filePath));
      }
    }
  }

  return Array.from(deduped.values());
}

function recordMigrationStatusSnapshot(ownerUid: string, report: MigrationSummaryReport): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const statusPath = path.join(DATA_DIR, MIGRATION_STATUS_FILE);
    const existing = readJsonIfExists<Record<string, unknown>>(statusPath) || {};
    const owners = (existing.owners && typeof existing.owners === 'object'
      ? existing.owners
      : {}) as Record<string, unknown>;
    owners[ownerUid] = {
      migratedAt: report.migratedAt,
      dryRun: report.dryRun,
      counts: report.counts,
      warnings: report.warnings,
      completedWithoutErrors: report.warnings.length === 0,
    };
    const tmp = `${statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...existing, owners, updatedAt: report.migratedAt }, null, 2));
    fs.renameSync(tmp, statusPath);
  } catch {
    // Non-fatal diagnostic persistence
  }
}

/**
 * Idempotently imports all existing local/legacy `.data/*.json` & optional Firestore export snapshots
 * into normalized Supabase PostgreSQL tables without deleting source files or resetting IDs.
 */
export async function runIdempotentLegacyMigration(opts: {
  ownerUid: string;
  dryRun?: boolean;
  firestoreSnapshot?: {
    connections?: Array<Record<string, unknown>>;
    scheduledJobs?: Array<Record<string, unknown>>;
    publishHistory?: Array<Record<string, unknown>>;
    marketingDrafts?: Array<Record<string, unknown>>;
  };
}): Promise<MigrationSummaryReport> {
  const diag = getSupabaseConfigDiagnostics();
  const nowIso = new Date().toISOString();
  const report: MigrationSummaryReport = {
    configured: diag.configured,
    dryRun: Boolean(opts.dryRun),
    migratedAt: nowIso,
    counts: {
      workspaces: 0,
      oauthConnections: 0,
      scheduledJobs: 0,
      publishHistory: 0,
      marketingDrafts: 0,
      marketingSources: 0,
      salesKnowledgeBases: 0,
      salesLegacyLeads: 0,
      salesLegacyOutputs: 0,
      salesLegacyActivities: 0,
      salesConversations: 0,
      salesMessages: 0,
      aiProfiles: 0,
      videoProjects: 0,
    },
    buckets: [],
    warnings: [],
  };

  const client = getSupabaseAdmin();
  if (!client) {
    report.warnings.push(
      `Supabase migration skipped live writes because env vars are missing: ${diag.missingEnvVars.join(', ')}`
    );
    return report;
  }

  const upsert = async (table: string, rows: Array<Record<string, unknown>>, onConflict: string) => {
    if (rows.length === 0) return 0;
    if (opts.dryRun) return rows.length;
    const { error } = await client.from(table).upsert(rows, { onConflict });
    if (error) {
      report.warnings.push(`${table}: ${error.message}`);
      return 0;
    }
    return rows.length;
  };

  // 1. Workspaces baseline (preserving exact workspace IDs)
  report.counts.workspaces = await upsert(
    'workspaces',
    [
      {
        id: 'ws-behind-the-release',
        owner_uid: opts.ownerUid,
        business_workspace: 'behind-the-release',
        name: 'Behind The Release',
        tagline: 'Music Release Visuals, Creative Studio & Marketing Intelligence',
        updated_at: nowIso,
      },
      {
        id: 'ws-74-studio-sales',
        owner_uid: opts.ownerUid,
        business_workspace: '74-studio-sales',
        name: '74 STUDIO Sales Intelligence',
        tagline: '74 STUDIO Artist Chat Assistant & Pricing KB',
        updated_at: nowIso,
      },
    ],
    'owner_uid,id'
  );

  // 2. Integrations vault (.data/integrations-vault.json) preserving encrypted tokens
  const vault = readJsonIfExists<{
    connections?: Record<string, Record<string, unknown>>;
    scheduledJobs?: Record<string, Record<string, unknown>>;
    publishHistory?: Array<Record<string, unknown>>;
  }>(path.join(DATA_DIR, 'integrations-vault.json'));

  if (vault?.connections) {
    const connRows = Object.entries(vault.connections).map(([key, c]) => ({
      id: key,
      owner_uid: opts.ownerUid,
      workspace_id: String(c.workspaceId || 'ws-behind-the-release'),
      platform: String(c.platform || 'instagram'),
      account_id: String(c.accountId || ''),
      account_name: String(c.accountName || ''),
      account_handle: c.accountHandle ? String(c.accountHandle) : null,
      encrypted_access_token_json: c.encryptedAccessToken || {},
      encrypted_refresh_token_json: c.encryptedRefreshToken || null,
      token_type: c.tokenType ? String(c.tokenType) : null,
      expires_at: typeof c.expiresAt === 'number' ? c.expiresAt : null,
      last_error: c.lastError ? String(c.lastError) : null,
      connected_at: String(c.connectedAt || nowIso),
      updated_at: String(c.updatedAt || nowIso),
    }));
    report.counts.oauthConnections = await upsert('oauth_connections', connRows, 'owner_uid,id');
  }

  if (vault?.scheduledJobs) {
    const jobRows = Object.values(vault.scheduledJobs).map((j) => ({
      id: String(j.id),
      owner_uid: opts.ownerUid,
      workspace_id: String(j.workspaceId || 'ws-behind-the-release'),
      post_id: String(j.postId || ''),
      title: String(j.title || 'Untitled Post'),
      platform: String(j.platform || 'instagram-reel'),
      platforms_json: j.platforms || [],
      destinations_json: j.destinations || [],
      caption: String(j.caption || ''),
      hashtags_json: j.hashtags || [],
      youtube_privacy_status: j.youtubePrivacyStatus ? String(j.youtubePrivacyStatus) : null,
      scheduled_iso: String(j.scheduledIso || nowIso),
      timezone: String(j.timezone || 'Africa/Lagos'),
      campaign_id: j.campaignId ? String(j.campaignId) : null,
      media_asset_ids_json: j.mediaAssetIds || [],
      status: String(j.status || 'scheduled'),
      attempts: Number(j.attempts || 0),
      published_at: j.publishedAt ? String(j.publishedAt) : null,
      platform_post_id: j.platformPostId ? String(j.platformPostId) : null,
      result_url: j.resultUrl ? String(j.resultUrl) : null,
      error: j.error ? String(j.error) : null,
      created_at: String(j.createdAt || nowIso),
      updated_at: String(j.updatedAt || nowIso),
    }));
    report.counts.scheduledJobs = await upsert('scheduled_jobs', jobRows, 'owner_uid,id');
  }

  if (Array.isArray(vault?.publishHistory)) {
    const histRows = vault.publishHistory.map((h) => ({
      id: String(h.id),
      owner_uid: opts.ownerUid,
      workspace_id: String(h.workspaceId || 'ws-behind-the-release'),
      post_id: String(h.postId || ''),
      job_id: h.jobId ? String(h.jobId) : null,
      title: String(h.title || ''),
      platform: String(h.platform || 'instagram-reel'),
      mode: String(h.mode || 'manual-send'),
      status: String(h.status || 'published'),
      platform_post_id: h.platformPostId ? String(h.platformPostId) : null,
      result_url: h.resultUrl ? String(h.resultUrl) : null,
      error: h.error ? String(h.error) : null,
      timestamp: String(h.timestamp || nowIso),
    }));
    report.counts.publishHistory = await upsert('publish_history', histRows, 'owner_uid,id');
  }

  // 3. Marketing Studio (.data/marketing-studio.json)
  const mkt = readJsonIfExists<{
    knowledgeBase?: Record<string, unknown>;
    researchSources?: Array<Record<string, unknown>>;
    drafts?: Array<Record<string, unknown>>;
  }>(path.join(DATA_DIR, 'marketing-studio.json'));

  if (mkt?.knowledgeBase) {
    await upsert(
      'marketing_knowledge_bases',
      [
        {
          id: String(mkt.knowledgeBase.id || 'kb-74-studio'),
          owner_uid: opts.ownerUid,
          workspace_id: 'ws-behind-the-release',
          config_json: mkt.knowledgeBase,
          updated_at: String(mkt.knowledgeBase.updatedAt || nowIso),
        },
      ],
      'owner_uid,id'
    );
  }
  if (Array.isArray(mkt?.researchSources)) {
    report.counts.marketingSources = await upsert(
      'marketing_research_sources',
      mkt.researchSources.map((s) => ({
        id: String(s.id),
        owner_uid: opts.ownerUid,
        workspace_id: 'ws-behind-the-release',
        source_name: String(s.sourceName || ''),
        source_url: String(s.sourceUrl || ''),
        category: String(s.category || 'audience-insight'),
        data_classification: String(s.dataClassification || 'verified-fact'),
        access_method: String(s.accessMethod || 'owner-supplied'),
        record_json: s,
        created_at: nowIso,
      })),
      'owner_uid,id'
    );
  }
  if (Array.isArray(mkt?.drafts)) {
    report.counts.marketingDrafts = await upsert(
      'marketing_drafts',
      mkt.drafts.map((d) => ({
        id: String(d.id),
        owner_uid: opts.ownerUid,
        workspace_id: 'ws-behind-the-release',
        title: String(d.title || 'Untitled Draft'),
        status: String(d.status || 'draft'),
        draft_json: d,
        created_at: String(d.createdAt || nowIso),
        updated_at: String(d.updatedAt || nowIso),
      })),
      'owner_uid,id'
    );
  }

  // 4. Sales Intelligence (.data/sales-intelligence.json) including archived legacy leads/outputs/activities + chats
  const salesRoot = readJsonIfExists<{
    tenants?: Record<string, Record<string, unknown>>;
  }>(path.join(DATA_DIR, 'sales-intelligence.json'));

  const tenantState = salesRoot?.tenants?.[opts.ownerUid] || salesRoot?.tenants?.['local-operator'];
  if (tenantState) {
    const kb = tenantState.knowledgeBase as Record<string, unknown> | undefined;
    const settings = tenantState.settings as Record<string, unknown> | undefined;
    if (kb) {
      report.counts.salesKnowledgeBases = await upsert(
        'sales_knowledge_bases',
        [
          {
            id: String(kb.id || 'kb-74-studio-sales'),
            owner_uid: opts.ownerUid,
            workspace_id: 'ws-74-studio-sales',
            config_json: kb,
            settings_json: settings || {
              promoEnabled: true,
              promoPercentage: 10,
              promoLabel: '10% off all orders',
              promoScope: 'all orders including custom quotes',
              enforceLowercase: true,
            },
            updated_at: String(kb.updatedAt || nowIso),
          },
        ],
        'owner_uid,id'
      );
    }

    const legacyLeads = Array.isArray(tenantState.leads) ? (tenantState.leads as Array<Record<string, unknown>>) : [];
    if (legacyLeads.length > 0) {
      report.counts.salesLegacyLeads = await upsert(
        'sales_legacy_leads',
        legacyLeads.map((l) => ({
          id: String(l.id),
          owner_uid: opts.ownerUid,
          workspace_id: 'ws-74-studio-sales',
          name: String(l.name || ''),
          stage: String(l.stage || 'archived'),
          record_json: l,
          created_at: String(l.createdAt || nowIso),
          updated_at: String(l.updatedAt || nowIso),
        })),
        'owner_uid,id'
      );
    }

    const legacyOutputs = Array.isArray(tenantState.outputs)
      ? (tenantState.outputs as Array<Record<string, unknown>>)
      : [];
    if (legacyOutputs.length > 0) {
      report.counts.salesLegacyOutputs = await upsert(
        'sales_legacy_outputs',
        legacyOutputs.map((o) => ({
          id: String(o.id),
          owner_uid: opts.ownerUid,
          workspace_id: 'ws-74-studio-sales',
          lead_id: String(o.leadId || ''),
          output_type: String(o.outputType || 'personalized-response'),
          title: String(o.title || ''),
          record_json: o,
          created_at: String(o.createdAt || nowIso),
          updated_at: String(o.updatedAt || nowIso),
        })),
        'owner_uid,id'
      );
    }

    const legacyActivities = Array.isArray(tenantState.activities)
      ? (tenantState.activities as Array<Record<string, unknown>>)
      : [];
    if (legacyActivities.length > 0) {
      report.counts.salesLegacyActivities = await upsert(
        'sales_legacy_activities',
        legacyActivities.map((a) => ({
          id: String(a.id),
          owner_uid: opts.ownerUid,
          workspace_id: 'ws-74-studio-sales',
          activity_type: String(a.activityType || 'stage-updated'),
          summary: String(a.summary || ''),
          record_json: a,
          timestamp: String(a.timestamp || nowIso),
        })),
        'owner_uid,id'
      );
    }

    const conversations = Array.isArray(tenantState.conversations)
      ? (tenantState.conversations as Array<Record<string, unknown>>)
      : [];
    if (conversations.length > 0) {
      report.counts.salesConversations = await upsert(
        'sales_conversations',
        conversations.map((c) => ({
          id: String(c.id),
          owner_uid: opts.ownerUid,
          workspace_id: 'ws-74-studio-sales',
          title: String(c.title || 'New Chat'),
          artist_name: c.artistName ? String(c.artistName) : null,
          last_message_preview: String(c.lastMessagePreview || ''),
          pinned: Boolean(c.pinned),
          archived: Boolean(c.archived),
          created_at: String(c.createdAt || nowIso),
          updated_at: String(c.updatedAt || nowIso),
        })),
        'owner_uid,id'
      );

      const allMsgs: Array<Record<string, unknown>> = [];
      for (const conv of conversations) {
        const msgs = Array.isArray(conv.messages) ? (conv.messages as Array<Record<string, unknown>>) : [];
        for (const m of msgs) {
          allMsgs.push({
            id: String(m.id),
            owner_uid: opts.ownerUid,
            conversation_id: String(conv.id),
            workspace_id: 'ws-74-studio-sales',
            role: m.role === 'artist' ? 'artist' : 'assistant',
            content: String(m.content || ''),
            artist_note: m.artistNote ? String(m.artistNote) : null,
            attachment_name: m.attachmentName ? String(m.attachmentName) : null,
            attachment_url: m.attachmentUrl ? String(m.attachmentUrl) : null,
            provider_id: m.providerId ? String(m.providerId) : null,
            model: m.model ? String(m.model) : null,
            was_fallback: Boolean(m.wasFallback),
            edited: Boolean(m.edited),
            created_at: String(m.createdAt || nowIso),
            updated_at: String(m.updatedAt || nowIso),
          });
        }
      }
      report.counts.salesMessages = await upsert('sales_messages', allMsgs, 'owner_uid,id');
    }
  }

  // 5. AI Provider Manager Profiles (.data/ai-provider-manager.json)
  const aiMgr = readJsonIfExists<{
    workspaceConfigs?: Record<string, Record<string, unknown>>;
  }>(path.join(DATA_DIR, 'ai-provider-manager.json'));
  if (aiMgr?.workspaceConfigs) {
    report.counts.aiProfiles = await upsert(
      'ai_provider_profiles',
      Object.entries(aiMgr.workspaceConfigs).map(([wsId, cfg]) => ({
        workspace_id: wsId,
        owner_uid: opts.ownerUid,
        config_json: cfg,
        updated_at: String(cfg.updatedAt || nowIso),
      })),
      'owner_uid,workspace_id'
    );
  }

  // 6. Video Studio projects (.data/video-studio-${scopeKey}.json & legacy .data/video-studio.json)
  const discoveredVideoProjects = extractLegacyVideoStudioProjectsForOwner(DATA_DIR, opts.ownerUid);
  if (discoveredVideoProjects.length > 0) {
    let migratedProjectCount = 0;
    for (const { project: p } of discoveredVideoProjects) {
      const projectId = String(p.id);
      const projRow = {
        id: projectId,
        owner_uid: opts.ownerUid,
        workspace_id: 'ws-behind-the-release',
        title: String(p.title || 'Untitled Video'),
        topic: String(p.topic || ''),
        audience: String(p.audience || ''),
        visual_style: String(p.primaryStyle || p.visualStyle || 'stickman'),
        aspect_ratio: String(p.aspectRatio || '9:16'),
        target_duration_sec: Number(p.targetDurationSeconds || p.targetDurationSec || 75),
        fps: Number(p.fps || 30),
        status: String(p.status || 'draft'),
        script_approved: Boolean(p.approvedForRender ?? p.scriptApproved),
        storyboard_json: Array.isArray(p.scenes) ? p.scenes : [],
        audio_config_json: p.audio || p.audioConfig || {},
        settings_json: p.captionStyle || p.renderSettings || {},
        created_at: String(p.createdAt || nowIso),
        updated_at: String(p.updatedAt || nowIso),
      };

      const projCount = await upsert('video_projects', [projRow], 'owner_uid,id');
      if (projCount === 0 && !opts.dryRun) {
        // Never mark project scenes/renders or count as migrated when parent write fails
        continue;
      }

      const rawScenes = Array.isArray(p.scenes) ? (p.scenes as Array<Record<string, unknown>>) : [];
      if (rawScenes.length > 0) {
        const sceneRows = rawScenes.map((sc, idx) => {
          const motion = (sc.motion && typeof sc.motion === 'object' ? sc.motion : {}) as Record<string, unknown>;
          const cartoon = (sc.cartoon && typeof sc.cartoon === 'object' ? sc.cartoon : {}) as Record<string, unknown>;
          const subtitle = String(sc.subtitleText || sc.narrationText || '');
          return {
            id: String(sc.id || `${projectId}-sc-${idx}`),
            owner_uid: opts.ownerUid,
            project_id: projectId,
            scene_order: typeof sc.orderIndex === 'number' ? sc.orderIndex : idx,
            visual_style: String(sc.style || p.primaryStyle || 'stickman'),
            duration_sec: Number(sc.durationSeconds || 6),
            narration_text: String(sc.narrationText || ''),
            on_screen_text: String(motion.headline || sc.title || ''),
            stickman_config_json: sc.stickman || {},
            cartoon_config_json: cartoon,
            motion_config_json: motion,
            subtitle_words_json: subtitle.split(/\s+/).filter(Boolean),
            transition_type: String(motion.transition || 'crossfade'),
            background_preset: String(cartoon.backgroundPreset || 'minimal-dark'),
            created_at: String(p.createdAt || nowIso),
            updated_at: String(p.updatedAt || nowIso),
          };
        });
        await upsert('video_scenes', sceneRows, 'owner_uid,id');
      }

      const rawRenders = Array.isArray(p.renders) ? (p.renders as Array<Record<string, unknown>>) : [];
      if (rawRenders.length > 0) {
        const renderRows = rawRenders.map((r) => {
          const resStr = String(r.resolution || '1080x1920');
          const [wStr, hStr] = resStr.split('x');
          return {
            id: String(r.id),
            owner_uid: opts.ownerUid,
            project_id: projectId,
            format: String(r.format || 'mp4'),
            width: Number(r.width || wStr || 1080),
            height: Number(r.height || hStr || 1920),
            fps: Number(r.fps || 30),
            duration_sec: Number(r.durationSeconds || 75),
            status: String(r.status || 'completed'),
            progress_pct: Number(r.progress ?? 100),
            checkpoint_json: {
              engine: r.engine || 'remotion-web',
              lastCheckpointFrame: r.lastCheckpointFrame,
            },
            storage_path: r.storagePath ? String(r.storagePath) : null,
            error_message: r.error ? String(r.error) : null,
            created_at: String(r.createdAt || nowIso),
            completed_at: r.status === 'completed' ? String(r.createdAt || nowIso) : null,
          };
        });
        await upsert('video_renders', renderRows, 'owner_uid,id');
      }

      migratedProjectCount += 1;
    }
    report.counts.videoProjects = migratedProjectCount;
  }

  // 7. Provision storage buckets idempotently
  if (!opts.dryRun) {
    const bucketRes = await ensureSupabaseStorageBuckets();
    report.buckets = bucketRes.createdOrVerified;
    report.warnings.push(...bucketRes.errors);
  }

  if (!opts.dryRun && report.warnings.length === 0) {
    recordMigrationStatusSnapshot(opts.ownerUid, report);
  } else if (!opts.dryRun) {
    recordMigrationStatusSnapshot(opts.ownerUid, report);
  }

  return report;
}

export function registerSupabaseSystemRoutes(app: Express): void {
  const authGuard = requireServerOperator();

  app.get('/api/system/persistence-status', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const diag = getSupabaseConfigDiagnostics();
    const client = getSupabaseAdmin();
    let tableCheckOk = false;
    const reachableTables: string[] = [];
    const missingTables: string[] = [];
    let bucketCheck: string[] = [];
    let diagnosticDetail: string | undefined;

    if (client) {
      try {
        const expectedTables = [
          'workspaces',
          'oauth_connections',
          'scheduled_jobs',
          'marketing_drafts',
          'sales_conversations',
          'video_projects',
          'video_scenes',
          'video_renders',
        ];
        for (const tbl of expectedTables) {
          const { error } = await client.from(tbl).select('id').limit(1);
          if (!error) {
            reachableTables.push(tbl);
          } else {
            missingTables.push(`${tbl}: ${error.message}`);
          }
        }
        tableCheckOk = reachableTables.length > 0 && missingTables.length === 0;
        const { data: buckets, error: bucketErr } = await client.storage.listBuckets();
        if (!bucketErr && Array.isArray(buckets)) {
          bucketCheck = buckets.map((b) => b.name);
        } else if (bucketErr) {
          diagnosticDetail = `Storage listBuckets error: ${bucketErr.message}`;
        }
      } catch (err) {
        tableCheckOk = false;
        diagnosticDetail = err instanceof Error ? err.message : 'Supabase probe failed';
      }
    }

    const migrationStatus = readJsonIfExists<Record<string, unknown>>(
      path.join(DATA_DIR, MIGRATION_STATUS_FILE)
    );

    const localFiles = [
      'sales-intelligence.json',
      'integrations-vault.json',
      'marketing-studio.json',
      'ai-provider-manager.json',
    ].map((f) => {
      const p = path.join(DATA_DIR, f);
      const exists = fs.existsSync(p);
      let recordCountHint = 0;
      if (exists) {
        try {
          const stats = fs.statSync(p);
          recordCountHint = Math.max(1, Math.round(stats.size / 250));
        } catch {
          // ignore stat errors
        }
      }
      return { file: f, exists, recordCountHint };
    });

    return res.json({
      firebaseAuthActive: true,
      supabaseConfigured: diag.configured,
      urlValid: diag.urlValid,
      secretKeyConfigured: diag.serviceRoleSet,
      missingEnvVars: diag.missingEnvVars,
      supabaseTablesReachable: tableCheckOk,
      reachableTables,
      missingTables,
      expectedStorageBuckets: [...SUPABASE_BUCKETS],
      storageBuckets: bucketCheck,
      missingStorageBuckets: SUPABASE_BUCKETS.filter((b) => !bucketCheck.includes(b)),
      diagnosticDetail,
      migrationStatusRecorded: Boolean(migrationStatus),
      localDataDir: fs.existsSync(DATA_DIR),
      operatorScope: req.operatorContext?.ownerScopeKey || 'local-operator',
      supabase: {
        configured: diag.configured,
        urlPresent: diag.urlValid,
        anonKeyPresent: diag.anonKeySet,
        serviceRolePresent: diag.serviceRoleSet,
      },
      localFiles,
    });
  });

  /**
   * Isolated non-destructive Supabase CRUD & Storage self-test using dedicated probe records/files
   * cleaned up immediately in `finally`. Never touches existing user tables or production data.
   */
  app.post('/api/system/supabase-self-test', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const diag = getSupabaseConfigDiagnostics();
    const client = getSupabaseAdmin();
    if (!diag.configured || !client) {
      return res.status(503).json({
        ok: false,
        error: `Supabase is not configured. Missing: ${diag.missingEnvVars.join(', ')}`,
      });
    }

    const ownerUid = req.operatorContext?.ownerScopeKey || 'local-operator';
    const probeId = `__audit_probe_${Date.now()}`;
    const probePath = `${ownerUid}/${probeId}.txt`;
    const dbCheck = { insert: false, read: false, update: false, delete: false, error: '' };
    const storageCheck = { upload: false, download: false, delete: false, error: '' };

    try {
      const nowIso = new Date().toISOString();
      const ins = await client.from('workspaces').upsert(
        [
          {
            id: probeId,
            owner_uid: ownerUid,
            business_workspace: 'behind-the-release',
            name: 'Audit Probe Temporary',
            tagline: 'Isolated self-test probe',
            updated_at: nowIso,
          },
        ],
        { onConflict: 'owner_uid,id' }
      );
      if (ins.error) {
        dbCheck.error = ins.error.message;
      } else {
        dbCheck.insert = true;
        const rd = await client
          .from('workspaces')
          .select('id,name')
          .eq('owner_uid', ownerUid)
          .eq('id', probeId)
          .single();
        if (rd.error || rd.data?.id !== probeId) {
          dbCheck.error = rd.error?.message || 'Probe row read mismatch';
        } else {
          dbCheck.read = true;
          const upd = await client
            .from('workspaces')
            .update({ name: 'Audit Probe Updated' })
            .eq('owner_uid', ownerUid)
            .eq('id', probeId);
          if (upd.error) {
            dbCheck.error = upd.error.message;
          } else {
            dbCheck.update = true;
          }
        }
      }
    } catch (err) {
      dbCheck.error = err instanceof Error ? err.message : String(err);
    } finally {
      const del = await client
        .from('workspaces')
        .delete()
        .eq('owner_uid', ownerUid)
        .eq('id', probeId);
      if (!del.error) {
        dbCheck.delete = true;
      } else if (!dbCheck.error) {
        dbCheck.error = del.error.message;
      }
    }

    try {
      const probeBuf = Buffer.from(`supabase-self-test:${probeId}`, 'utf8');
      const up = await client.storage.from('video-studio').upload(probePath, probeBuf, {
        contentType: 'text/plain',
        upsert: true,
      });
      if (up.error) {
        storageCheck.error = up.error.message;
      } else {
        storageCheck.upload = true;
        const dl = await client.storage.from('video-studio').download(probePath);
        if (dl.error || !dl.data) {
          storageCheck.error = dl.error?.message || 'Storage download failed';
        } else {
          const txt = await dl.data.text();
          storageCheck.download = txt === `supabase-self-test:${probeId}`;
        }
      }
    } catch (err) {
      storageCheck.error = err instanceof Error ? err.message : String(err);
    } finally {
      const rm = await client.storage.from('video-studio').remove([probePath]);
      if (!rm.error) {
        storageCheck.delete = true;
      } else if (!storageCheck.error) {
        storageCheck.error = rm.error.message;
      }
    }

    const ok =
      dbCheck.insert &&
      dbCheck.read &&
      dbCheck.update &&
      dbCheck.delete &&
      storageCheck.upload &&
      storageCheck.download &&
      storageCheck.delete;

    return res.status(ok ? 200 : 500).json({
      ok,
      dbCheck,
      storageCheck,
    });
  });

  app.post('/api/system/migrate-to-supabase', authGuard, async (req: AuthenticatedRequest, res: Response) => {
    const ownerUid = req.operatorContext?.ownerScopeKey || 'local-operator';
    const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
    const firestoreSnapshot = (req.body as {
      firestoreSnapshot?: {
        connections?: Array<Record<string, unknown>>;
        scheduledJobs?: Array<Record<string, unknown>>;
        publishHistory?: Array<Record<string, unknown>>;
        marketingDrafts?: Array<Record<string, unknown>>;
      };
    } | undefined)?.firestoreSnapshot;

    const report = await runIdempotentLegacyMigration({
      ownerUid,
      dryRun,
      firestoreSnapshot,
    });
    return res.json({ ok: true, report, counts: report.counts });
  });
}
