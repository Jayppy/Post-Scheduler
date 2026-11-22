import React, { useState } from 'react';
import { Download, Eye, FolderPlus, Send, X } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { packagePngSlidesToZip, triggerBlobDownload } from '../../services/carouselRenderer';
import { getMediaBlob } from '../../services/idb';
import { ExportRecord } from '../../types/studio';

export const ExportHistoryView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceExports,
    saveExportToMediaLibrary,
    openPostComposerWithDraft,
    notify,
  } = useStudio();

  const [previewUrls, setPreviewUrls] = useState<Array<{ url: string; type: 'image' | 'video' }>>([]);
  const [previewTitle, setPreviewTitle] = useState('');

  const handleDownloadExport = async (record: ExportRecord) => {
    try {
      const blobs: Array<{ filename: string; blob: Blob }> = [];
      for (let i = 0; i < record.blobKeys.length; i++) {
        const blob = await getMediaBlob(record.blobKeys[i]);
        if (blob) {
          const ext = record.exportType === 'reel-mp4' ? (blob.type.includes('mp4') ? 'mp4' : 'webm') : 'png';
          blobs.push({
            filename:
              record.exportType === 'reel-mp4'
                ? `${record.projectName}.${ext}`
                : `${String(i + 1).padStart(2, '0')}_slide.png`,
            blob,
          });
        }
      }

      if (blobs.length === 0) {
        notify('error', 'Export files no longer found in IndexedDB.');
        return;
      }

      if (record.exportType === 'carousel-zip') {
        const zip = await packagePngSlidesToZip(blobs);
        triggerBlobDownload(zip, `${record.projectName}_carousel.zip`);
      } else {
        for (const item of blobs) {
          triggerBlobDownload(item.blob, item.filename);
        }
      }
      notify('success', 'Export downloaded');
    } catch {
      notify('error', 'Download failed');
    }
  };

  const handlePreview = async (record: ExportRecord) => {
    const items: Array<{ url: string; type: 'image' | 'video' }> = [];
    for (const key of record.blobKeys) {
      const blob = await getMediaBlob(key);
      if (blob) {
        items.push({
          url: URL.createObjectURL(blob),
          type: record.exportType === 'reel-mp4' ? 'video' : 'image',
        });
      }
    }
    if (items.length === 0) {
      notify('warning', 'Preview unavailable — blob missing from local storage.');
      return;
    }
    setPreviewTitle(record.projectName);
    setPreviewUrls(items);
  };

  const closePreview = () => {
    previewUrls.forEach((p) => URL.revokeObjectURL(p.url));
    setPreviewUrls([]);
  };

  const handleSaveToMedia = async (record: ExportRecord) => {
    try {
      const blobs: Array<{ filename: string; blob: Blob; slideNumber?: number }> = [];
      for (let i = 0; i < record.blobKeys.length; i++) {
        const blob = await getMediaBlob(record.blobKeys[i]);
        if (blob) {
          blobs.push({
            filename:
              record.exportType === 'reel-mp4'
                ? `${record.projectName}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`
                : `${String(i + 1).padStart(2, '0')}_slide.png`,
            blob,
            slideNumber: i + 1,
          });
        }
      }
      const res = await saveExportToMediaLibrary(record, blobs, activeWorkspace.id, false);
      if (res.skippedDuplicate) {
        notify('info', 'Already stored in Media Library');
      } else {
        notify('success', 'Saved to Media Library', `${res.savedAssets.length} file(s) stored.`);
      }
    } catch (err) {
      notify('error', 'Save failed', err instanceof Error ? err.message : '');
    }
  };

  const handleComposeFromExport = async (record: ExportRecord) => {
    const blobs: Array<{ filename: string; blob: Blob; slideNumber?: number }> = [];
    for (let i = 0; i < record.blobKeys.length; i++) {
      const blob = await getMediaBlob(record.blobKeys[i]);
      if (blob) {
        blobs.push({
          filename:
            record.exportType === 'reel-mp4'
              ? `${record.projectName}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`
              : `${String(i + 1).padStart(2, '0')}_slide.png`,
          blob,
          slideNumber: i + 1,
        });
      }
    }
    const { savedAssets } = await saveExportToMediaLibrary(record, blobs, activeWorkspace.id, false);
    openPostComposerWithDraft({
      title: record.projectName,
      platform:
        record.exportType === 'reel-mp4'
          ? record.destinationProfile === 'youtube-shorts'
            ? 'youtube-shorts'
            : 'instagram-reel'
          : 'instagram-carousel',
      caption: `${record.projectName} — produced in ${activeWorkspace.name}.`,
      hashtags: ['#74Studio'],
      mediaAssetIds: savedAssets.map((a) => a.id),
      sourceProjectId: record.projectId,
    });
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800/80 pb-5">
        <div className="text-xs text-zinc-400 mb-1">
          <span>{activeWorkspace.name}</span>
          <span className="mx-2 text-zinc-600">·</span>
          <span>Export History</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Production Export Log</h1>
      </div>

      {workspaceExports.length === 0 ? (
        <div className="p-12 rounded-xl bg-[#111114] border border-zinc-800 text-center">
          <p className="text-sm text-zinc-300">No exports recorded in {activeWorkspace.name} yet.</p>
          <p className="text-xs text-zinc-500 mt-1">
            Exported PNG slides, ZIP archives, and rendered Reels/Shorts MP4s appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800 text-[11px] font-medium text-zinc-400">
                <th className="py-3 px-4">Project</th>
                <th className="py-3 px-4">Format</th>
                <th className="py-3 px-4">Specs</th>
                <th className="py-3 px-4">Theme / Profile</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {workspaceExports.map((rec) => (
                <tr key={rec.id} className="hover:bg-zinc-900/40">
                  <td className="py-3 px-4 font-semibold text-zinc-100">{rec.projectName}</td>
                  <td className="py-3 px-4 font-mono text-zinc-300">{rec.format}</td>
                  <td className="py-3 px-4 font-mono tabular-nums text-zinc-400">
                    {rec.dimensions}
                    {rec.slideCount ? ` · ${rec.slideCount} slides` : ''}
                    {rec.duration ? ` · ${rec.duration.toFixed(1)}s @ ${rec.fps || 30}fps` : ''}
                  </td>
                  <td className="py-3 px-4 text-zinc-400">
                    {rec.themeName}
                    {rec.destinationProfile ? ` · ${rec.destinationProfile}` : ''}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-zinc-400">
                    {new Date(rec.createdAt).toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePreview(rec)}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                        title="Preview"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownloadExport(rec)}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                        title="Download"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveToMedia(rec)}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                        title="Save to Media Library"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleComposeFromExport(rec)}
                        className="p-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white"
                        title="Open in Post Composer"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewUrls.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-zinc-100">{previewTitle}</span>
              <button type="button" onClick={closePreview} className="text-zinc-400 hover:text-zinc-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-auto flex gap-4 justify-center flex-wrap">
              {previewUrls.map((item, i) =>
                item.type === 'video' ? (
                  <video
                    key={i}
                    src={item.url}
                    controls
                    className="max-h-[70vh] rounded-lg border border-zinc-800"
                  />
                ) : (
                  <img
                    key={i}
                    src={item.url}
                    alt={`Export ${i + 1}`}
                    className="w-[240px] rounded-lg border border-zinc-800"
                  />
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
