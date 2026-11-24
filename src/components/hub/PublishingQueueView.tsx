import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  History,
  Instagram,
  Loader2,
  PenSquare,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  XCircle,
  Youtube,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import {
  integrationsClient,
  IntegrationsStatusResponse,
  MediaPreviewRef,
  PublishHistoryEntry,
  ScheduledJobSummary,
} from '../../services/integrationsClient';
import {
  DestinationPublishState,
  PublishingLifecycleStatus,
  SocialPlatform,
  SocialPost,
  YouTubePrivacyStatus,
} from '../../types/studio';
import {
  DEFAULT_PUBLISHING_TIMEZONE,
  computeEffectiveLifecycleStatus,
  formatDateInTimeZone,
  formatReadableDateTime,
  formatTimeInTimeZone,
  getPlatformLabel,
  getStatusLabel,
  zonedDateTimeToUtcIso,
} from '../../utils/publishing';
import {
  isNotFoundError,
  mergeServerAndCloudHistory,
  mergeServerAndCloudJobs,
  rehydrateBackendJob,
} from '../../utils/jobRecovery';
import { SendConfirmationModal, SendModalInput } from './SendConfirmationModal';

type QueueFilter = 'all' | PublishingLifecycleStatus;

const QUEUE_TABS: QueueFilter[] = [
  'all',
  'ready-to-send',
  'scheduled',
  'draft',
  'publishing',
  'published',
  'partially-published',
  'failed',
  'cancelled',
];

interface MergedQueueRow {
  id: string;
  jobId?: string;
  postId: string;
  title: string;
  platform: SocialPlatform;
  platforms: Array<'instagram' | 'youtube'>;
  destinations?: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledIso: string;
  timezone: string;
  effectiveStatus: PublishingLifecycleStatus;
  attempts: number;
  mediaAssetIds: string[];
  mediaCount: number;
  mediaPreviews?: MediaPreviewRef[];
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  needsReconciliation: boolean;
  localPost?: SocialPost;
  updatedAt: string;
}

function badgeClassForStatus(status: PublishingLifecycleStatus): string {
  switch (status) {
    case 'ready-to-send':
      return 'border-amber-400/60 bg-amber-500/15 text-amber-300';
    case 'published':
      return 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300';
    case 'partially-published':
      return 'border-amber-500/40 bg-amber-950/20 text-amber-200';
    case 'failed':
      return 'border-red-500/40 bg-red-950/20 text-red-300';
    case 'publishing':
      return 'border-sky-500/40 bg-sky-950/20 text-sky-300';
    case 'cancelled':
      return 'border-zinc-700 bg-zinc-900 text-zinc-500';
    case 'draft':
      return 'border-zinc-700 bg-zinc-900 text-zinc-400';
    default:
      return 'border-zinc-700 bg-zinc-900 text-zinc-200';
  }
}

