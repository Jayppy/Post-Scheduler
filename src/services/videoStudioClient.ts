import type {
  VideoGenerationProviderStatus,
  VideoProject,
  VideoRenderRecord,
  VideoScene,
  VideoStyle,
} from '../types/videoStudio';
import { getOperatorAuthHeaders } from './authHeaders';

export const videoStudioClient = {
  async listProviders(): Promise<VideoGenerationProviderStatus[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/video-studio/providers', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load video providers.');
    return data.providers || [];
  },

  async listProjects(): Promise<VideoProject[]> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch('/api/video-studio/projects', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load video projects.');
    return data.projects || [];
  },

  async createOrSaveProject(project: VideoProject): Promise<VideoProject> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/video-studio/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ project }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.project) throw new Error(data.error || 'Failed to save video project.');
    return data.project;
  },

  async updateProject(id: string, patch: Partial<VideoProject>): Promise<VideoProject> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(`/api/video-studio/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.project) throw new Error(data.error || 'Failed to update video project.');
    return data.project;
  },

  async deleteProject(id: string): Promise<void> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(`/api/video-studio/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error('Failed to delete video project.');
  },

  async generateScript(payload: {
    topic: string;
    audience?: string;
    style: VideoStyle;
    targetDurationSeconds: number;
    destination: VideoProject['destination'];
    notes?: string;
  }): Promise<{ project: VideoProject; usedFallbackTemplate?: boolean }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/video-studio/generate-script', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.project) throw new Error(data.error || 'Failed to generate video script.');
    return data;
  },

  async regenerateScene(payload: {
    topic: string;
    scene: VideoScene;
    instruction?: string;
  }): Promise<{ scene: VideoScene; usedFallbackTemplate?: boolean }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch('/api/video-studio/regenerate-scene', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.scene) throw new Error(data.error || 'Failed to regenerate scene.');
    return data;
  },

  async saveRenderCheckpoint(
    projectId: string,
    payload: { render: VideoRenderRecord; base64Video?: string; mimeType?: string }
  ): Promise<{ render: VideoRenderRecord; project: VideoProject }> {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const res = await fetch(
      `/api/video-studio/projects/${encodeURIComponent(projectId)}/render-checkpoint`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.render) throw new Error(data.error || 'Failed to save render checkpoint.');
    return data;
  },

  async computeSha256Hex(blob: Blob): Promise<string | undefined> {
    try {
      if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
        return undefined;
      }
      const buf = await blob.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return undefined;
    }
  },

  async uploadRenderedVideoWithProgress(
    projectId: string,
    renderId: string,
    videoBlob: Blob,
    mimeType: string,
    onProgress?: (pct: number, label: string) => void,
    signal?: AbortSignal
  ): Promise<{ storagePath: string; storageBucket: string; signedUrl?: string }> {
    const chunkSize = 2 * 1024 * 1024; // 2MB chunks (within 5MB per-chunk server limit)
    const totalBytes = videoBlob.size;
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    const format: 'mp4' | 'webm' = mimeType.toLowerCase().includes('webm') ? 'webm' : 'mp4';

    onProgress?.(2, 'Computing integrity digest & initializing cloud upload…');
    const expectedSha256 = await this.computeSha256Hex(videoBlob);
    const initHeaders = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const initRes = await fetch(
      `/api/video-studio/projects/${encodeURIComponent(projectId)}/upload-render/init`,
      {
        method: 'POST',
        headers: initHeaders,
        body: JSON.stringify({
          renderId,
          format,
          mimeType,
          totalBytes,
          totalChunks,
          ...(expectedSha256 ? { expectedSha256 } : {}),
        }),
        signal,
      }
    );
    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.uploadId) {
      throw new Error(initData.error || 'Failed to initialize cloud video upload.');
    }

    const uploadId = initData.uploadId;
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (signal?.aborted) throw new Error('Upload cancelled by user.');
      const start = chunkIdx * chunkSize;
      const end = Math.min(totalBytes, start + chunkSize);
      const chunkBlob = videoBlob.slice(start, end);
      const chunkSha256 = await this.computeSha256Hex(chunkBlob);

      let success = false;
      let lastErr = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const extraHeaders: Record<string, string> = {
            'Content-Type': mimeType || 'application/octet-stream',
          };
          if (chunkSha256) {
            extraHeaders['X-Chunk-Sha256'] = chunkSha256;
          }
          const chunkHeaders = await getOperatorAuthHeaders(extraHeaders);
          const chunkRes = await fetch(
            `/api/video-studio/projects/${encodeURIComponent(projectId)}/upload-render/${encodeURIComponent(uploadId)}/chunk?index=${chunkIdx}`,
            {
              method: 'PUT',
              headers: chunkHeaders,
              body: chunkBlob,
              signal,
            }
          );
          if (chunkRes.ok) {
            success = true;
            break;
          }
          const errData = await chunkRes.json().catch(() => ({}));
          lastErr = errData.error || `HTTP ${chunkRes.status}`;
          if (
            chunkRes.status === 400 ||
            chunkRes.status === 401 ||
            chunkRes.status === 403 ||
            chunkRes.status === 409 ||
            chunkRes.status === 413
          ) {
            break;
          }
        } catch (e) {
          if (signal?.aborted) throw new Error('Upload cancelled by user.');
          lastErr = e instanceof Error ? e.message : 'Network error';
        }
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }

      if (!success) {
        throw new Error(`Failed to upload chunk ${chunkIdx + 1}/${totalChunks}: ${lastErr}`);
      }

      const pct = Math.round(5 + ((chunkIdx + 1) / totalChunks) * 85);
      onProgress?.(pct, `Uploading chunk ${chunkIdx + 1} of ${totalChunks}…`);
    }

    onProgress?.(95, 'Finalizing cloud storage record…');
    let compData: Record<string, unknown> = {};
    let compOk = false;
    let lastCompErr = 'Failed to finalize cloud video storage.';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal?.aborted) throw new Error('Upload cancelled by user.');
      try {
        const compHeaders = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
        const compRes = await fetch(
          `/api/video-studio/projects/${encodeURIComponent(projectId)}/upload-render/${encodeURIComponent(uploadId)}/complete`,
          {
            method: 'POST',
            headers: compHeaders,
            body: JSON.stringify({}),
            signal,
          }
        );
        compData = (await compRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (compRes.ok && compData.uploaded && compData.storagePath) {
          compOk = true;
          break;
        }
        lastCompErr = String(compData.error || `HTTP ${compRes.status}`);
        const retryableStatus =
          compRes.status === 502 ||
          compRes.status === 503 ||
          (compRes.status === 409 && compData.code === 'UPLOAD_COMPLETING');
        if (!retryableStatus || attempt >= 3) {
          break;
        }
      } catch (e) {
        if (signal?.aborted) throw new Error('Upload cancelled by user.');
        lastCompErr = e instanceof Error ? e.message : 'Network error';
        if (attempt >= 3) break;
      }
      await new Promise((r) => setTimeout(r, attempt * 1200));
    }

    if (!compOk) {
      throw new Error(lastCompErr);
    }

    onProgress?.(100, 'Cloud backup complete');
    return {
      storagePath: String(compData.storagePath),
      storageBucket: String(compData.storageBucket || 'video-studio'),
      signedUrl: typeof compData.signedUrl === 'string' ? compData.signedUrl : undefined,
    };
  },

  async getRenderSignedUrl(
    projectId: string,
    renderId: string
  ): Promise<{ storagePath: string; storageBucket: string; signedUrl: string }> {
    const headers = await getOperatorAuthHeaders();
    const res = await fetch(
      `/api/video-studio/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(renderId)}/url`,
      { headers }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.signedUrl) {
      throw new Error(data.error || 'Failed to retrieve render download URL.');
    }
    return data;
  },
};

