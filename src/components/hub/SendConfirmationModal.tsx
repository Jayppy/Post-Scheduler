import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Instagram,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
  Youtube,
} from 'lucide-react';
import {
  DestinationPublishState,
  MediaAsset,
  PublishingLifecycleStatus,
  SocialPlatform,
  Workspace,
  YouTubePrivacyStatus,
} from '../../types/studio';
import {
  IntegrationsApiError,
  integrationsClient,
  IntegrationsStatusResponse,
  MediaPreviewRef,
  ScheduledJobSummary,
} from '../../services/integrationsClient';
import { getMediaBlob } from '../../services/idb';
import { prepareMediaItemsForPublish, validateMediaForPlatform } from '../../services/mediaPayload';
import { formatReadableDateTime, getPlatformLabel, getStatusLabel } from '../../utils/publishing';
import { isNotFoundError, rehydrateBackendJob } from '../../utils/jobRecovery';

export interface SendModalInput {
  id?: string; // backend jobId if persisted
  postId?: string;
  title: string;
  platform: SocialPlatform;
  platforms?: Array<'instagram' | 'youtube'>;
  destinations?: DestinationPublishState[];
  caption: string;
  hashtags: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  scheduledIso?: string;
  timezone?: string;
  mediaAssetIds?: string[];
  mediaCount?: number;
  mediaPreviews?: MediaPreviewRef[];
  status?: string;
}

interface SendConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  item: SendModalInput | null;
  workspace: Workspace;
  connStatus: IntegrationsStatusResponse | null;
  mediaAssets: MediaAsset[];
  defaultTargets?: Array<'instagram' | 'youtube'>;
  onCompleted?: (result: {
    job?: ScheduledJobSummary;
    results?: Record<string, { ok: boolean; resultUrl?: string; platformPostId?: string; error?: string }>;
    directResultUrl?: string;
    partialError?: string;
  }) => void;
  onOpenConnectedAccounts?: () => void;
}

interface ResolvedPreview {
  key: string;
  url: string;
  mimeType: string;
  filename: string;
}