export const PublishingQueueView: React.FC = () => {
  const {
    activeWorkspace,
    workspacePosts,
    workspaceMedia,
    savePost,
    deletePost,
    openPostComposerWithDraft,
    setNavSection,
    notify,
  } = useStudio();
  const { user, cloudJobs, cloudHistory, syncFromServerSnapshot } = useFirebase();

  const [filter, setFilter] = useState<QueueFilter>('all');
  const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
  const [history, setHistory] = useState<PublishHistoryEntry[]>([]);
  const [connStatus, setConnStatus] = useState<IntegrationsStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showHistory, setShowHistory] = useState(true);

  const [rescheduleRowId, setRescheduleRowId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('18:00');

  const [sendModalState, setSendModalState] = useState<{
    item: SendModalInput;
    defaultTargets?: Array<'instagram' | 'youtube'>;
  } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const refreshBackend = useCallback(async () => {
    setLoading(true);
    try {
      const [s, j, h] = await Promise.all([
        integrationsClient.getStatus(activeWorkspace.id, false),
        integrationsClient.listScheduledJobs(activeWorkspace.id),
        integrationsClient.listPublishHistory(activeWorkspace.id),
      ]);
      setConnStatus(s);
      setJobs(j);
      setHistory(h);
      if (user && user.emailVerified) {
        await syncFromServerSnapshot(activeWorkspace.id, s, j, h).catch(() => {});
      }
    } catch {
      // Ignore network hiccup
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace.id, syncFromServerSnapshot, user]);

  useEffect(() => {
    refreshBackend();
  }, [refreshBackend]);

  // Authoritative merge by postId: backend jobs + Firestore cloudJobs + unsynced localPosts
  const mergedRows = useMemo<MergedQueueRow[]>(() => {
    const byPostId = new Map<string, MergedQueueRow>();
    const authoritativeJobs = mergeServerAndCloudJobs(jobs, cloudJobs);

    for (const job of authoritativeJobs) {
      const localPost = workspacePosts.find((p) => p.id === job.postId);
      const effectiveStatus = computeEffectiveLifecycleStatus({
        rawStatus: job.status,
        scheduledIso: job.scheduledIso,
        destinations: job.destinations,
        nowMs,
      });
      const needsReconciliation = Boolean(
        job.destinations?.some((d) => d.needsReconciliation || d.status === 'publishing')
      );
      byPostId.set(job.postId, {
        id: job.id,
        jobId: job.id,
        postId: job.postId,
        title: job.title,
        platform: job.platform,
        platforms:
          job.platforms && job.platforms.length > 0
            ? job.platforms
            : [job.platform === 'youtube-shorts' ? 'youtube' : 'instagram'],
        destinations: job.destinations,
        caption: job.caption,
        hashtags: job.hashtags,
        youtubePrivacyStatus: job.youtubePrivacyStatus,
        scheduledIso: job.scheduledIso,
        timezone: job.timezone || DEFAULT_PUBLISHING_TIMEZONE,
        effectiveStatus,
        attempts: job.attempts,
        mediaAssetIds: job.mediaAssetIds || localPost?.mediaAssetIds || [],
        mediaCount: job.mediaCount,
        mediaPreviews: job.mediaPreviews,
        publishedAt: job.publishedAt,
        platformPostId: job.platformPostId,
        resultUrl: job.resultUrl,
        error: job.error,
        needsReconciliation,
        localPost,
        updatedAt: job.updatedAt || job.scheduledIso,
      });
    }

    for (const post of workspacePosts) {
      if (byPostId.has(post.id)) continue;
      const tz = post.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const scheduledIso =
        post.scheduledIso ||
        (post.scheduledDate
          ? zonedDateTimeToUtcIso(post.scheduledDate, post.scheduledTime || '18:00', tz)
          : post.updatedAt);
      const effectiveStatus = computeEffectiveLifecycleStatus({
        rawStatus: post.backendStatus || post.status,
        scheduledIso,
        nowMs,
      });
      byPostId.set(post.id, {
        id: post.id,
        jobId: post.backendJobId,
        postId: post.id,
        title: post.title,
        platform: post.platform,
        platforms: post.platforms || [post.platform === 'youtube-shorts' ? 'youtube' : 'instagram'],
        caption: post.caption,
        hashtags: post.hashtags,
        youtubePrivacyStatus: post.youtubePrivacyStatus,
        scheduledIso,
        timezone: tz,
        effectiveStatus,
        attempts: 0,
        mediaAssetIds: post.mediaAssetIds,
        mediaCount: post.mediaAssetIds.length,
        resultUrl: post.publishResultUrl,
        error: post.publishError,
        needsReconciliation: false,
        localPost: post,
        updatedAt: post.updatedAt,
      });
    }

    return Array.from(byPostId.values()).sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
  }, [jobs, cloudJobs, workspacePosts, nowMs]);

  const countsByStatus = useMemo(() => {
    const counts: Record<string, number> = { all: mergedRows.length };
    for (const row of mergedRows) {
      counts[row.effectiveStatus] = (counts[row.effectiveStatus] || 0) + 1;
    }
    return counts;
  }, [mergedRows]);

  const filtered = useMemo(
    () =>
      filter === 'all'
        ? mergedRows
        : mergedRows.filter((row) => row.effectiveStatus === filter),
    [mergedRows, filter]
  );

  const effectiveHistory = useMemo(
    () => mergeServerAndCloudHistory(history, cloudHistory),
    [history, cloudHistory]
  );

  const openSendModal = (
    row: MergedQueueRow,
    defaultTargets?: Array<'instagram' | 'youtube'>
  ) => {
    setSendModalState({
      item: {
        id: row.jobId,
        postId: row.postId,
        title: row.title,
        platform: row.platform,
        platforms: row.platforms,
        destinations: row.destinations,
        caption: row.caption,
        hashtags: row.hashtags,
        youtubePrivacyStatus: row.youtubePrivacyStatus,
        scheduledIso: row.scheduledIso,
        timezone: row.timezone,
        mediaAssetIds: row.mediaAssetIds,
        mediaCount: row.mediaCount,
        mediaPreviews: row.mediaPreviews,
        status: row.effectiveStatus,
      },
      defaultTargets,
    });
  };

  const buildRehydratePayload = (
    row: MergedQueueRow,
    overrides: Partial<{
      scheduledIso: string;
      timezone: string;
      status: PublishingLifecycleStatus;
    }> = {}
  ) => ({
    workspaceId: activeWorkspace.id,
    postId: row.postId,
    jobId: row.jobId,
    title: row.title,
    platform: row.platform,
    platforms: row.platforms,
    destinations: row.destinations,
    caption: row.caption,
    hashtags: row.hashtags,
    youtubePrivacyStatus: row.youtubePrivacyStatus,
    scheduledIso: overrides.scheduledIso || row.scheduledIso,
    timezone: overrides.timezone || row.timezone,
    campaignId: row.localPost?.campaignId,
    mediaAssetIds: row.mediaAssetIds,
    mediaCount: row.mediaCount,
    status: overrides.status || row.effectiveStatus,
    attempts: row.attempts,
    publishedAt: row.publishedAt,
    platformPostId: row.platformPostId,
    resultUrl: row.resultUrl,
    error: row.error,
  });

  const handleCancelJob = async (row: MergedQueueRow) => {
    setBusyId(row.id);
    try {
      if (row.jobId) {
        try {
          await integrationsClient.cancelScheduledJob(row.jobId);
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
          await rehydrateBackendJob(
            buildRehydratePayload(row, { status: 'cancelled' }),
            workspaceMedia
          );
        }
      }
      if (row.localPost) {
        savePost({ ...row.localPost, status: 'cancelled', backendStatus: 'cancelled' });
      }
      notify('info', 'Scheduled post cancelled');
      await refreshBackend();
    } catch (err) {
      notify('error', 'Cancel failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const handleReconcileRow = async (row: MergedQueueRow) => {
    if (!row.jobId) return;
    setBusyId(row.id);
    try {
      let res;
      try {
        res = await integrationsClient.reconcileScheduledJob(row.jobId);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        const restored = await rehydrateBackendJob(buildRehydratePayload(row), workspaceMedia);
        res = await integrationsClient.reconcileScheduledJob(restored.id);
      }
      const summary = Object.entries(res.outcomes)
        .map(([k, v]) => `${getPlatformLabel(k as 'instagram' | 'youtube')}: ${v.detail}`)
        .join(' | ');
      notify('info', 'Reconciliation Complete', summary || 'Status verified with platform.');
      await refreshBackend();
    } catch (err) {
      notify('error', 'Reconciliation failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const startReschedule = (row: MergedQueueRow) => {
    const tz = row.timezone || DEFAULT_PUBLISHING_TIMEZONE;
    setRescheduleRowId(row.id);
    setRescheduleDate(formatDateInTimeZone(row.scheduledIso, tz));
    setRescheduleTime(formatTimeInTimeZone(row.scheduledIso, tz));
  };

  const submitReschedule = async (row: MergedQueueRow) => {
    if (!rescheduleDate) return;
    const tz = row.timezone || DEFAULT_PUBLISHING_TIMEZONE;
    const scheduledIso = zonedDateTimeToUtcIso(rescheduleDate, rescheduleTime || '18:00', tz);
    setBusyId(row.id);
    try {
      if (row.jobId) {
        let updated: ScheduledJobSummary;
        try {
          updated = await integrationsClient.updateScheduledJob(row.jobId, {
            scheduledIso,
            timezone: tz,
            status: 'scheduled',
          });
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
          updated = await rehydrateBackendJob(
            buildRehydratePayload(row, {
              scheduledIso,
              timezone: tz,
              status: 'scheduled',
            }),
            workspaceMedia
          );
        }
        if (row.localPost) {
          savePost({
            ...row.localPost,
            scheduledDate: rescheduleDate,
            scheduledTime: rescheduleTime || '18:00',
            timezone: tz,
            scheduledIso,
            status: updated.status as SocialPost['status'],
            backendJobId: updated.id,
            backendStatus: updated.status,
            publishError: undefined,
          });
        }
      } else if (row.localPost) {
        savePost({
          ...row.localPost,
          scheduledDate: rescheduleDate,
          scheduledTime: rescheduleTime || '18:00',
          timezone: tz,
          scheduledIso,
          status: 'scheduled',
        });
      }
      setRescheduleRowId(null);
      notify('success', 'Post Rescheduled', `${rescheduleDate} ${rescheduleTime} (${tz})`);
      await refreshBackend();
    } catch (err) {
      notify('error', 'Reschedule failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const handleEditInComposer = (row: MergedQueueRow) => {
    const tz = row.timezone || DEFAULT_PUBLISHING_TIMEZONE;
    const isDual = row.platforms.includes('instagram') && row.platforms.includes('youtube');
    openPostComposerWithDraft({
      editingPostId: row.postId,
      editingJobId: row.jobId,
      title: row.title,
      platform: isDual ? 'both-video' : row.platform,
      caption: row.caption,
      hashtags: row.hashtags,
      mediaAssetIds: row.mediaAssetIds,
      scheduledDate: formatDateInTimeZone(row.scheduledIso, tz),
      scheduledTime: formatTimeInTimeZone(row.scheduledIso, tz),
      timezone: tz,
      youtubePrivacyStatus: row.youtubePrivacyStatus,
      sourceProjectId: row.localPost?.sourceProjectId,
    });
  };

  const handleDeleteRow = async (row: MergedQueueRow) => {
    setBusyId(row.id);
    try {
      if (row.jobId) {
        await integrationsClient.deleteScheduledJob(row.jobId).catch(() => {});
      }
      deletePost(row.postId);
      notify('info', 'Removed from Publishing Queue');
      await refreshBackend();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Publishing Queue</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Schedule &amp; Send Queue</h1>
          <p className="text-xs text-zinc-400 mt-1">
            All scheduled, ready-to-send, dual-platform, draft, and published posts for {activeWorkspace.name}.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHistory((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <History className="w-3.5 h-3.5" />
            <span>History ({effectiveHistory.length})</span>
          </button>
          <button
            type="button"
            onClick={refreshBackend}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Sync Queue</span>
          </button>
        </div>
      </div>

      {/* 8-State Lifecycle Filter Tabs */}
      <div className="inline-flex flex-wrap p-1 rounded-lg bg-[#111114] border border-zinc-800 gap-1">
        {QUEUE_TABS.map((tab) => {
          const count = countsByStatus[tab] || 0;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 ${
                filter === tab
                  ? 'bg-zinc-100 text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <span>{tab === 'all' ? 'All' : getStatusLabel(tab)}</span>
              <span
                className={`font-mono text-[10px] ${
                  filter === tab ? 'text-zinc-700' : 'text-zinc-500'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Queue List */}
      {filtered.length === 0 ? (
        <div className="p-10 rounded-xl bg-[#111114] border border-zinc-800 text-center text-xs text-zinc-400">
          No posts matching this status in {activeWorkspace.name}.
        </div>
      ) : (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 divide-y divide-zinc-800/80">
          {filtered.map((row) => {
            const isBusy = busyId === row.id || row.effectiveStatus === 'publishing';
            const canSendOrRetry =
              row.effectiveStatus !== 'published' &&
              row.effectiveStatus !== 'publishing' &&
              row.effectiveStatus !== 'cancelled';
            const failedOrPendingDests = row.destinations
              ?.filter((d) => d.status !== 'published' && d.status !== 'cancelled')
              .map((d) => d.platform);

            return (
              <div key={row.id} className="p-4 space-y-3">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-zinc-100 truncate">
                        {row.title}
                      </span>
                      <span
                        className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded border ${badgeClassForStatus(
                          row.effectiveStatus
                        )}`}
                      >
                        {getStatusLabel(row.effectiveStatus)}
                      </span>
                      {row.attempts > 0 && (
                        <span className="text-[10px] font-mono text-zinc-500">
                          {row.attempts} attempt(s)
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-zinc-400 truncate">
                      {row.caption || 'No caption entered'}
                    </div>

                    <div className="text-[11px] font-mono text-zinc-500 flex flex-wrap items-center gap-2">
                      <span>{row.platforms.map((p) => getPlatformLabel(p)).join(' + ')}</span>
                      <span>·</span>
                      <span>{row.mediaCount || row.mediaAssetIds.length} media file(s)</span>
                      {row.scheduledIso && (
                        <>
                          <span>·</span>
                          <span>
                            Slot: {formatReadableDateTime(row.scheduledIso, row.timezone)} ({row.timezone})
                          </span>
                        </>
                      )}
                      {row.publishedAt && (
                        <>
                          <span>·</span>
                          <span className="text-emerald-400">
                            Published: {formatReadableDateTime(row.publishedAt, row.timezone)}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Per-Destination Status Pills (Dual-Platform Transparency) */}
                    {row.destinations && row.destinations.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {row.destinations.map((dest) => (
                          <div
                            key={dest.platform}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] ${
                              dest.status === 'published'
                                ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                                : dest.status === 'failed'
                                  ? 'border-red-500/40 bg-red-950/20 text-red-300'
                                  : 'border-zinc-800 bg-[#09090b] text-zinc-300'
                            }`}
                          >
                            {dest.platform === 'instagram' ? (
                              <Instagram className="w-3 h-3" />
                            ) : (
                              <Youtube className="w-3 h-3" />
                            )}
                            <span className="font-medium">{getPlatformLabel(dest.platform)}:</span>
                            <span className="font-mono">{getStatusLabel(dest.status)}</span>
                            {dest.platformPostId && (
                              <span className="font-mono text-[10px] text-zinc-400">
                                ({dest.platformPostId})
                              </span>
                            )}
                            {dest.resultUrl && (
                              <a
                                href={dest.resultUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline inline-flex items-center gap-0.5 ml-1"
                              >
                                <span>Live</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {row.error && (
                      <div className="text-xs text-red-400 flex items-start gap-1.5 pt-0.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{row.error}</span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {row.resultUrl && (!row.destinations || row.destinations.length <= 1) && (
                      <a
                        href={row.resultUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-emerald-500/40 text-xs text-emerald-300 hover:text-emerald-200"
                      >
                        <span>View Live</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}

                    {row.needsReconciliation && row.jobId && (
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => handleReconcileRow(row)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-zinc-950 text-xs font-semibold"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Reconcile</span>
                      </button>
                    )}

                    {canSendOrRetry && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => openSendModal(row, failedOrPendingDests)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-50 text-xs font-semibold"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : row.effectiveStatus === 'failed' ||
                          row.effectiveStatus === 'partially-published' ? (
                          <RotateCcw className="w-3.5 h-3.5" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {row.effectiveStatus === 'partially-published'
                            ? 'Retry Remaining'
                            : row.effectiveStatus === 'failed'
                              ? 'Retry Failed'
                              : 'Send Now'}
                        </span>
                      </button>
                    )}

                    {row.effectiveStatus !== 'published' && row.effectiveStatus !== 'publishing' && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            rescheduleRowId === row.id
                              ? setRescheduleRowId(null)
                              : startReschedule(row)
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
                          title="Reschedule"
                        >
                          <CalendarClock className="w-3.5 h-3.5" />
                          <span>Reschedule</span>
                        </button>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleEditInComposer(row)}
                          className="p-2 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                          title="Edit Scheduled Post"
                        >
                          <PenSquare className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}

                    {(row.effectiveStatus === 'scheduled' ||
                      row.effectiveStatus === 'ready-to-send' ||
                      row.effectiveStatus === 'failed') && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleCancelJob(row)}
                        className="p-2 rounded border border-zinc-800 text-zinc-300 hover:border-red-500/60"
                        title="Cancel Scheduled Post"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => handleDeleteRow(row)}
                      className="p-2 rounded border border-zinc-800 text-zinc-400 hover:text-red-400"
                      title="Delete Post"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline Reschedule Bar */}
                {rescheduleRowId === row.id && (
                  <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800 flex flex-wrap items-center gap-3">
                    <span className="text-xs text-zinc-300 font-medium">
                      Reschedule ({row.timezone}):
                    </span>
                    <input
                      type="date"
                      value={rescheduleDate}
                      onChange={(e) => setRescheduleDate(e.target.value)}
                      className="px-2.5 py-1 rounded bg-[#141418] border border-zinc-700 text-xs text-zinc-100"
                    />
                    <input
                      type="time"
                      value={rescheduleTime}
                      onChange={(e) => setRescheduleTime(e.target.value)}
                      className="px-2.5 py-1 rounded bg-[#141418] border border-zinc-700 text-xs text-zinc-100"
                    />
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => submitReschedule(row)}
                      className="px-3 py-1 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
                    >
                      Save Time
                    </button>
                    <button
                      type="button"
                      onClick={() => setRescheduleRowId(null)}
                      className="px-2.5 py-1 rounded border border-zinc-800 text-xs text-zinc-400"
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Publishing History Audit Panel */}
      {showHistory && (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between text-xs font-semibold text-zinc-200">
            <span>Publishing History ({effectiveHistory.length})</span>
            <span className="font-mono text-zinc-500">Manual Send &amp; Retry Audit Log</span>
          </div>
          {effectiveHistory.length === 0 ? (
            <div className="p-6 text-xs text-zinc-500">
              No publishing history recorded for {activeWorkspace.name} yet.
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/70">
              {effectiveHistory.slice(0, 20).map((item) => (
                <div
                  key={item.id}
                  className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      {item.status === 'published' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      )}
                      <span className="font-medium text-zinc-100">{item.title}</span>
                      <span className="font-mono text-[11px] text-zinc-400">
                        {getPlatformLabel(item.platform)} · {item.mode}
                      </span>
                      {item.platformPostId && (
                        <span className="font-mono text-[11px] text-zinc-500">
                          ID: {item.platformPostId}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500">
                      {formatReadableDateTime(item.timestamp, DEFAULT_PUBLISHING_TIMEZONE)} (Africa/Lagos)
                    </div>
                    {item.error && <div className="text-[11px] text-red-400">{item.error}</div>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={item.status === 'published' ? 'text-emerald-400' : 'text-red-400'}>
                      {item.status}
                    </span>
                    {item.resultUrl && (
                      <a
                        href={item.resultUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-zinc-200 underline"
                      >
                        <span>View Live</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual Send Confirmation Modal */}
      <SendConfirmationModal
        open={Boolean(sendModalState)}
        onClose={() => setSendModalState(null)}
        item={sendModalState?.item || null}
        defaultTargets={sendModalState?.defaultTargets}
        workspace={activeWorkspace}
        connStatus={connStatus}
        mediaAssets={workspaceMedia}
        onOpenConnectedAccounts={() => setNavSection('connected-accounts')}
        onCompleted={async (res) => {
          if (res.job) {
            const localPost = workspacePosts.find((p) => p.id === res.job!.postId);
            savePost({
              id: res.job.postId,
              workspaceId: res.job.workspaceId,
              title: res.job.title,
              platform: res.job.platform,
              platforms: res.job.platforms,
              caption: res.job.caption,
              hashtags: res.job.hashtags,
              mediaAssetIds: res.job.mediaAssetIds || localPost?.mediaAssetIds || [],
              status: res.job.status as SocialPost['status'],
              scheduledDate: formatDateInTimeZone(
                res.job.scheduledIso,
                res.job.timezone || DEFAULT_PUBLISHING_TIMEZONE
              ),
              scheduledTime: formatTimeInTimeZone(
                res.job.scheduledIso,
                res.job.timezone || DEFAULT_PUBLISHING_TIMEZONE
              ),
              timezone: res.job.timezone || DEFAULT_PUBLISHING_TIMEZONE,
              scheduledIso: res.job.scheduledIso,
              youtubePrivacyStatus: res.job.youtubePrivacyStatus,
              backendJobId: res.job.id,
              backendStatus: res.job.status,
              publishResultUrl: res.job.resultUrl,
              publishError: res.job.error,
              createdAt: res.job.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          await refreshBackend();
          if (!res.partialError) {
            notify('success', 'Published', res.job?.resultUrl || 'Delivered to live account');
          } else {
            notify('warning', 'Partial or Failed Send', res.partialError);
          }
        }}
      />
    </div>
  );
};
