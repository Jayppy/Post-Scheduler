import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Clapperboard,
  Clock,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Instagram,
  Layers,
  ListChecks,
  Megaphone,
  PenSquare,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Youtube,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import { getMediaBlob } from '../../services/idb';
import {
  integrationsClient,
  IntegrationsStatusResponse,
  MediaPreviewRef,
  ScheduledJobSummary,
} from '../../services/integrationsClient';
import { DestinationPublishState, PublishingLifecycleStatus, SocialPlatform } from '../../types/studio';
import {
  DEFAULT_PUBLISHING_TIMEZONE,
  computeEffectiveLifecycleStatus,
  formatDateInTimeZone,
  formatTimeInTimeZone,
  getPlatformLabel,
  getStatusLabel,
  getUserLocalTimezone,
} from '../../utils/publishing';
import { mergeServerAndCloudJobs } from '../../utils/jobRecovery';
import { SendConfirmationModal, SendModalInput } from './SendConfirmationModal';

interface DashboardQueueItem {
  id: string;
  jobId?: string;
  postId: string;
  title: string;
  platform: SocialPlatform;
  platforms: Array<'instagram' | 'youtube'>;
  destinations?: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: 'public' | 'unlisted' | 'private';
  scheduledIso: string;
  timezone: string;
  effectiveStatus: PublishingLifecycleStatus;
  mediaAssetIds: string[];
  mediaCount: number;
  mediaPreviews?: MediaPreviewRef[];
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
}

