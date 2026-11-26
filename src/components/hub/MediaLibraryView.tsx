import React, { useEffect, useState } from 'react';
import { Download, Film, Image as ImageIcon, Music, Send, Trash2, Upload, X } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { triggerBlobDownload } from '../../services/carouselRenderer';
import { getMediaBlob, putMediaBlob } from '../../services/idb';
import { createId } from '../../services/storage';
import { MediaAsset } from '../../types/studio';

export const MediaLibraryView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceMedia,
    addMediaAsset,
    deleteMediaAsset,
    openPostComposerWithDraft,
    notify,
  } = useStudio();

  const [filter, setFilter] = useState<'all' | MediaAsset['mediaType']>('all');
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [previewAsset, setPreviewAsset] = useState<{ asset: MediaAsset; url: string } | null>(null);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];

    const load = async () => {
      const next: Record<string, string> = {};
      for (const asset of workspaceMedia.slice(0, 40)) {
        if (asset.mimeType.startsWith('image/') || asset.mediaType === 'carousel-slide') {
          const blob = await getMediaBlob(asset.blobKey);
          if (blob && active) {
            const url = URL.createObjectURL(blob);
            urls.push(url);
            next[asset.id] = url;
          }
        }
      }
      if (active) setThumbUrls(next);
    };

    load();
    return () => {
      active = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [workspaceMedia]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const blobKey = createId('lib-blob');
      await putMediaBlob(blobKey, file);
      const mediaType: MediaAsset['mediaType'] = file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'image';
      await addMediaAsset({
        id: createId('media'),
        workspaceId: activeWorkspace.id,
        name: file.name,
        mediaType,
        mimeType: file.type || 'application/octet-stream',
        blobKey,
        createdAt: new Date().toISOString(),
      });
    }
    notify('success', `${files.length} asset(s) uploaded to ${activeWorkspace.name} Media Library`);
  };

  const handlePreview = async (asset: MediaAsset) => {
    const blob = await getMediaBlob(asset.blobKey);
    if (!blob) {
      notify('error', 'Asset file missing from IndexedDB.');
      return;
    }
    setPreviewAsset({ asset, url: URL.createObjectURL(blob) });
  };

  const handleDownload = async (asset: MediaAsset) => {
    const blob = await getMediaBlob(asset.blobKey);
    if (!blob) {
      notify('error', 'Asset binary unavailable.');
      return;
    }
    triggerBlobDownload(blob, asset.name);
  };

  const filtered = workspaceMedia.filter((m) => filter === 'all' || m.mediaType === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Media Library</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Workspace Media Vault</h1>
        </div>

        <label className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold cursor-pointer">
          <Upload className="w-3.5 h-3.5" />
          <span>Upload Media</span>
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            onChange={handleUpload}
            className="hidden"
          />
        </label>
      </div>

      {/* Filter Tabs */}
      <div className="inline-flex flex-wrap p-1 rounded-lg bg-[#111114] border border-zinc-800 gap-1">
        {(
          [
            ['all', 'All Assets'],
            ['carousel-slide', 'Carousel Slides'],
            ['reel-export', 'Reels Exports'],
            ['image', 'Images'],
            ['video', 'Videos'],
            ['audio', 'Audio'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`px-3 py-1.5 rounded text-xs font-medium ${
              filter === id ? 'bg-zinc-100 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="p-12 rounded-xl bg-[#111114] border border-zinc-800 text-center space-y-2">
          <p className="text-sm text-zinc-300">No media stored in {activeWorkspace.name} for this filter.</p>
          <p className="text-xs text-zinc-500">
            Save exported carousels or Reels from the AI Creative Studio, or upload raw media above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((asset) => {
            const thumb = thumbUrls[asset.id];
            return (
              <div
                key={asset.id}
                className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden flex flex-col justify-between"
              >
                <div
                  onClick={() => handlePreview(asset)}
                  className="aspect-[4/3] bg-[#09090b] flex items-center justify-center cursor-pointer overflow-hidden border-b border-zinc-800/80"
                >
                  {thumb ? (
                    <img src={thumb} alt={asset.name} className="w-full h-full object-cover" />
                  ) : asset.mediaType === 'reel-export' || asset.mediaType === 'video' ? (
                    <Film className="w-8 h-8 text-zinc-600" />
                  ) : asset.mediaType === 'audio' ? (
                    <Music className="w-8 h-8 text-zinc-600" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-zinc-600" />
                  )}
                </div>

                <div className="p-3.5 space-y-2">
                  <div className="text-xs font-semibold text-zinc-100 truncate">{asset.name}</div>
                  <div className="text-[11px] text-zinc-400 font-mono tabular-nums">
                    {asset.dimensions || asset.mediaType}
                    {asset.slideNumber ? ` · Slide ${asset.slideNumber}` : ''}
                    {asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ''}
                  </div>
                  {asset.themeName && (
                    <div className="text-[11px] text-zinc-500 truncate">Theme: {asset.themeName}</div>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleDownload(asset)}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                        title="Download"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openPostComposerWithDraft({
                            title: asset.projectName || asset.name,
                            platform:
                              asset.mediaType === 'reel-export' || asset.mediaType === 'video'
                                ? 'instagram-reel'
                                : 'instagram-carousel',
                            caption: '',
                            hashtags: ['#BehindTheRelease'],
                            mediaAssetIds: [asset.id],
                          })
                        }
                        className="p-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white"
                        title="Use in Post Composer"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteMediaAsset(asset.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400"
                      title="Delete asset"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {previewAsset && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-100 truncate">
                {previewAsset.asset.name}
              </span>
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(previewAsset.url);
                  setPreviewAsset(null);
                }}
                className="text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 flex justify-center bg-[#09090b]">
              {previewAsset.asset.mimeType.startsWith('video/') ||
              previewAsset.asset.mediaType === 'reel-export' ? (
                <video src={previewAsset.url} controls className="max-h-[70vh] rounded" />
              ) : previewAsset.asset.mimeType.startsWith('audio/') ? (
                <audio src={previewAsset.url} controls className="w-full" />
              ) : (
                <img src={previewAsset.url} alt={previewAsset.asset.name} className="max-h-[70vh] rounded" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
