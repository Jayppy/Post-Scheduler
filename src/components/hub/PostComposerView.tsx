import React, { useEffect, useState } from 'react';
import { Calendar, Check, Film, Image as ImageIcon, ListChecks, Send, X } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { getMediaBlob } from '../../services/idb';
import { createId } from '../../services/storage';
import { SocialPlatform, SocialPost } from '../../types/studio';

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

  const [title, setTitle] = useState(composerDraft?.title || '');
  const [platform, setPlatform] = useState<SocialPlatform>(
    composerDraft?.platform || 'instagram-carousel'
  );
  const [caption, setCaption] = useState(composerDraft?.caption || '');
  const [hashtagsText, setHashtagsText] = useState(
    (composerDraft?.hashtags || ['#74Studio']).join(' ')
  );
  const [attachedIds, setAttachedIds] = useState<string[]>(composerDraft?.mediaAssetIds || []);
  const [campaignId, setCampaignId] = useState('');
  const [scheduledDate, setScheduledDate] = useState('2026-11-26');
  const [scheduledTime, setScheduledTime] = useState('18:00');
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!composerDraft) return;
    setTitle(composerDraft.title);
    setPlatform(composerDraft.platform);
    setCaption(composerDraft.caption);
    setHashtagsText(composerDraft.hashtags.join(' '));
    setAttachedIds(composerDraft.mediaAssetIds);
  }, [composerDraft]);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const load = async () => {
      const next: Record<string, string> = {};
      for (const id of attachedIds) {
        const asset = workspaceMedia.find((m) => m.id === id);
        if (!asset) continue;
        const blob = await getMediaBlob(asset.blobKey);
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

  const attachedAssets = attachedIds
    .map((id) => workspaceMedia.find((m) => m.id === id))
    .filter(Boolean);

  const toggleAsset = (id: string) => {
    setAttachedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const commitPost = (status: SocialPost['status']) => {
    if (!title.trim() && !caption.trim()) {
      notify('warning', 'Add a post title or caption before saving.');
      return;
    }
    const now = new Date().toISOString();
    const hashtags = hashtagsText
      .split(/\s+/)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .filter((t) => t.length > 1);

    const post: SocialPost = {
      id: createId('post'),
      workspaceId: activeWorkspace.id,
      title: title.trim() || `${platform} Post`,
      platform,
      caption,
      hashtags,
      mediaAssetIds: attachedIds,
      status,
      scheduledDate: status === 'scheduled' ? scheduledDate : undefined,
      scheduledTime: status === 'scheduled' ? scheduledTime : undefined,
      campaignId: campaignId || undefined,
      sourceProjectId: composerDraft?.sourceProjectId,
      createdAt: now,
      updatedAt: now,
    };

    savePost(post);
    setComposerDraft(null);
    notify(
      'success',
      status === 'scheduled'
        ? `Scheduled for ${scheduledDate}`
        : status === 'queued'
          ? 'Added to Publishing Queue'
          : 'Saved to workspace',
      post.title
    );

    if (status === 'scheduled') setNavSection('content-calendar');
    else if (status === 'queued') setNavSection('publishing-queue');
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800/80 pb-5">
        <div className="text-xs text-zinc-400 mb-1">
          <span>{activeWorkspace.name}</span>
          <span className="mx-2 text-zinc-600">·</span>
          <span>Post Composer</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Compose & Schedule Social Post</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Post Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Release Breakdown Carousel"
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Destination</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="instagram-carousel">Instagram Carousel</option>
                <option value="instagram-reel">Instagram Reel</option>
                <option value="youtube-shorts">YouTube Shorts</option>
                <option value="instagram-feed">Instagram Single Post</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Caption</label>
            <textarea
              rows={5}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write your post caption..."
              className="w-full px-3 py-2.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Hashtags</label>
            <input
              type="text"
              value={hashtagsText}
              onChange={(e) => setHashtagsText(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs font-mono text-zinc-200"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          </div>

          <div className="pt-3 border-t border-zinc-800 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => commitPost('scheduled')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Schedule to Calendar</span>
            </button>
            <button
              type="button"
              onClick={() => commitPost('queued')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-zinc-700 text-xs font-medium text-zinc-100 hover:border-zinc-500"
            >
              <ListChecks className="w-3.5 h-3.5" />
              <span>Add to Queue</span>
            </button>
            <button
              type="button"
              onClick={() => commitPost('published')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:text-white"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Mark Published</span>
            </button>
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
                  if (!asset) return null;
                  const url = previewUrls[asset.id];
                  return (
                    <div
                      key={asset.id}
                      className="relative rounded-lg overflow-hidden border border-zinc-700 bg-[#09090b] aspect-[4/5]"
                    >
                      {url && (asset.mimeType.startsWith('video/') || asset.mediaType === 'reel-export') ? (
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
    </div>
  );
};
