import { MediaAsset, SocialPlatform } from '../types/studio';
import { blobToBase64, getMediaBlob } from './idb';

export interface EncodedMediaPayload {
  filename: string;
  mimeType: string;
  base64Data: string;
}

export function validateMediaForPlatform(
  platform: SocialPlatform,
  assets: MediaAsset[]
): string | null {
  if (assets.length === 0) {
    return 'Attach at least one image or exported video from the Media Library.';
  }

  const hasVideo = assets.some(
    (a) => a.mimeType.startsWith('video/') || a.mediaType === 'reel-export' || a.mediaType === 'video'
  );

  if (platform === 'youtube-shorts') {
    if (!hasVideo) {
      return 'YouTube Shorts requires a rendered MP4 video asset.';
    }
    const videoAsset = assets.find(
      (a) => a.mimeType.startsWith('video/') || a.mediaType === 'reel-export'
    );
    if (videoAsset?.mimeType.includes('webm')) {
      return 'YouTube Shorts publishing requires a standard H.264 MP4 file rather than WebM. Re-export in Reels Studio.';
    }
  }

  if (platform === 'instagram-reel') {
    if (!hasVideo) {
      return 'Instagram Reels requires a rendered MP4 video asset.';
    }
    const videoAsset = assets.find(
      (a) => a.mimeType.startsWith('video/') || a.mediaType === 'reel-export'
    );
    if (videoAsset?.mimeType.includes('webm')) {
      return 'Instagram Reels requires an H.264/AAC MP4 file (WebM is rejected by Instagram). Re-export in Reels Studio.';
    }
  }

  if (platform === 'instagram-carousel' && assets.length > 10) {
    return 'Instagram Carousels support a maximum of 10 media slides.';
  }

  return null;
}

export async function prepareMediaItemsForPublish(
  assetIds: string[],
  workspaceMedia: MediaAsset[],
  platform: SocialPlatform
): Promise<EncodedMediaPayload[]> {
  const assets = assetIds
    .map((id) => workspaceMedia.find((m) => m.id === id))
    .filter((m): m is MediaAsset => Boolean(m));

  const validationError = validateMediaForPlatform(platform, assets);
  if (validationError) {
    throw new Error(validationError);
  }

  const items: EncodedMediaPayload[] = [];
  for (const asset of assets) {
    const blob = await getMediaBlob(asset.blobKey);
    if (!blob) {
      throw new Error(`Media file "${asset.name}" is missing from browser IndexedDB.`);
    }
    const base64Data = await blobToBase64(blob);
    items.push({
      filename: asset.name,
      mimeType: blob.type || asset.mimeType || 'application/octet-stream',
      base64Data,
    });
  }

  return items;
}
