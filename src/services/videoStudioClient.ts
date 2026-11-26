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

  async uploadRenderedVideoWithProgress(
    projectId: string,
    renderId: string,
    videoBlob: Blob,
    mimeType: string,
    onProgress?: (pct: number, label: string) => void,
    signal?: AbortSignal
  ): Promise<{ storagePath: string; storageBucket: string }> {
    const chunkSize = 2 * 1024 * 1024; // 2MB chunks
    const totalSize = videoBlob.size;
    const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSize));

    onProgress?.(2, 'Initializing chunked cloud upload…');
    const initHeaders = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const initRes = await fetch(`/api/video-studio/upload-render/init`, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify({ projectId, renderId, totalSize, totalChunks, mimeType }),
      signal,
    });
    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.uploadId) {
      throw new Error(initData.error || 'Failed to initialize cloud video upload.');
    }

    const uploadId = initData.uploadId;
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (signal?.aborted) throw new Error('Upload cancelled by user.');
      const start = chunkIdx * chunkSize;
      const end = Math.min(totalSize, start + chunkSize);
      const chunkBlob = videoBlob.slice(start, end);

      let success = false;
      let lastErr = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const chunkHeaders = await getOperatorAuthHeaders({
            'Content-Type': mimeType || 'video/mp4',
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(chunkIdx),
          });
          const chunkRes = await fetch(`/api/video-studio/upload-render/chunk`, {
            method: 'POST',
            headers: chunkHeaders,
            body: chunkBlob,
            signal,
          });
          if (chunkRes.ok) {
            success = true;
            break;
          }
          const errData = await chunkRes.json().catch(() => ({}));
          lastErr = errData.error || `HTTP ${chunkRes.status}`;
        } catch (e) {
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
    const compHeaders = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
    const compRes = await fetch(`/api/video-studio/upload-render/complete`, {
      method: 'POST',
      headers: compHeaders,
      body: JSON.stringify({ uploadId, projectId, renderId }),
      signal,
    });
    const compData = await compRes.json().catch(() => ({}));
    if (!compRes.ok || !compData.storagePath) {
      throw new Error(compData.error || 'Failed to finalize cloud video storage.');
    }

    onProgress?.(100, 'Cloud backup complete');
    return {
      storagePath: compData.storagePath,
      storageBucket: compData.storageBucket || 'video-studio',
    };
  },
};

