import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Save,
  Send,
  X,
  Youtube,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import { getMediaBlob } from '../../services/idb';
import { integrationsClient, IntegrationsStatusResponse } from '../../services/integrationsClient';
import { prepareMediaItemsForPublish, validateMediaForPlatform } from '../../services/mediaPayload';
import { createId } from '../../services/storage';
import {
  DestinationPublishState,
  MediaAsset,
  SocialPlatform,
  SocialPost,
  YouTubePrivacyStatus,
} from '../../types/studio';
import {
  DEFAULT_PUBLISHING_TIMEZONE,
  SUPPORTED_TIMEZONES,
  formatDateInTimeZone,
  formatReadableDateTime,
  formatTimeInTimeZone,
  getUserLocalTimezone,
  zonedDateTimeToUtcIso,
} from '../../utils/publishing';
import { isNotFoundError } from '../../utils/jobRecovery';
import { SendConfirmationModal, SendModalInput } from './SendConfirmationModal';

type DestinationSelection = SocialPlatform | 'both-video';

export const PostComposerView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceMedia,
    workspaceCampaigns,
    composerDraft,
    setComposerDraft,
    savePost,
    setNavSection,
    notify,
  } = useStudio();
  const { user, syncFromServerSnapshot } = useFirebase();

  const localTz = useMemo(() => getUserLocalTimezone(), []);
  const timezoneOptions = useMemo(() => {
    const list = new Set<string>([DEFAULT_PUBLISHING_TIMEZONE, ...SUPPORTED_TIMEZONES, localTz]);
    return Array.from(list);
  }, [localTz]);

  const [editingPostId, setEditingPostId] = useState<string | undefined>(composerDraft?.editingPostId);
  const [editingJobId, setEditingJobId] = useState<string | undefined>(composerDraft?.editingJobId);
  const [partialDestinations, setPartialDestinations] = useState<
    DestinationPublishState[] | undefined
  >(undefined);
  const [title, setTitle] = useState(composerDraft?.title || '');
  const [destination, setDestination] = useState<DestinationSelection>(
    composerDraft?.platform || 'instagram-carousel'
  );
  const [caption, setCaption] = useState(composerDraft?.caption || '');
  const [hashtagsText, setHashtagsText] = useState(
    (composerDraft?.hashtags || ['#BehindTheRelease']).join(' ')
  );
  const [youtubePrivacyStatus, setYoutubePrivacyStatus] = useState<YouTubePrivacyStatus>(
    composerDraft?.youtubePrivacyStatus || 'public'
  );
  const [attachedIds, setAttachedIds] = useState<string[]>(composerDraft?.mediaAssetIds || []);
  const [campaignId, setCampaignId] = useState('');
  const [timezone, setTimezone] = useState<string>(
    composerDraft?.timezone || DEFAULT_PUBLISHING_TIMEZONE
  );
  const [scheduledDate, setScheduledDate] = useState(
    () => composerDraft?.scheduledDate || formatDateInTimeZone(new Date(), DEFAULT_PUBLISHING_TIMEZONE)
  );
  const [scheduledTime, setScheduledTime] = useState(
    () => composerDraft?.scheduledTime || '18:00'
  );

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [connStatus, setConnStatus] = useState<IntegrationsStatusResponse | null>(null);
  const [submitting, setSubmitting] = useState<'schedule' | 'draft' | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastPublishedUrls, setLastPublishedUrls] = useState<string[]>([]);
  const [sendModalOpen, setSendModalOpen] = useState(false);

  useEffect(() => {
    if (!composerDraft) return;
    setEditingPostId(composerDraft.editingPostId);
    setEditingJobId(composerDraft.editingJobId);
    setPartialDestinations(undefined);
    setTitle(composerDraft.title);
    setDestination(composerDraft.platform);
    setCaption(composerDraft.caption);
    setHashtagsText(composerDraft.hashtags.join(' '));
    setAttachedIds(composerDraft.mediaAssetIds);
    setYoutubePrivacyStatus(composerDraft.youtubePrivacyStatus || 'public');
    const nextTz = composerDraft.timezone || DEFAULT_PUBLISHING_TIMEZONE;
    setTimezone(nextTz);
    setScheduledDate(composerDraft.scheduledDate || formatDateInTimeZone(new Date(), nextTz));
    setScheduledTime(composerDraft.scheduledTime || '18:00');
    setLastError(null);
    setLastPublishedUrls([]);
  }, [composerDraft]);

  useEffect(() => {
    let active = true;
    integrationsClient
      .getStatus(activeWorkspace.id)
      .then((res) => {
        if (active) setConnStatus(res);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeWorkspace.id]);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const load = async () => {
      const next: Record<string, string> = {};
      for (const id of attachedIds) {
        const asset = workspaceMedia.find((m) => m.id === id);
        if (!asset) continue;
        const blob = await getMediaBlob(asset.blobKey).catch(() => null);
        if (blob && active) {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          next[id] = url;
        }
      }
      if (active) setPreviewUrls(next);
    };
    load();
    return () => {
      active = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [attachedIds, workspaceMedia]);

  const attachedAssets = useMemo(
    () =>
      attachedIds
        .map((id) => workspaceMedia.find((m) => m.id === id))
        .filter((m): m is MediaAsset => Boolean(m)),
    [attachedIds, workspaceMedia]
  );

  const targetPlatforms: SocialPlatform[] = useMemo(
    () => (destination === 'both-video' ? ['instagram-reel', 'youtube-shorts'] : [destination]),
    [destination]
  );

  const targetDestPlatforms: Array<'instagram' | 'youtube'> = useMemo(
    () =>
      destination === 'both-video'
        ? ['instagram', 'youtube']
        : [destination === 'youtube-shorts' ? 'youtube' : 'instagram'],
    [destination]
  );

  const primaryPlatform: SocialPlatform =
    destination === 'both-video' ? 'instagram-reel' : destination;

  const scheduledIsoPreview = useMemo(
    () => zonedDateTimeToUtcIso(scheduledDate, scheduledTime || '18:00', timezone),
    [scheduledDate, scheduledTime, timezone]
  );

  const connectionChecks = useMemo(() => {
    const needsIg = targetDestPlatforms.includes('instagram');
    const needsYt = targetDestPlatforms.includes('youtube');
    const igConnected = Boolean(connStatus?.instagram.connected && !connStatus?.instagram.lastError);
    const ytConnected = Boolean(
      connStatus?.youtube.connected &&
        !connStatus?.youtube.lastError &&
        !connStatus?.youtube.needsReconnect
    );

    const missingPlatforms: string[] = [];
    if (needsIg && !igConnected) missingPlatforms.push('Instagram');
    if (needsYt && !ytConnected) missingPlatforms.push('YouTube');

    return {
      needsIg,
      needsYt,
      igConnected,
      ytConnected,
      missingPlatforms,
      ready: missingPlatforms.length === 0,
    };
  }, [connStatus, targetDestPlatforms]);

  const mediaValidationError = useMemo(() => {
    for (const p of targetPlatforms) {
      const err = validateMediaForPlatform(p, attachedAssets);
      if (err) return err;
    }
    return null;
  }, [targetPlatforms, attachedAssets]);

  const toggleAsset = (id: string) => {
    setLastError(null);
    setAttachedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const parsedHashtags = () =>
    hashtagsText
      .split(/\s+/)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .filter((t) => t.length > 1);

  const syncCloudSnapshot = async () => {
    if (!user || !user.emailVerified) return;
    const [s, j, h] = await Promise.all([
      integrationsClient.getStatus(activeWorkspace.id, false),
      integrationsClient.listScheduledJobs(activeWorkspace.id),
      integrationsClient.listPublishHistory(activeWorkspace.id),
    ]);
    await syncFromServerSnapshot(activeWorkspace.id, s, j, h).catch(() => {});
  };

  const handleSaveScheduleOrDraft = async (targetMode: 'scheduled' | 'draft') => {
    setLastError(null);
    if (!title.trim() && !caption.trim()) {
      setLastError('Add a title or caption before saving.');
      return;
    }
    if (targetMode === 'scheduled' && mediaValidationError) {
      setLastError(mediaValidationError);
      return;
    }

    setSubmitting(targetMode === 'scheduled' ? 'schedule' : 'draft');
    const now = new Date().toISOString();
    const hashtags = parsedHashtags();
    const postId = editingPostId || createId('post');
    const scheduledIso = zonedDateTimeToUtcIso(scheduledDate, scheduledTime || '18:00', timezone);
    const displayDate = formatDateInTimeZone(scheduledIso, timezone);
    const displayTime = formatTimeInTimeZone(scheduledIso, timezone);

    try {
      const mediaItems =
        attachedAssets.length > 0
          ? await prepareMediaItemsForPublish(attachedIds, workspaceMedia, primaryPlatform)
          : [];

      const syncPayload = {
        workspaceId: activeWorkspace.id,
        postId,
        title: title.trim() || `${activeWorkspace.name} Post`,
        platform: primaryPlatform,
        platforms: targetDestPlatforms,
        destinations: partialDestinations,
        caption,
        hashtags,
        youtubePrivacyStatus: targetDestPlatforms.includes('youtube')
          ? youtubePrivacyStatus
          : undefined,
        scheduledIso,
        timezone,
        campaignId: campaignId || undefined,
        mediaAssetIds: attachedIds,
        status: targetMode,
        mediaItems,
      };

      let job;
      if (editingJobId) {
        try {
          job = await integrationsClient.updateScheduledJob(editingJobId, {
            title: syncPayload.title,
            platform: syncPayload.platform,
            platforms: syncPayload.platforms,
            caption: syncPayload.caption,
            hashtags: syncPayload.hashtags,
            youtubePrivacyStatus: syncPayload.youtubePrivacyStatus,
            scheduledIso: syncPayload.scheduledIso,
            timezone: syncPayload.timezone,
            status: targetMode,
            mediaAssetIds: syncPayload.mediaAssetIds,
            mediaItems: syncPayload.mediaItems,
          });
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
          job = await integrationsClient.syncScheduledJob(syncPayload);
        }
      } else {
        job = await integrationsClient.syncScheduledJob(syncPayload);
      }

      const resolvedStatus: SocialPost['status'] =
        job.status === 'ready-to-send'
          ? 'ready-to-send'
          : targetMode === 'draft'
            ? 'draft'
            : 'scheduled';

      savePost({
        id: postId,
        workspaceId: activeWorkspace.id,
        title: title.trim() || `${activeWorkspace.name} Post`,
        platform: primaryPlatform,
        platforms: targetDestPlatforms,
        caption,
        hashtags,
        mediaAssetIds: attachedIds,
        status: resolvedStatus,
        scheduledDate: displayDate,
        scheduledTime: displayTime,
        timezone,
        scheduledIso,
        youtubePrivacyStatus: targetDestPlatforms.includes('youtube')
          ? youtubePrivacyStatus
          : undefined,
        backendJobId: job.id,
        backendStatus: job.status,
        campaignId: campaignId || undefined,
        sourceProjectId: composerDraft?.sourceProjectId,
        createdAt: now,
        updatedAt: now,
      });

      setComposerDraft(null);
      setEditingPostId(undefined);
      setEditingJobId(undefined);
      await syncCloudSnapshot();

      if (targetMode === 'draft') {
        notify('success', 'Draft saved', 'Saved in Publishing Queue and Workspace storage.');
        setNavSection('publishing-queue');
      } else {
        notify(
          'success',
          job.status === 'ready-to-send'
            ? 'Saved & Ready to Send'
            : 'Scheduled for Manual Send',
          `${displayDate} ${displayTime} (${timezone}) — open Publishing Queue or Today's Dashboard to Send Now when due.`
        );
        setNavSection('content-calendar');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save post.';
      setLastError(msg);
      notify('error', targetMode === 'draft' ? 'Draft save failed' : 'Scheduling failed', msg);
    } finally {
      setSubmitting(null);
    }
  };

  const handleOpenSendModal = () => {
    setLastError(null);
    setLastPublishedUrls([]);
    if (!title.trim() && !caption.trim()) {
      setLastError('Add a title or caption before sending.');
      return;
    }
    if (mediaValidationError) {
      setLastError(mediaValidationError);
      return;
    }
    setSendModalOpen(true);
  };

  const modalInput: SendModalInput = useMemo(
    () => ({
      id: editingJobId,
      postId: editingPostId,
      title: title.trim() || `${activeWorkspace.name} Release`,
      platform: primaryPlatform,
      platforms: targetDestPlatforms,
      destinations: partialDestinations,
      caption,
      hashtags: parsedHashtags(),
      youtubePrivacyStatus: targetDestPlatforms.includes('youtube') ? youtubePrivacyStatus : undefined,
      scheduledIso: scheduledIsoPreview,
      timezone,
      mediaAssetIds: attachedIds,
      mediaCount: attachedAssets.length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      editingJobId,
      editingPostId,
      title,
      activeWorkspace.name,
      primaryPlatform,
      targetDestPlatforms,
      partialDestinations,
      caption,
      hashtagsText,
      youtubePrivacyStatus,
      scheduledIsoPreview,
      timezone,
      attachedIds,
      attachedAssets.length,
    ]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Post Composer</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">
            {editingPostId ? 'Edit Scheduled / Draft Post' : 'Compose, Schedule & Send'}
          </h1>
        </div>

        {/* Workspace Connection Readiness Pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border ${
              connStatus?.instagram.connected && !connStatus?.instagram.lastError
                ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                : 'border-zinc-800 bg-[#111114] text-zinc-400'
            }`}
          >
            {connStatus?.instagram.connected ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            )}
            <span>
              IG:{' '}
              {connStatus?.instagram.accountHandle
                ? `@${connStatus.instagram.accountHandle}`
                : 'Not linked'}
            </span>
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border ${
              connStatus?.youtube.connected && !connStatus?.youtube.lastError
                ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                : 'border-zinc-800 bg-[#111114] text-zinc-400'
            }`}
          >
            {connStatus?.youtube.connected ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            )}
            <span>YT: {connStatus?.youtube.accountName || 'Not linked'}</span>
          </span>
          <button
            type="button"
            onClick={() => setNavSection('connected-accounts')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-200"
          >
            <Link2 className="w-3 h-3" />
            <span>Manage</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Post Title / Video Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Release Breakdown Carousel"
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Destination Platform(s)
              </label>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value as DestinationSelection)}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="instagram-carousel">Instagram Carousel</option>
                <option value="instagram-reel">Instagram Reel</option>
                <option value="youtube-shorts">YouTube Shorts</option>
                <option value="instagram-feed">Instagram Single Post</option>
                <option value="both-video">Instagram Reel + YouTube Shorts (Both)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              {destination === 'youtube-shorts' ? 'Video Description' : 'Caption / Description'}
            </label>
            <textarea
              rows={5}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write your caption or YouTube description..."
              className="w-full px-3 py-2.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Hashtags / YouTube Tags
            </label>
            <input
              type="text"
              value={hashtagsText}
              onChange={(e) => setHashtagsText(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-200"
            />
          </div>

          {targetDestPlatforms.includes('youtube') && (
            <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-zinc-200">
                <Youtube className="w-4 h-4 text-zinc-300" />
                <span>YouTube Shorts Visibility</span>
              </div>
              <select
                value={youtubePrivacyStatus}
                onChange={(e) => setYoutubePrivacyStatus(e.target.value as YouTubePrivacyStatus)}
                className="px-3 py-1.5 rounded bg-[#141418] border border-zinc-700 text-xs text-zinc-100"
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Campaign</label>
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              >
                <option value="">No campaign</option>
                {workspaceCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Schedule Date</label>
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Schedule Time</label>
              <input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-300 flex items-start gap-2.5">
            <Clock className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div>
                <strong>Schedule &amp; Send (Manual Publishing):</strong> Scheduled posts appear in
                Today&apos;s Dashboard &amp; Publishing Queue and switch to{' '}
                <span className="text-zinc-100 font-semibold">Ready to Send</span> at{' '}
                <span className="font-mono text-zinc-100">
                  {formatReadableDateTime(scheduledIsoPreview, timezone)} ({timezone})
                </span>
                .
              </div>
              {localTz !== timezone && (
                <div className="text-[11px] text-zinc-500 font-mono">
                  Your browser local time: {formatReadableDateTime(scheduledIsoPreview, localTz)} ({localTz})
                </div>
              )}
            </div>
          </div>

          {/* Validation / Error Banners */}
          {!connectionChecks.ready && (
            <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-950/20 text-xs text-amber-200 flex items-center justify-between gap-3">
              <span>
                {connectionChecks.missingPlatforms.join(' and ')} not connected for {activeWorkspace.name}.
                You can still schedule or save as draft now, then connect before sending.
              </span>
              <button
                type="button"
                onClick={() => setNavSection('connected-accounts')}
                className="underline font-semibold shrink-0"
              >
                Connect Now
              </button>
            </div>
          )}

          {mediaValidationError && (
            <div className="p-3 rounded-lg border border-zinc-700 bg-[#09090b] text-xs text-zinc-300">
              Media check: {mediaValidationError}
            </div>
          )}

          {lastError && (
            <div className="p-3 rounded-lg border border-red-500/40 bg-red-950/20 text-xs text-red-200">
              {lastError}
            </div>
          )}

          {lastPublishedUrls.length > 0 && (
            <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-950/20 text-xs text-emerald-200 space-y-1">
              <div className="font-semibold">Published to Live Platform(s):</div>
              {lastPublishedUrls.map((u, idx) => (
                <a
                  key={idx}
                  href={u}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline mr-3"
                >
                  <span>{u}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              ))}
            </div>
          )}

          <div className="pt-3 border-t border-zinc-800 flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={submitting !== null}
              onClick={handleOpenSendModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-50 text-xs font-semibold"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Now</span>
            </button>

            <button
              type="button"
              disabled={submitting !== null}
              onClick={() => handleSaveScheduleOrDraft('scheduled')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50 text-xs font-semibold"
            >
              {submitting === 'schedule' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Calendar className="w-3.5 h-3.5" />
              )}
              <span>
                {submitting === 'schedule'
                  ? 'Saving Schedule...'
                  : editingPostId
                    ? 'Update Schedule'
                    : 'Schedule Post'}
              </span>
            </button>

            <button
              type="button"
              disabled={submitting !== null}
              onClick={() => handleSaveScheduleOrDraft('draft')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
            >
              {submitting === 'draft' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{submitting === 'draft' ? 'Saving...' : 'Save Draft'}</span>
            </button>

            {editingPostId && (
              <button
                type="button"
                onClick={() => {
                  setEditingPostId(undefined);
                  setEditingJobId(undefined);
                  setPartialDestinations(undefined);
                  setComposerDraft(null);
                }}
                className="px-3.5 py-2 rounded-md border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200"
              >
                New Post
              </button>
            )}
          </div>
        </div>

        {/* Attached Media Preview & Media Library Picker */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
            <div className="text-xs font-semibold text-zinc-100">
              Attached Media Order ({attachedAssets.length})
            </div>

            {attachedAssets.length === 0 ? (
              <div className="p-6 rounded-lg border border-dashed border-zinc-800 text-center text-xs text-zinc-500">
                Select slides or exported videos below, or send directly from Carousel / Reels Studio.
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {attachedAssets.map((asset, idx) => {
                  const url = previewUrls[asset.id];
                  return (
                    <div
                      key={asset.id}
                      className="relative rounded-lg overflow-hidden border border-zinc-700 bg-[#09090b] aspect-[4/5]"
                    >
                      {url &&
                      (asset.mimeType.startsWith('video/') || asset.mediaType === 'reel-export') ? (
                        <video src={url} controls className="w-full h-full object-cover" />
                      ) : url ? (
                        <img src={url} alt={asset.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-600">
                          <Film className="w-5 h-5" />
                        </div>
                      )}
                      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-zinc-200">
                        #{idx + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleAsset(asset.id)}
                        className="absolute top-1.5 right-1.5 p-1 rounded bg-black/80 text-zinc-300 hover:text-white"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
            <div className="text-xs font-semibold text-zinc-100">
              Attach from {activeWorkspace.name} Media Library
            </div>
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {workspaceMedia.length === 0 ? (
                <div className="text-xs text-zinc-500">No assets in workspace Media Library yet.</div>
              ) : (
                workspaceMedia.map((m) => {
                  const selected = attachedIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleAsset(m.id)}
                      className={`w-full px-3 py-2 rounded border text-left text-xs flex items-center justify-between gap-2 ${
                        selected
                          ? 'bg-[#1a1a22] border-zinc-300 text-zinc-100'
                          : 'bg-[#09090b] border-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        {m.mediaType === 'reel-export' || m.mediaType === 'video' ? (
                          <Film className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span className="truncate">{m.name}</span>
                      </span>
                      {selected && <Check className="w-3.5 h-3.5 text-zinc-100 shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Manual Send Confirmation Modal */}
      <SendConfirmationModal
        open={sendModalOpen}
        onClose={() => setSendModalOpen(false)}
        item={modalInput}
        workspace={activeWorkspace}
        connStatus={connStatus}
        mediaAssets={workspaceMedia}
        onOpenConnectedAccounts={() => setNavSection('connected-accounts')}
        onCompleted={async (res) => {
          const now = new Date().toISOString();
          const urls = Object.values(res.results || {})
            .map((r) => r.resultUrl)
            .filter((u): u is string => Boolean(u));
          if (urls.length > 0) setLastPublishedUrls(urls);

          if (res.job) {
            setEditingPostId(res.job.postId);
            setEditingJobId(res.job.id);
            setPartialDestinations(res.partialError ? res.job.destinations : undefined);
            savePost({
              id: res.job.postId,
              workspaceId: res.job.workspaceId,
              title: res.job.title,
              platform: res.job.platform,
              platforms: res.job.platforms,
              caption: res.job.caption,
              hashtags: res.job.hashtags,
              mediaAssetIds: res.job.mediaAssetIds || attachedIds,
              status: res.job.status as SocialPost['status'],
              scheduledDate: formatDateInTimeZone(res.job.scheduledIso, res.job.timezone || timezone),
              scheduledTime: formatTimeInTimeZone(res.job.scheduledIso, res.job.timezone || timezone),
              timezone: res.job.timezone || timezone,
              scheduledIso: res.job.scheduledIso,
              youtubePrivacyStatus: res.job.youtubePrivacyStatus,
              backendJobId: res.job.id,
              backendStatus: res.job.status,
              publishResultUrl: res.job.resultUrl,
              publishError: res.job.error,
              createdAt: res.job.createdAt || now,
              updatedAt: now,
            });
          } else {
            const entries = Object.entries(res.results || {});
            const anyOk = entries.some(([, r]) => r.ok);
            const allOk = entries.length > 0 && entries.every(([, r]) => r.ok);
            const postId = editingPostId || createId('post');
            savePost({
              id: postId,
              workspaceId: activeWorkspace.id,
              title: title.trim() || `${activeWorkspace.name} Release`,
              platform: primaryPlatform,
              platforms: targetDestPlatforms,
              caption,
              hashtags: parsedHashtags(),
              mediaAssetIds: attachedIds,
              status: allOk ? 'published' : anyOk ? 'partially-published' : 'failed',
              backendStatus: allOk ? 'published' : anyOk ? 'partially-published' : 'failed',
              publishResultUrl: urls[0],
              publishError: res.partialError,
              youtubePrivacyStatus: targetDestPlatforms.includes('youtube')
                ? youtubePrivacyStatus
                : undefined,
              campaignId: campaignId || undefined,
              sourceProjectId: composerDraft?.sourceProjectId,
              createdAt: now,
              updatedAt: now,
            });
          }

          await syncCloudSnapshot();
          if (!res.partialError) {
            setComposerDraft(null);
            setEditingPostId(undefined);
            setEditingJobId(undefined);
            setPartialDestinations(undefined);
            notify('success', 'Published to live account', urls[0] || activeWorkspace.name);
          } else {
            notify('warning', 'Partial or Failed Send', res.partialError);
          }
        }}
      />
    </div>
  );
};
