import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  PenSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import {
  integrationsClient,
  IntegrationsStatusResponse,
  MediaPreviewRef,
  ScheduledJobSummary,
} from '../../services/integrationsClient';
import { prepareMediaItemsForPublish } from '../../services/mediaPayload';
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
  formatTimeInTimeZone,
  getPlatformLabel,
  getStatusLabel,
  zonedDateTimeToUtcIso,
} from '../../utils/publishing';
import { SendConfirmationModal, SendModalInput } from './SendConfirmationModal';

interface CalendarEntry {
  id: string;
  postId: string;
  title: string;
  platform: SocialPlatform;
  platforms: Array<'instagram' | 'youtube'>;
  destinations?: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledDate: string;
  scheduledTime: string;
  scheduledIso: string;
  timezone: string;
  status: PublishingLifecycleStatus;
  resultUrl?: string;
  error?: string;
  jobId?: string;
  mediaAssetIds: string[];
  mediaCount: number;
  mediaPreviews?: MediaPreviewRef[];
  localPost?: SocialPost;
}

export const ContentCalendarView: React.FC = () => {
  const {
    activeWorkspace,
    workspacePosts,
    workspaceMedia,
    savePost,
    deletePost,
    setNavSection,
    openPostComposerWithDraft,
    notify,
  } = useStudio();
  const { user, cloudJobs, syncFromServerSnapshot } = useFirebase();

  const [cursorDate, setCursorDate] = useState(() => new Date());
  const [backendJobs, setBackendJobs] = useState<ScheduledJobSummary[]>([]);
  const [connStatus, setConnStatus] = useState<IntegrationsStatusResponse | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sendModalState, setSendModalState] = useState<{
    item: SendModalInput;
    defaultTargets?: Array<'instagram' | 'youtube'>;
  } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const year = cursorDate.getFullYear();
  const month = cursorDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const monthLabel = cursorDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const refreshBackendJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const [s, jobs, h] = await Promise.all([
        integrationsClient.getStatus(activeWorkspace.id, false),
        integrationsClient.listScheduledJobs(activeWorkspace.id),
        integrationsClient.listPublishHistory(activeWorkspace.id),
      ]);
      setConnStatus(s);
      setBackendJobs(jobs);
      if (user && user.emailVerified) {
        await syncFromServerSnapshot(activeWorkspace.id, s, jobs, h).catch(() => {});
      }
    } catch {
      // Ignore network hiccup
    } finally {
      setLoadingJobs(false);
    }
  }, [activeWorkspace.id, syncFromServerSnapshot, user]);

  useEffect(() => {
    refreshBackendJobs();
  }, [refreshBackendJobs]);

  const effectiveBackendJobs = backendJobs.length > 0 ? backendJobs : cloudJobs;

  const jobByPostId = useMemo(() => {
    const map = new Map<string, ScheduledJobSummary>();
    for (const j of effectiveBackendJobs) {
      map.set(j.postId, j);
    }
    return map;
  }, [effectiveBackendJobs]);

  // Merge authoritative backend jobs + local scheduled posts cleanly
  const mergedScheduledEntries = useMemo<CalendarEntry[]>(() => {
    const seenPostIds = new Set<string>();
    const entries: CalendarEntry[] = [];

    for (const job of effectiveBackendJobs) {
      seenPostIds.add(job.postId);
      const localPost = workspacePosts.find((p) => p.id === job.postId);
      const tz = job.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const effectiveStatus = computeEffectiveLifecycleStatus({
        rawStatus: job.status,
        scheduledIso: job.scheduledIso,
        destinations: job.destinations,
        nowMs,
      });

      entries.push({
        id: job.id,
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
        scheduledDate: formatDateInTimeZone(job.scheduledIso, tz),
        scheduledTime: formatTimeInTimeZone(job.scheduledIso, tz),
        scheduledIso: job.scheduledIso,
        timezone: tz,
        status: effectiveStatus,
        resultUrl: job.resultUrl,
        error: job.error,
        jobId: job.id,
        mediaAssetIds: job.mediaAssetIds || localPost?.mediaAssetIds || [],
        mediaCount: job.mediaCount,
        mediaPreviews: job.mediaPreviews,
        localPost,
      });
    }

    for (const post of workspacePosts) {
      if (seenPostIds.has(post.id)) continue;
      if (!post.scheduledDate && post.status === 'draft') continue;
      const tz = post.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const dateStr = post.scheduledDate || formatDateInTimeZone(post.updatedAt, tz);
      const timeStr = post.scheduledTime || '18:00';
      const scheduledIso = post.scheduledIso || zonedDateTimeToUtcIso(dateStr, timeStr, tz);
      const job = jobByPostId.get(post.id);
      const effectiveStatus = computeEffectiveLifecycleStatus({
        rawStatus: job?.status || post.backendStatus || post.status,
        scheduledIso,
        destinations: job?.destinations,
        nowMs,
      });

      entries.push({
        id: post.id,
        postId: post.id,
        title: post.title,
        platform: post.platform,
        platforms: post.platforms || [post.platform === 'youtube-shorts' ? 'youtube' : 'instagram'],
        destinations: job?.destinations,
        caption: post.caption,
        hashtags: post.hashtags,
        youtubePrivacyStatus: post.youtubePrivacyStatus,
        scheduledDate: dateStr,
        scheduledTime: timeStr,
        scheduledIso,
        timezone: tz,
        status: effectiveStatus,
        resultUrl: job?.resultUrl || post.publishResultUrl,
        error: job?.error || post.publishError,
        jobId: job?.id || post.backendJobId,
        mediaAssetIds: post.mediaAssetIds,
        mediaCount: post.mediaAssetIds.length,
        localPost: post,
      });
    }

    return entries.sort((a, b) =>
      `${a.scheduledDate} ${a.scheduledTime}`.localeCompare(`${b.scheduledDate} ${b.scheduledTime}`)
    );
  }, [effectiveBackendJobs, workspacePosts, jobByPostId, nowMs]);

  const postsByDay = useMemo(() => {
    const map: Record<string, CalendarEntry[]> = {};
    for (const entry of mergedScheduledEntries) {
      if (!map[entry.scheduledDate]) map[entry.scheduledDate] = [];
      map[entry.scheduledDate].push(entry);
    }
    return map;
  }, [mergedScheduledEntries]);

  const calendarCells = useMemo(() => {
    const cells: Array<{ day: number | null; dateStr?: string }> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateStr });
    }
    return cells;
  }, [year, month, daysInMonth, firstWeekday]);

  const handleReschedule = async (entry: CalendarEntry, newDate: string, newTime?: string) => {
    if (!newDate) return;
    const tz = entry.timezone || DEFAULT_PUBLISHING_TIMEZONE;
    const timeVal = newTime || entry.scheduledTime || '18:00';
    const scheduledIso = zonedDateTimeToUtcIso(newDate, timeVal, tz);

    if (entry.localPost) {
      savePost({
        ...entry.localPost,
        scheduledDate: newDate,
        scheduledTime: timeVal,
        timezone: tz,
        scheduledIso,
      });
    }

    if (entry.jobId) {
      setBusyId(entry.id);
      try {
        await integrationsClient.updateScheduledJob(entry.jobId, {
          scheduledIso,
          timezone: tz,
          status: 'scheduled',
        });
        notify('success', 'Schedule updated', `${newDate} ${timeVal} (${tz})`);
        await refreshBackendJobs();
      } catch (err) {
        notify('error', 'Reschedule failed', err instanceof Error ? err.message : '');
      } finally {
        setBusyId(null);
      }
    }
  };

  const handleSyncToBackend = async (entry: CalendarEntry) => {
    if (!entry.localPost) return;
    setBusyId(entry.id);
    try {
      const mediaItems =
        entry.localPost.mediaAssetIds.length > 0
          ? await prepareMediaItemsForPublish(
              entry.localPost.mediaAssetIds,
              workspaceMedia,
              entry.platform
            ).catch(() => [])
          : [];
      const tz = entry.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const scheduledIso = zonedDateTimeToUtcIso(
        entry.scheduledDate,
        entry.scheduledTime || '18:00',
        tz
      );
      const job = await integrationsClient.syncScheduledJob({
        workspaceId: activeWorkspace.id,
        postId: entry.postId,
        title: entry.title,
        platform: entry.platform,
        platforms: entry.platforms,
        caption: entry.localPost.caption,
        hashtags: entry.localPost.hashtags,
        youtubePrivacyStatus: entry.youtubePrivacyStatus,
        scheduledIso,
        timezone: tz,
        mediaAssetIds: entry.localPost.mediaAssetIds,
        status: 'scheduled',
        mediaItems,
      });
      savePost({
        ...entry.localPost,
        status: job.status as SocialPost['status'],
        backendJobId: job.id,
        backendStatus: job.status,
      });
      notify(
        'success',
        'Saved to Schedule & Send Queue',
        `${entry.scheduledDate} ${entry.scheduledTime} (${tz})`
      );
      await refreshBackendJobs();
    } catch (err) {
      notify('error', 'Sync failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelJob = async (entry: CalendarEntry) => {
    setBusyId(entry.id);
    try {
      if (entry.jobId) {
        await integrationsClient.cancelScheduledJob(entry.jobId);
      }
      if (entry.localPost) {
        savePost({ ...entry.localPost, status: 'cancelled', backendStatus: 'cancelled' });
      }
      notify('info', 'Scheduled post cancelled');
      await refreshBackendJobs();
    } catch (err) {
      notify('error', 'Cancel failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenSendModal = (entry: CalendarEntry) => {
    const failedOrRemaining = entry.destinations
      ?.filter((d) => d.status !== 'published' && d.status !== 'cancelled')
      .map((d) => d.platform);

    setSendModalState({
      item: {
        id: entry.jobId,
        postId: entry.postId,
        title: entry.title,
        platform: entry.platform,
        platforms: entry.platforms,
        destinations: entry.destinations,
        caption: entry.caption,
        hashtags: entry.hashtags,
        youtubePrivacyStatus: entry.youtubePrivacyStatus,
        scheduledIso: entry.scheduledIso,
        timezone: entry.timezone,
        mediaAssetIds: entry.mediaAssetIds,
        mediaCount: entry.mediaCount,
        mediaPreviews: entry.mediaPreviews,
        status: entry.status,
      },
      defaultTargets: failedOrRemaining,
    });
  };

  const handleRemoveEntry = async (entry: CalendarEntry) => {
    if (entry.localPost) {
      deletePost(entry.localPost.id);
    }
    if (entry.jobId) {
      await integrationsClient.deleteScheduledJob(entry.jobId).catch(() => {});
    }
    await refreshBackendJobs();
  };

  const statusTextClass = (status: PublishingLifecycleStatus) => {
    switch (status) {
      case 'ready-to-send':
        return 'text-amber-300';
      case 'published':
        return 'text-emerald-400';
      case 'partially-published':
        return 'text-amber-300';
      case 'failed':
        return 'text-red-400';
      case 'cancelled':
        return 'text-zinc-500';
      default:
        return 'text-zinc-300';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Content Calendar</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Release &amp; Schedule Calendar</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Scheduled slots default to Africa/Lagos and transition to Ready to Send when due for manual release.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1 rounded-md bg-[#111114] border border-zinc-800 p-1">
            <button
              type="button"
              onClick={() => setCursorDate(new Date(year, month - 1, 1))}
              className="p-1.5 text-zinc-400 hover:text-zinc-100"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-semibold text-zinc-100 min-w-[130px] text-center">
              {monthLabel}
            </span>
            <button
              type="button"
              onClick={() => setCursorDate(new Date(year, month + 1, 1))}
              className="p-1.5 text-zinc-400 hover:text-zinc-100"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={refreshBackendJobs}
            className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100"
            title="Refresh schedule"
          >
            <RefreshCw className={`w-4 h-4 ${loadingJobs ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setNavSection('post-composer')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Schedule Post</span>
          </button>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-zinc-800 text-[11px] font-medium text-zinc-400">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="py-2.5 px-3 border-r last:border-r-0 border-zinc-800/70">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {calendarCells.map((cell, idx) => {
            const items = cell.dateStr ? postsByDay[cell.dateStr] || [] : [];
            return (
              <div
                key={idx}
                className="min-h-[110px] p-2 border-r border-b border-zinc-800/70 bg-[#0d0d10] flex flex-col gap-1.5"
              >
                {cell.day !== null && (
                  <>
                    <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                      {String(cell.day).padStart(2, '0')}
                    </div>
                    {items.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          if (entry.status !== 'published' && entry.status !== 'cancelled') {
                            handleOpenSendModal(entry);
                          }
                        }}
                        className="p-1.5 rounded bg-[#18181e] border border-zinc-700/80 hover:border-zinc-500 text-left text-[11px] space-y-0.5 transition-colors"
                      >
                        <div className="font-semibold text-zinc-100 truncate">{entry.title}</div>
                        <div className="text-[10px] font-mono text-zinc-400 truncate">
                          {entry.scheduledTime} ·{' '}
                          {entry.platforms.map((p) => (p === 'instagram' ? 'IG' : 'YT')).join('+')}
                        </div>
                        <div className={`text-[10px] font-mono uppercase ${statusTextClass(entry.status)}`}>
                          {getStatusLabel(entry.status)}
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scheduled List Management */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between text-xs font-semibold text-zinc-200">
          <span>Scheduled Entries ({mergedScheduledEntries.length})</span>
          <span className="font-mono text-zinc-400">
            {effectiveBackendJobs.length} queued post(s)
          </span>
        </div>
        {mergedScheduledEntries.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">
            No scheduled posts in {activeWorkspace.name} yet.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/70">
            {mergedScheduledEntries.map((entry) => (
              <div
                key={entry.id}
                className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-zinc-100 truncate">
                      {entry.title}
                    </span>
                    <span
                      className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                        entry.status === 'published'
                          ? 'border-emerald-500/40 text-emerald-300'
                          : entry.status === 'ready-to-send'
                            ? 'border-amber-400/60 text-amber-300'
                            : entry.status === 'failed' || entry.status === 'partially-published'
                              ? 'border-red-500/40 text-red-300'
                              : 'border-zinc-700 text-zinc-300'
                      }`}
                    >
                      {getStatusLabel(entry.status)}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    <span>{entry.platforms.map((p) => getPlatformLabel(p)).join(' + ')}</span>
                    <span className="mx-1.5">·</span>
                    <span className="font-mono tabular-nums">
                      {entry.scheduledDate} {entry.scheduledTime} ({entry.timezone})
                    </span>
                    <span className="mx-1.5">·</span>
                    <span>{entry.jobId ? 'Synced in Queue' : 'Local Only'}</span>
                  </div>
                  {entry.error && <div className="text-[11px] text-red-400">{entry.error}</div>}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {entry.status !== 'published' && entry.status !== 'publishing' && (
                    <>
                      <input
                        type="date"
                        disabled={busyId === entry.id}
                        value={entry.scheduledDate}
                        onChange={(e) => handleReschedule(entry, e.target.value, entry.scheduledTime)}
                        className="px-2 py-1 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                      />
                      <input
                        type="time"
                        disabled={busyId === entry.id}
                        value={entry.scheduledTime}
                        onChange={(e) => handleReschedule(entry, entry.scheduledDate, e.target.value)}
                        className="px-2 py-1 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                      />
                    </>
                  )}

                  {!entry.jobId && entry.localPost && (
                    <button
                      type="button"
                      disabled={busyId === entry.id}
                      onClick={() => handleSyncToBackend(entry)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500"
                      title="Save post to persistent Schedule & Send queue"
                    >
                      <UploadCloud className="w-3 h-3" />
                      <span>Save to Queue</span>
                    </button>
                  )}

                  {entry.status !== 'published' &&
                    entry.status !== 'publishing' &&
                    entry.status !== 'cancelled' && (
                      <button
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => handleOpenSendModal(entry)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-100 text-zinc-950 text-[11px] font-semibold"
                      >
                        {entry.status === 'failed' || entry.status === 'partially-published' ? (
                          <RotateCcw className="w-3 h-3" />
                        ) : (
                          <Send className="w-3 h-3" />
                        )}
                        <span>
                          {entry.status === 'failed' || entry.status === 'partially-published'
                            ? 'Retry'
                            : 'Send Now'}
                        </span>
                      </button>
                    )}

                  {entry.jobId &&
                    (entry.status === 'scheduled' || entry.status === 'ready-to-send') && (
                      <button
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => handleCancelJob(entry)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-red-500/60"
                      >
                        <XCircle className="w-3 h-3" />
                        <span>Cancel</span>
                      </button>
                    )}

                  {entry.resultUrl && (
                    <a
                      href={entry.resultUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-emerald-300 underline"
                    >
                      <span>Live</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}

                  {entry.status !== 'published' && entry.status !== 'publishing' && (
                    <button
                      type="button"
                      onClick={() =>
                        openPostComposerWithDraft({
                          editingPostId: entry.postId,
                          editingJobId: entry.jobId,
                          title: entry.title,
                          platform:
                            entry.platforms.includes('instagram') &&
                            entry.platforms.includes('youtube')
                              ? 'both-video'
                              : entry.platform,
                          caption: entry.caption,
                          hashtags: entry.hashtags,
                          mediaAssetIds: entry.mediaAssetIds,
                          scheduledDate: entry.scheduledDate,
                          scheduledTime: entry.scheduledTime,
                          timezone: entry.timezone,
                          youtubePrivacyStatus: entry.youtubePrivacyStatus,
                          sourceProjectId: entry.localPost?.sourceProjectId,
                        })
                      }
                      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100"
                      title="Edit in Composer"
                    >
                      <PenSquare className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleRemoveEntry(entry)}
                    className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
          await refreshBackendJobs();
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