function statusBadgeClass(status: string): string {
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

export const HubOverview: React.FC = () => {
  const {
    activeWorkspace,
    workspacePosts,
    workspaceCampaigns,
    workspaceProjects,
    workspaceMedia,
    savePost,
    setNavSection,
    setStudioSubView,
    notify,
  } = useStudio();
  const { user, cloudJobs, syncFromServerSnapshot } = useFirebase();

  const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
  const [connStatus, setConnStatus] = useState<IntegrationsStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [thumbUrls, setThumbUrls] = useState<Record<string, { url: string; isVideo: boolean }>>({});
  const [sendTarget, setSendTarget] = useState<{
    item: SendModalInput;
    defaultTargets?: Array<'instagram' | 'youtube'>;
  } | null>(null);

  const localTz = useMemo(() => getUserLocalTimezone(), []);

  // Live UI clock to flip due Scheduled posts -> Ready to Send (ZERO auto-publishing)
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const refreshDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [s, j, h] = await Promise.all([
        integrationsClient.getStatus(activeWorkspace.id, false),
        integrationsClient.listScheduledJobs(activeWorkspace.id),
        integrationsClient.listPublishHistory(activeWorkspace.id),
      ]);
      setConnStatus(s);
      setJobs(j);
      if (user && user.emailVerified) {
        await syncFromServerSnapshot(activeWorkspace.id, s, j, h).catch(() => {});
      }
    } catch {
      // ignore network hiccup
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace.id, syncFromServerSnapshot, user]);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  // Merge authoritative backend jobs + cloud jobs (by postId) + any unsynced local posts
  const unifiedItems = useMemo<DashboardQueueItem[]>(() => {
    const byPostId = new Map<string, DashboardQueueItem>();

    const allServerAndCloud = mergeServerAndCloudJobs(jobs, cloudJobs);
    for (const job of allServerAndCloud) {
      const tz = job.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const localPost = workspacePosts.find((p) => p.id === job.postId);
      const effectiveStatus = computeEffectiveLifecycleStatus({
        rawStatus: job.status,
        scheduledIso: job.scheduledIso,
        destinations: job.destinations,
        nowMs,
      });
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
        timezone: tz,
        effectiveStatus,
        mediaAssetIds: job.mediaAssetIds || localPost?.mediaAssetIds || [],
        mediaCount: job.mediaCount,
        mediaPreviews: job.mediaPreviews,
        publishedAt: job.publishedAt,
        platformPostId: job.platformPostId,
        resultUrl: job.resultUrl,
        error: job.error,
      });
    }

    for (const post of workspacePosts) {
      if (byPostId.has(post.id)) continue;
      const tz = post.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const scheduledIso =
        post.scheduledIso ||
        (post.scheduledDate
          ? new Date(`${post.scheduledDate}T${post.scheduledTime || '18:00'}:00`).toISOString()
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
        mediaAssetIds: post.mediaAssetIds,
        mediaCount: post.mediaAssetIds.length,
        resultUrl: post.publishResultUrl,
        error: post.publishError,
      });
    }

    return Array.from(byPostId.values()).sort((a, b) =>
      (a.scheduledIso || '').localeCompare(b.scheduledIso || '')
    );
  }, [jobs, cloudJobs, workspacePosts, nowMs]);

  // Load thumbnail previews for visible dashboard items
  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];

    const loadThumbs = async () => {
      const next: Record<string, { url: string; isVideo: boolean }> = {};
      for (const item of unifiedItems.slice(0, 20)) {
        const firstAssetId = item.mediaAssetIds[0];
        if (firstAssetId) {
          const asset = workspaceMedia.find((m) => m.id === firstAssetId);
          if (asset) {
            const blob = await getMediaBlob(asset.blobKey).catch(() => null);
            if (blob && active) {
              const url = URL.createObjectURL(blob);
              objectUrls.push(url);
              next[item.id] = {
                url,
                isVideo: (blob.type || asset.mimeType).startsWith('video/'),
              };
              continue;
            }
          }
        }
        if (item.mediaPreviews && item.mediaPreviews.length > 0) {
          next[item.id] = {
            url: item.mediaPreviews[0].url,
            isVideo: item.mediaPreviews[0].mimeType.startsWith('video/'),
          };
        }
      }
      if (active) setThumbUrls(next);
    };

    loadThumbs();
    return () => {
      active = false;
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [unifiedItems, workspaceMedia]);

  const todayInLagos = useMemo(
    () => formatDateInTimeZone(new Date(nowMs), DEFAULT_PUBLISHING_TIMEZONE),
    [nowMs]
  );

  const readyToSendItems = useMemo(
    () =>
      unifiedItems.filter(
        (i) =>
          i.effectiveStatus === 'ready-to-send' ||
          (i.effectiveStatus === 'scheduled' &&
            formatDateInTimeZone(i.scheduledIso, i.timezone) === todayInLagos)
      ),
    [unifiedItems, todayInLagos]
  );

  const readyCount = useMemo(
    () => unifiedItems.filter((i) => i.effectiveStatus === 'ready-to-send').length,
    [unifiedItems]
  );

  const publishedTodayItems = useMemo(
    () =>
      unifiedItems.filter(
        (i) =>
          (i.effectiveStatus === 'published' || i.effectiveStatus === 'partially-published') &&
          i.publishedAt &&
          formatDateInTimeZone(i.publishedAt, i.timezone) === todayInLagos
      ),
    [unifiedItems, todayInLagos]
  );

  const totalPublishedCount = useMemo(
    () => unifiedItems.filter((i) => i.effectiveStatus === 'published').length,
    [unifiedItems]
  );

  const upcomingItems = useMemo(
    () =>
      unifiedItems.filter(
        (i) =>
          i.effectiveStatus === 'scheduled' &&
          formatDateInTimeZone(i.scheduledIso, i.timezone) > todayInLagos
      ),
    [unifiedItems, todayInLagos]
  );

  const attentionItems = useMemo(
    () =>
      unifiedItems.filter(
        (i) =>
          i.effectiveStatus === 'failed' ||
          i.effectiveStatus === 'partially-published' ||
          i.effectiveStatus === 'publishing'
      ),
    [unifiedItems]
  );

  const activeCampaigns = workspaceCampaigns.filter((c) => c.status === 'active');

  const getAccountIdentityLabel = (platforms: Array<'instagram' | 'youtube'>) => {
    const parts: string[] = [];
    if (platforms.includes('instagram')) {
      parts.push(
        connStatus?.instagram.connected
          ? connStatus.instagram.accountHandle
            ? `@${connStatus.instagram.accountHandle}`
            : connStatus.instagram.accountName || 'IG Connected'
          : 'IG Not Connected'
      );
    }
    if (platforms.includes('youtube')) {
      parts.push(
        connStatus?.youtube.connected
          ? connStatus.youtube.accountName || 'YT Connected'
          : 'YT Not Connected'
      );
    }
    return parts.join(' · ');
  };

  const openModalForItem = (
    item: DashboardQueueItem,
    defaultTargets?: Array<'instagram' | 'youtube'>
  ) => {
    setSendTarget({
      item: {
        id: item.jobId,
        postId: item.postId,
        title: item.title,
        platform: item.platform,
        platforms: item.platforms,
        destinations: item.destinations,
        caption: item.caption,
        hashtags: item.hashtags,
        youtubePrivacyStatus: item.youtubePrivacyStatus,
        scheduledIso: item.scheduledIso,
        timezone: item.timezone,
        mediaAssetIds: item.mediaAssetIds,
        mediaCount: item.mediaCount,
        mediaPreviews: item.mediaPreviews,
        status: item.effectiveStatus,
      },
      defaultTargets,
    });
  };

  const renderThumb = (item: DashboardQueueItem) => {
    const thumb = thumbUrls[item.id];
    if (!thumb) {
      return (
        <div className="w-11 h-11 rounded-md bg-[#09090b] border border-zinc-800 flex items-center justify-center text-zinc-600 shrink-0">
          {item.platform === 'youtube-shorts' || item.platform === 'instagram-reel' ? (
            <Film className="w-4 h-4" />
          ) : (
            <ImageIcon className="w-4 h-4" />
          )}
        </div>
      );
    }
    return (
      <div className="w-11 h-11 rounded-md overflow-hidden border border-zinc-700 bg-[#09090b] shrink-0">
        {thumb.isVideo ? (
          <video src={thumb.url} muted className="w-full h-full object-cover" />
        ) : (
          <img src={thumb.url} alt={item.title} className="w-full h-full object-cover" />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="text-xs text-zinc-400 mb-1.5">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Schedule &amp; Send Command Hub</span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-zinc-100">
            {activeWorkspace.name} Command Hub
          </h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">{activeWorkspace.aestheticStyle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={refreshDashboard}
            className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100"
            title="Refresh Today's Publishing status"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => {
              setNavSection('creative-studio');
              setStudioSubView('overview');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Open Creative Studio</span>
          </button>
          <button
            type="button"
            onClick={() => setNavSection('post-composer')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-zinc-700 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
          >
            <PenSquare className="w-3.5 h-3.5" />
            <span>Compose Post</span>
          </button>
        </div>
      </div>

      {/* KPI Strip — Today's Publishing Counts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400 flex items-center justify-between">
            <span>Ready to Send</span>
            {readyCount > 0 && <Send className="w-3.5 h-3.5 text-amber-400" />}
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {readyCount}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {readyToSendItems.length} scheduled for today
          </div>
        </div>

        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400 flex items-center justify-between">
            <span>Published</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {totalPublishedCount}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {publishedTodayItems.length} delivered today
          </div>
        </div>

        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400 flex items-center justify-between">
            <span>Upcoming</span>
            <Clock className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {upcomingItems.length}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">Future dates queued</div>
        </div>

        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400 flex items-center justify-between">
            <span>Failed / Attention</span>
            {attentionItems.length > 0 && <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {attentionItems.length}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">Manual retry or partial</div>
        </div>
      </div>

      {/* TODAY'S PUBLISHING DASHBOARD */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Today&apos;s Publishing Dashboard ({todayInLagos} · Africa/Lagos)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Scheduled posts unlock automatically at their target time. Nothing publishes until you click Send Now.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNavSection('publishing-queue')}
              className="px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
            >
              Open Full Queue
            </button>
          </div>
        </div>

        {/* Attention / Failed Banner inside Today's Dashboard */}
        {attentionItems.length > 0 && (
          <div className="border-b border-zinc-800/80 bg-red-950/10">
            <div className="px-5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-red-300 border-b border-red-900/30">
              Requires Attention ({attentionItems.length})
            </div>
            <div className="divide-y divide-zinc-800/70">
              {attentionItems.map((item) => {
                const failedDests = item.destinations
                  ?.filter((d) => d.status === 'failed' || d.status === 'publishing')
                  .map((d) => d.platform);
                return (
                  <div
                    key={item.id}
                    className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {renderThumb(item)}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-zinc-100 truncate">
                            {item.title}
                          </span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${statusBadgeClass(
                              item.effectiveStatus
                            )}`}
                          >
                            {getStatusLabel(item.effectiveStatus)}
                          </span>
                        </div>
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          {item.platforms.map((p) => getPlatformLabel(p)).join(' + ')} ·{' '}
                          {getAccountIdentityLabel(item.platforms)}
                        </div>
                        {item.error && (
                          <div className="text-[11px] text-red-300 mt-0.5 truncate">{item.error}</div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openModalForItem(item, failedDests)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>
                        {item.effectiveStatus === 'partially-published'
                          ? 'Retry Remaining'
                          : 'Review & Retry'}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Due Today / Ready to Send */}
        <div className="divide-y divide-zinc-800/70">
          <div className="px-5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-zinc-400 bg-[#0d0d10]">
            Due Today &amp; Ready to Send ({readyToSendItems.length})
          </div>
          {readyToSendItems.length === 0 ? (
            <div className="px-5 py-6 text-xs text-zinc-500">
              No posts due today for {activeWorkspace.name}. Schedule a post in Post Composer or Creative Studio.
            </div>
          ) : (
            readyToSendItems.map((item) => {
              const isReady = item.effectiveStatus === 'ready-to-send';
              const slotTimeTz = formatTimeInTimeZone(item.scheduledIso, item.timezone);
              const slotTimeLocal =
                localTz !== item.timezone ? formatTimeInTimeZone(item.scheduledIso, localTz) : null;
              return (
                <div
                  key={item.id}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {renderThumb(item)}
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-zinc-100 truncate">
                          {item.title}
                        </span>
                        <span
                          className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${statusBadgeClass(
                            item.effectiveStatus
                          )}`}
                        >
                          {getStatusLabel(item.effectiveStatus)}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-400 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-zinc-200">
                          {slotTimeTz} ({item.timezone})
                        </span>
                        {slotTimeLocal && (
                          <span className="font-mono text-zinc-500">
                            / {slotTimeLocal} local
                          </span>
                        )}
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          {item.platforms.includes('instagram') && <Instagram className="w-3 h-3" />}
                          {item.platforms.includes('youtube') && <Youtube className="w-3 h-3" />}
                          <span>{item.platforms.map((p) => getPlatformLabel(p)).join(' + ')}</span>
                        </span>
                        <span>·</span>
                        <span>{getAccountIdentityLabel(item.platforms)}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openModalForItem(item)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold shrink-0 ${
                      isReady
                        ? 'bg-zinc-100 text-zinc-950 hover:bg-white'
                        : 'border border-zinc-700 text-zinc-200 hover:border-zinc-500'
                    }`}
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Now</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Published Today */}
        {publishedTodayItems.length > 0 && (
          <div className="border-t border-zinc-800/80 divide-y divide-zinc-800/70">
            <div className="px-5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-emerald-400 bg-[#0d0d10]">
              Published Today ({publishedTodayItems.length})
            </div>
            {publishedTodayItems.map((item) => (
              <div
                key={item.id}
                className="px-5 py-3 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {renderThumb(item)}
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-100 truncate">{item.title}</div>
                    <div className="text-[11px] text-zinc-400 font-mono">
                      {item.platforms.map((p) => getPlatformLabel(p)).join(' + ')} ·{' '}
                      {item.publishedAt
                        ? formatTimeInTimeZone(item.publishedAt, item.timezone)
                        : ''}{' '}
                      {item.platformPostId ? `· ID: ${item.platformPostId}` : ''}
                    </div>
                  </div>
                </div>
                {item.resultUrl && (
                  <a
                    href={item.resultUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-emerald-300 underline shrink-0"
                  >
                    <span>View Live</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hub Modules Grid (Preserved) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => {
            setNavSection('creative-studio');
            setStudioSubView('carousel-creator');
          }}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Layers className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>AI Carousel Creator</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Turn documents or topics into crisp 1080×1350 carousels ready for Instagram.
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setNavSection('creative-studio');
            setStudioSubView('reels-studio');
          }}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Clapperboard className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>AI Reels &amp; Shorts Studio</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Storyboard, edit vertical timelines, burn subtitles, and export MP4s in-browser.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setNavSection('ai-assistant')}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Sparkles className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>Gemini AI Content Assistant</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Draft brand-aligned hooks, captions, and release copy in {activeWorkspace.name} voice.
          </p>
        </button>
      </div>

      {/* Upcoming Pipeline & Campaigns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-100">
                Upcoming Scheduled Posts ({upcomingItems.length})
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setNavSection('content-calendar')}
              className="text-xs text-zinc-400 hover:text-zinc-100"
            >
              Open Calendar
            </button>
          </div>
          <div className="divide-y divide-zinc-800/70">
            {upcomingItems.length === 0 ? (
              <div className="px-5 py-6 text-xs text-zinc-500">
                No upcoming posts scheduled after today.
              </div>
            ) : (
              upcomingItems.slice(0, 6).map((item) => (
                <div key={item.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {renderThumb(item)}
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-zinc-100 truncate">{item.title}</div>
                      <div className="text-[11px] text-zinc-400 mt-0.5">
                        <span>{item.platforms.map((p) => getPlatformLabel(p)).join(' + ')}</span>
                        <span className="mx-1.5">·</span>
                        <span className="font-mono tabular-nums">
                          {formatDateInTimeZone(item.scheduledIso, item.timezone)}{' '}
                          {formatTimeInTimeZone(item.scheduledIso, item.timezone)} ({item.timezone})
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openModalForItem(item)}
                    className="px-2.5 py-1 rounded border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500 shrink-0"
                  >
                    Send Now
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-100">Active Campaigns</h2>
            </div>
            <button
              type="button"
              onClick={() => setNavSection('campaign-manager')}
              className="text-xs text-zinc-400 hover:text-zinc-100"
            >
              Manage Campaigns
            </button>
          </div>
          <div className="divide-y divide-zinc-800/70">
            {activeCampaigns.map((camp) => (
              <div key={camp.id} className="p-5 space-y-1.5">
                <div className="text-xs font-semibold text-zinc-100">{camp.name}</div>
                <p className="text-xs text-zinc-400 leading-relaxed">{camp.objective}</p>
                <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                  {camp.startDate} → {camp.endDate}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Footer Utility Links & Studio Counts */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800/70">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setNavSection('media-library')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>Media Library ({workspaceMedia.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setNavSection('publishing-queue')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <ListChecks className="w-3.5 h-3.5" />
            <span>View Publishing Queue</span>
          </button>
          <button
            type="button"
            onClick={() => setNavSection('connected-accounts')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <span>Connected Accounts (IG &amp; YT)</span>
          </button>
        </div>
        <div className="text-[11px] font-mono text-zinc-500">
          {workspaceProjects.length} Creative Project(s) in {activeWorkspace.name}
        </div>
      </div>

      {/* Manual Send Confirmation Modal */}
      <SendConfirmationModal
        open={Boolean(sendTarget)}
        onClose={() => setSendTarget(null)}
        item={sendTarget?.item || null}
        defaultTargets={sendTarget?.defaultTargets}
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
              status: res.job.status as DashboardQueueItem['effectiveStatus'],
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
          await refreshDashboard();
          if (!res.partialError) {
            notify('success', 'Post published', res.job?.resultUrl || 'Delivered to platform');
          } else {
            notify('warning', 'Partial or Failed Send', res.partialError);
          }
        }}
      />
    </div>
  );
};