export const SendConfirmationModal: React.FC<SendConfirmationModalProps> = ({
  open,
  onClose,
  item,
  workspace,
  connStatus,
  mediaAssets,
  defaultTargets,
  onCompleted,
  onOpenConnectedAccounts,
}) => {
  const [selectedTargets, setSelectedTargets] = useState<Array<'instagram' | 'youtube'>>([]);
  const [igFormat, setIgFormat] = useState<'instagram-reel' | 'instagram-carousel' | 'instagram-feed'>(
    'instagram-carousel'
  );
  const [igCaption, setIgCaption] = useState('');
  const [ytTitle, setYtTitle] = useState('');
  const [ytDescription, setYtDescription] = useState('');
  const [ytTagsText, setYtTagsText] = useState('');
  const [ytPrivacy, setYtPrivacy] = useState<YouTubePrivacyStatus>('public');

  const [previews, setPreviews] = useState<ResolvedPreview[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [stageLabel, setStageLabel] = useState<string>('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResults, setSendResults] = useState<Record<
    string,
    { ok: boolean; resultUrl?: string; platformPostId?: string; error?: string }
  > | null>(null);
  const [localDestinations, setLocalDestinations] = useState<DestinationPublishState[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | undefined>(undefined);
  const [activePostId, setActivePostId] = useState<string | undefined>(undefined);
  const initializedSessionRef = useRef<string | null>(null);

  const availablePlatforms: Array<'instagram' | 'youtube'> = useMemo(() => {
    if (!item) return [];
    if (item.platforms && item.platforms.length > 0) return item.platforms;
    if (item.destinations && item.destinations.length > 0) {
      return item.destinations.map((d) => d.platform);
    }
    return [item.platform === 'youtube-shorts' ? 'youtube' : 'instagram'];
  }, [item]);

  useEffect(() => {
    if (!open || !item) {
      initializedSessionRef.current = null;
      return;
    }

    const sessionKey = `${item.id || ''}:${item.postId || ''}:${item.title}:${availablePlatforms.join(',')}`;
    if (initializedSessionRef.current === sessionKey) {
      return;
    }
    initializedSessionRef.current = sessionKey;

    const dests: DestinationPublishState[] =
      item.destinations && item.destinations.length > 0
        ? item.destinations
        : availablePlatforms.map((p) => ({
            platform: p,
            format: p === 'youtube' ? 'youtube-shorts' : item.platform === 'youtube-shorts' ? 'instagram-reel' : item.platform,
            status: 'ready-to-send',
            attempts: 0,
            youtubeTitle: item.title,
            youtubeDescription: item.caption,
            youtubeTags: item.hashtags,
            youtubePrivacyStatus: item.youtubePrivacyStatus || 'public',
            instagramCaption: item.caption,
          }));
    setLocalDestinations(dests);
    setActiveJobId(item.id && item.id.startsWith('job-') ? item.id : undefined);
    setActivePostId(item.postId);

    const igDest = dests.find((d) => d.platform === 'instagram');
    const ytDest = dests.find((d) => d.platform === 'youtube');

    const initialTargets =
      defaultTargets && defaultTargets.length > 0
        ? defaultTargets.filter((t) => dests.find((d) => d.platform === t)?.status !== 'published')
        : dests.filter((d) => d.status !== 'published' && d.status !== 'cancelled').map((d) => d.platform);

    setSelectedTargets(initialTargets);
    setIgFormat(
      igDest && igDest.format !== 'youtube-shorts'
        ? igDest.format
        : item.platform !== 'youtube-shorts'
          ? item.platform
          : 'instagram-reel'
    );
    setIgCaption(igDest?.instagramCaption ?? item.caption ?? '');
    setYtTitle(ytDest?.youtubeTitle ?? item.title ?? '');
    setYtDescription(ytDest?.youtubeDescription ?? item.caption ?? '');
    setYtTagsText((ytDest?.youtubeTags ?? item.hashtags ?? []).join(' '));
    setYtPrivacy(ytDest?.youtubePrivacyStatus || item.youtubePrivacyStatus || 'public');
    setSendError(null);
    setSendResults(null);
    setStageLabel('');
  }, [open, item, availablePlatforms, defaultTargets]);

  // Resolve media previews from IndexedDB first, falling back to backend preview endpoint
  useEffect(() => {
    if (!open || !item) {
      setPreviews([]);
      return;
    }
    let active = true;
    const objectUrls: string[] = [];

    const load = async () => {
      const resolved: ResolvedPreview[] = [];
      const ids = item.mediaAssetIds || [];
      for (const id of ids) {
        const asset = mediaAssets.find((m) => m.id === id);
        if (!asset) continue;
        const blob = await getMediaBlob(asset.blobKey).catch(() => null);
        if (blob && active) {
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          resolved.push({
            key: id,
            url,
            mimeType: blob.type || asset.mimeType,
            filename: asset.name,
          });
        }
      }

      if (resolved.length === 0 && item.mediaPreviews && item.mediaPreviews.length > 0) {
        for (const mp of item.mediaPreviews) {
          resolved.push({
            key: `backend-${mp.index}`,
            url: mp.url,
            mimeType: mp.mimeType,
            filename: mp.filename,
          });
        }
      }

      if (active) setPreviews(resolved);
    };

    load();
    return () => {
      active = false;
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [open, item, mediaAssets]);

  const attachedAssets = useMemo(() => {
    if (!item?.mediaAssetIds?.length) return [];
    return item.mediaAssetIds
      .map((id) => mediaAssets.find((m) => m.id === id))
      .filter((m): m is MediaAsset => Boolean(m));
  }, [item, mediaAssets]);

  const validationIssues = useMemo(() => {
    const issues: string[] = [];
    if (!item) return issues;

    for (const target of selectedTargets) {
      if (target === 'instagram') {
        if (!connStatus?.instagram.connected) {
          issues.push(`Instagram is not connected for ${workspace.name}.`);
        } else if (connStatus.instagram.lastError) {
          issues.push(`Instagram needs reconnect: ${connStatus.instagram.lastError}`);
        }
      }
      if (target === 'youtube') {
        if (!connStatus?.youtube.connected) {
          issues.push(`YouTube is not connected for ${workspace.name}.`);
        } else if (connStatus.youtube.lastError) {
          issues.push(`YouTube needs reconnect: ${connStatus.youtube.lastError}`);
        }
      }

      const formatToCheck: SocialPlatform = target === 'youtube' ? 'youtube-shorts' : igFormat;
      if (attachedAssets.length > 0) {
        const mediaErr = validateMediaForPlatform(formatToCheck, attachedAssets);
        if (mediaErr) issues.push(`${getPlatformLabel(target)}: ${mediaErr}`);
      } else if (item.mediaPreviews && item.mediaPreviews.length > 0) {
        const hasVideo = item.mediaPreviews.some((m) => m.mimeType.startsWith('video/'));
        if ((formatToCheck === 'youtube-shorts' || formatToCheck === 'instagram-reel') && !hasVideo) {
          issues.push(`${getPlatformLabel(target)}: Requires a rendered MP4 video asset.`);
        }
      } else if (item.mediaCount && item.mediaCount > 0) {
        issues.push(
          `${getPlatformLabel(target)}: Attached media is not on this server or browser cache. Re-attach media in Post Composer before sending.`
        );
      } else {
        issues.push(`${getPlatformLabel(target)}: No media files attached to this post.`);
      }
    }

    return issues;
  }, [item, selectedTargets, connStatus, workspace.name, igFormat, attachedAssets]);

  const needsReconciliationDests = useMemo(
    () => localDestinations.filter((d) => d.needsReconciliation),
    [localDestinations]
  );

  if (!open || !item) return null;

  const toggleTarget = (platform: 'instagram' | 'youtube') => {
    const dest = localDestinations.find((d) => d.platform === platform);
    if (dest?.status === 'published' || submitting) return;
    setSelectedTargets((prev) =>
      prev.includes(platform) ? prev.filter((p) => p !== platform) : [...prev, platform]
    );
    setSendError(null);
  };

  const parsedYtTags = () =>
    ytTagsText
      .split(/[\s,]+/)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .filter((t) => t.length > 1);

  const handleReconcile = async (platform: 'instagram' | 'youtube') => {
    const targetJobId = activeJobId || item.id;
    if (!targetJobId || reconciling) return;
    setReconciling(true);
    setSendError(null);
    try {
      let res;
      try {
        res = await integrationsClient.reconcileScheduledJob(targetJobId, platform);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        const restored = await rehydrateBackendJob(
          {
            workspaceId: workspace.id,
            postId: activePostId || item.postId || targetJobId.replace(/^job-/, ''),
            jobId: targetJobId,
            title: item.title,
            platform: item.platform,
            platforms: availablePlatforms,
            destinations: localDestinations,
            caption: item.caption,
            hashtags: item.hashtags,
            youtubePrivacyStatus: item.youtubePrivacyStatus,
            scheduledIso: item.scheduledIso || new Date().toISOString(),
            timezone: item.timezone,
            mediaAssetIds: item.mediaAssetIds,
            mediaCount: item.mediaCount,
            status: (item.status as PublishingLifecycleStatus) || 'failed',
          },
          mediaAssets
        );
        setActiveJobId(restored.id);
        setActivePostId(restored.postId);
        res = await integrationsClient.reconcileScheduledJob(restored.id, platform);
      }
      if (res.job.destinations) {
        setLocalDestinations(res.job.destinations);
      }
      const outcome = res.outcomes[platform];
      if (outcome?.reconciledPublished) {
        setSelectedTargets((prev) => prev.filter((t) => t !== platform));
        onCompleted?.({ job: res.job });
      } else if (outcome?.detail) {
        setSendError(outcome.detail);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Reconciliation check failed.');
    } finally {
      setReconciling(false);
    }
  };

  const handleConfirmSend = async () => {
    const eligibleTargets = selectedTargets.filter(
      (t) => localDestinations.find((d) => d.platform === t)?.status !== 'published'
    );
    if (submitting || eligibleTargets.length === 0) return;
    if (validationIssues.length > 0) {
      setSendError(validationIssues[0]);
      return;
    }

    setSubmitting(true);
    setSendError(null);

    try {
      let hydratedMediaItems:
        | Array<{ filename: string; mimeType: string; base64Data: string }>
        | undefined;
      if (attachedAssets.length > 0) {
        setStageLabel('Encoding attached media assets...');
        const primaryFormat: SocialPlatform = eligibleTargets.includes('youtube')
          ? 'youtube-shorts'
          : igFormat;
        hydratedMediaItems = await prepareMediaItemsForPublish(
          item.mediaAssetIds || [],
          mediaAssets,
          primaryFormat
        );
      }

      const resolvedPostId =
        activePostId ||
        item.postId ||
        `post-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setActivePostId(resolvedPostId);

      const primaryFormatForJob: SocialPlatform = availablePlatforms.includes('instagram')
        ? igFormat
        : 'youtube-shorts';

      let targetJobId =
        activeJobId || (item.id && item.id.startsWith('job-') ? item.id : undefined);

      if (!targetJobId) {
        setStageLabel('Registering idempotent publish record...');
        const synced = await integrationsClient.syncScheduledJob({
          workspaceId: workspace.id,
          postId: resolvedPostId,
          title: (eligibleTargets.includes('youtube') ? ytTitle : item.title) || item.title,
          platform: primaryFormatForJob,
          platforms: availablePlatforms,
          destinations: localDestinations,
          caption: eligibleTargets.includes('instagram') ? igCaption : ytDescription || item.caption,
          hashtags: parsedYtTags().length > 0 ? parsedYtTags() : item.hashtags,
          youtubePrivacyStatus: ytPrivacy,
          scheduledIso: item.scheduledIso || new Date().toISOString(),
          timezone: item.timezone || 'Africa/Lagos',
          mediaAssetIds: item.mediaAssetIds,
          preservedMediaCount:
            hydratedMediaItems?.length || item.mediaCount || attachedAssets.length,
          status: 'scheduled',
          mediaItems: hydratedMediaItems || [],
        });
        targetJobId = synced.id;
        setActiveJobId(synced.id);
      }

      const sendPayload = {
        targets: eligibleTargets,
        instagramCaption: eligibleTargets.includes('instagram') ? igCaption : undefined,
        instagramFormat: eligibleTargets.includes('instagram') ? igFormat : undefined,
        youtubeTitle: eligibleTargets.includes('youtube') ? ytTitle : undefined,
        youtubeDescription: eligibleTargets.includes('youtube') ? ytDescription : undefined,
        youtubeTags: eligibleTargets.includes('youtube') ? parsedYtTags() : undefined,
        youtubePrivacyStatus: eligibleTargets.includes('youtube') ? ytPrivacy : undefined,
        mediaItems: hydratedMediaItems,
      };

      setStageLabel(
        `Publishing to ${eligibleTargets.map((t) => getPlatformLabel(t)).join(' & ')}...`
      );

      let res;
      try {
        res = await integrationsClient.sendScheduledJob(targetJobId, sendPayload);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        setStageLabel('Restoring missing backend post record...');
        const restored = await rehydrateBackendJob(
          {
            workspaceId: workspace.id,
            postId: resolvedPostId,
            jobId: targetJobId,
            title: item.title,
            platform: primaryFormatForJob,
            platforms: availablePlatforms,
            destinations: localDestinations,
            caption: item.caption,
            hashtags: item.hashtags,
            youtubePrivacyStatus: ytPrivacy,
            scheduledIso: item.scheduledIso || new Date().toISOString(),
            timezone: item.timezone || 'Africa/Lagos',
            mediaAssetIds: item.mediaAssetIds,
            mediaCount: item.mediaCount || attachedAssets.length,
            status: (item.status as PublishingLifecycleStatus) || 'scheduled',
            preEncodedMediaItems: hydratedMediaItems,
          },
          mediaAssets
        );
        targetJobId = restored.id;
        setActiveJobId(restored.id);
        setStageLabel(
          `Publishing to ${eligibleTargets.map((t) => getPlatformLabel(t)).join(' & ')}...`
        );
        res = await integrationsClient.sendScheduledJob(restored.id, sendPayload);
      }

      setSendResults((prev) => ({ ...(prev || {}), ...(res.results || {}) }));
      if (res.job?.destinations) {
        setLocalDestinations(res.job.destinations);
        setSelectedTargets(
          res.job.destinations
            .filter((d) => d.status !== 'published' && d.status !== 'cancelled')
            .map((d) => d.platform)
        );
      }
      onCompleted?.({
        job: res.job,
        results: res.results,
        partialError: res.partial ? res.job.error : undefined,
      });
      if (res.partial) {
        setSendError(
          res.job.error ||
            'One destination succeeded and one failed. Only the failed destination remains selectable for retry.'
        );
      }
    } catch (err) {
      if (err instanceof IntegrationsApiError) {
        if (err.results) {
          setSendResults((prev) => ({ ...(prev || {}), ...err.results }));
        }
        if (err.job?.destinations) {
          setLocalDestinations(err.job.destinations);
          setSelectedTargets(
            err.job.destinations
              .filter((d) => d.status !== 'published' && d.status !== 'cancelled')
              .map((d) => d.platform)
          );
          onCompleted?.({
            job: err.job,
            results: err.results,
            partialError: err.message,
          });
        }
      }
      const msg = err instanceof Error ? err.message : 'Publishing failed.';
      setSendError(msg);
    } finally {
      setSubmitting(false);
      setStageLabel('');
    }
  };

  const allCompleted =
    sendResults !== null && Object.values(sendResults).every((r) => r.ok) && !sendError;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-xl bg-[#111114] border border-zinc-700 shadow-2xl overflow-hidden my-6">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
              {workspace.name} · Manual Send Confirmation
            </div>
            <h2 className="text-base font-bold text-zinc-100 mt-0.5 truncate">{item.title}</h2>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="p-1.5 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {item.scheduledIso && (
            <div className="px-3.5 py-2 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-300 flex flex-wrap items-center justify-between gap-2">
              <span>
                Scheduled Slot:{' '}
                <strong className="font-mono text-zinc-100">
                  {formatReadableDateTime(item.scheduledIso, item.timezone || 'Africa/Lagos')}
                </strong>{' '}
                <span className="text-zinc-500">({item.timezone || 'Africa/Lagos'})</span>
              </span>
              {item.status && (
                <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[11px] font-mono">
                  {getStatusLabel(item.status)}
                </span>
              )}
            </div>
          )}

          {/* Reconciliation Alert if previous publish interrupted */}
          {needsReconciliationDests.length > 0 && item.id && (
            <div className="p-3.5 rounded-lg border border-amber-500/40 bg-amber-950/20 space-y-2">
              <div className="flex items-start gap-2 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <div>
                  <strong>Previous send was interrupted.</strong> Verify on the platform before
                  re-sending to guarantee zero duplicate posts.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {needsReconciliationDests.map((d) => (
                  <button
                    key={d.platform}
                    type="button"
                    disabled={reconciling}
                    onClick={() => handleReconcile(d.platform)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-zinc-950 text-xs font-semibold"
                  >
                    {reconciling ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    )}
                    <span>Reconcile {getPlatformLabel(d.platform)} Status</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Media Preview Strip */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-zinc-200 flex items-center justify-between">
              <span>Media Preview ({previews.length || item.mediaCount || 0} asset(s))</span>
            </div>
            {previews.length === 0 ? (
              <div className="p-4 rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-500 flex items-center gap-2">
                <ImageIcon className="w-4 h-4" />
                <span>
                  {item.mediaCount
                    ? `${item.mediaCount} backend media asset(s) ready.`
                    : 'No media preview available in browser IndexedDB.'}
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {previews.map((p, idx) => (
                  <div
                    key={p.key}
                    className="relative rounded-lg overflow-hidden border border-zinc-800 bg-[#09090b] aspect-[4/5]"
                  >
                    {p.mimeType.startsWith('video/') ? (
                      <video src={p.url} controls className="w-full h-full object-cover" />
                    ) : (
                      <img src={p.url} alt={p.filename} className="w-full h-full object-cover" />
                    )}
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-zinc-200 flex items-center gap-1">
                      {p.mimeType.startsWith('video/') ? (
                        <Film className="w-2.5 h-2.5" />
                      ) : (
                        <ImageIcon className="w-2.5 h-2.5" />
                      )}
                      <span>#{idx + 1}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Destination Platform Cards */}
          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-zinc-200">
              Destination Account(s) &amp; Confirmation
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {localDestinations.map((dest) => {
                const isIg = dest.platform === 'instagram';
                const acc = isIg ? connStatus?.instagram : connStatus?.youtube;
                const alreadyPublished = dest.status === 'published';
                const checked = selectedTargets.includes(dest.platform);

                return (
                  <div
                    key={dest.platform}
                    onClick={() => toggleTarget(dest.platform)}
                    className={`p-3.5 rounded-lg border transition-colors ${
                      alreadyPublished
                        ? 'border-emerald-500/40 bg-emerald-950/15 cursor-default'
                        : checked
                          ? 'border-zinc-300 bg-[#18181d] cursor-pointer'
                          : 'border-zinc-800 bg-[#09090b] opacity-75 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={alreadyPublished ? true : checked}
                          disabled={alreadyPublished || submitting}
                          onChange={() => {}}
                          className="accent-zinc-100"
                        />
                        {isIg ? (
                          <Instagram className="w-4 h-4 text-zinc-200" />
                        ) : (
                          <Youtube className="w-4 h-4 text-zinc-200" />
                        )}
                        <span className="text-xs font-semibold text-zinc-100">
                          {getPlatformLabel(dest.platform)}
                        </span>
                      </div>

                      {alreadyPublished ? (
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          Published
                        </span>
                      ) : dest.status === 'failed' ? (
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/40">
                          Retry Needed
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono uppercase text-zinc-400">
                          {getPlatformLabel(dest.format)}
                        </span>
                      )}
                    </div>

                    <div className="mt-2 text-[11px] text-zinc-400">
                      {acc?.connected ? (
                        <span className={acc.lastError ? 'text-amber-300' : 'text-zinc-300'}>
                          Account:{' '}
                          <strong>
                            {acc.accountHandle
                              ? acc.accountHandle.startsWith('@')
                                ? acc.accountHandle
                                : `@${acc.accountHandle}`
                              : acc.accountName}
                          </strong>
                          {acc.lastError && ` · ${acc.lastError}`}
                        </span>
                      ) : (
                        <div className="flex items-center justify-between gap-2 text-amber-300">
                          <span>Not connected in {workspace.name}</span>
                          {onOpenConnectedAccounts && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onClose();
                                onOpenConnectedAccounts();
                              }}
                              className="inline-flex items-center gap-1 underline font-semibold shrink-0"
                            >
                              <Link2 className="w-3 h-3" />
                              <span>Connect</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {alreadyPublished && dest.resultUrl && (
                      <div className="mt-1.5">
                        <a
                          href={dest.resultUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-[11px] text-emerald-300 underline"
                        >
                          <span>View Live Post</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Instagram Confirmation Settings */}
          {selectedTargets.includes('instagram') && (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                  <Instagram className="w-3.5 h-3.5" />
                  <span>Instagram Publishing Metadata</span>
                </div>
                <select
                  value={igFormat}
                  disabled={submitting}
                  onChange={(e) =>
                    setIgFormat(
                      e.target.value as 'instagram-reel' | 'instagram-carousel' | 'instagram-feed'
                    )
                  }
                  className="px-2.5 py-1 rounded bg-[#141418] border border-zinc-700 text-[11px] text-zinc-200"
                >
                  <option value="instagram-carousel">Instagram Carousel</option>
                  <option value="instagram-reel">Instagram Reel</option>
                  <option value="instagram-feed">Instagram Feed Post</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Instagram Caption</label>
                <textarea
                  rows={3}
                  disabled={submitting}
                  value={igCaption}
                  onChange={(e) => setIgCaption(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>
          )}

          {/* YouTube Confirmation Settings */}
          {selectedTargets.includes('youtube') && (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                  <Youtube className="w-3.5 h-3.5" />
                  <span>YouTube Shorts Metadata</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-400">Visibility:</span>
                  <select
                    value={ytPrivacy}
                    disabled={submitting}
                    onChange={(e) => setYtPrivacy(e.target.value as YouTubePrivacyStatus)}
                    className="px-2.5 py-1 rounded bg-[#141418] border border-zinc-700 text-[11px] text-zinc-200"
                  >
                    <option value="public">Public</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="private">Private</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Video Title (max 100)</label>
                  <input
                    type="text"
                    maxLength={100}
                    disabled={submitting}
                    value={ytTitle}
                    onChange={(e) => setYtTitle(e.target.value)}
                    className="w-full px-3 py-1.5 rounded bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Tags</label>
                  <input
                    type="text"
                    disabled={submitting}
                    value={ytTagsText}
                    onChange={(e) => setYtTagsText(e.target.value)}
                    className="w-full px-3 py-1.5 rounded bg-[#111114] border border-zinc-800 text-xs font-mono text-zinc-200"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Video Description</label>
                <textarea
                  rows={3}
                  disabled={submitting}
                  value={ytDescription}
                  onChange={(e) => setYtDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>
          )}

          {/* Pre-send validation warnings */}
          {validationIssues.length > 0 && !allCompleted && (
            <div className="p-3.5 rounded-lg border border-amber-500/40 bg-amber-950/20 space-y-1 text-xs text-amber-200">
              {validationIssues.map((msg, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                  <span>{msg}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error Banner */}
          {sendError && (
            <div className="p-3.5 rounded-lg border border-red-500/40 bg-red-950/20 text-xs text-red-200">
              {sendError}
            </div>
          )}

          {/* Live Send Result Summary */}
          {sendResults && (
            <div className="p-4 rounded-lg border border-zinc-700 bg-[#09090b] space-y-2">
              <div className="text-xs font-semibold text-zinc-100">Publishing Result</div>
              {Object.entries(sendResults).map(([platform, r]) => (
                <div
                  key={platform}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs py-1 border-t border-zinc-800/80 first:border-t-0"
                >
                  <div className="flex items-center gap-2">
                    {r.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                    )}
                    <span className="font-medium text-zinc-200">
                      {getPlatformLabel(platform as 'instagram' | 'youtube')}
                    </span>
                    {r.platformPostId && (
                      <span className="font-mono text-[11px] text-zinc-500">
                        ID: {r.platformPostId}
                      </span>
                    )}
                  </div>
                  {r.ok && r.resultUrl ? (
                    <a
                      href={r.resultUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-emerald-300 underline"
                    >
                      <span>View Live</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : r.error ? (
                    <span className="text-red-300 text-[11px]">{r.error}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-[#0c0c0f]">
          <div className="text-[11px] text-zinc-400">
            {stageLabel ? (
              <span className="inline-flex items-center gap-1.5 text-zinc-200">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{stageLabel}</span>
              </span>
            ) : (
              <span>Nothing publishes until you click Send Now below.</span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-zinc-700 text-xs text-zinc-300 hover:text-white disabled:opacity-50"
            >
              {allCompleted ? 'Done' : 'Cancel'}
            </button>

            {!allCompleted && selectedTargets.length > 0 && (
              <button
                type="button"
                disabled={submitting || validationIssues.length > 0}
                onClick={handleConfirmSend}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-50 text-xs font-semibold"
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : sendResults ? (
                  <RefreshCw className="w-3.5 h-3.5" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>
                  {submitting
                    ? 'Sending...'
                    : sendResults
                      ? 'Retry Failed Destination'
                      : 'Send Now'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
