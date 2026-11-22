import { SlideLayoutVariant } from '../types/studio';

export interface GeneratedSlidePayload {
  role: string;
  kicker?: string;
  headline: string;
  body: string;
  highlight?: string;
  layoutVariant: SlideLayoutVariant;
  visualNote?: string;
}

export interface CarouselAiResponse {
  projectTitle: string;
  suggestedCaption?: string;
  hashtags?: string[];
  slides: GeneratedSlidePayload[];
}

export interface ReelsPlanScenePayload {
  sceneNumber: number;
  recommendedAssetId: string;
  recommendedAssetName?: string;
  durationSeconds: number;
  sceneDescription: string;
  textOverlay: string;
  lowerThird?: string;
  subtitleLine?: string;
  transitionStyle: 'cut' | 'crossfade' | 'slide-up' | 'zoom-punch' | 'flash-silver';
  motionPreset?: 'kinetic-pop' | 'editorial-reveal' | 'lower-third' | 'minimal-fade' | 'type-writer';
  visualEmphasis?: string;
}

export interface ReelsPlanAiResponse {
  projectTitle: string;
  hookLine: string;
  fullScript: string;
  musicDirection?: string;
  closingCta: string;
  editingNotes?: string;
  suggestedCaption?: string;
  scenes: ReelsPlanScenePayload[];
}

export class AiApiError extends Error {
  code: string;
  quotaExceeded: boolean;
  status: number;

  constructor(message: string, code: string, quotaExceeded: boolean, status: number) {
    super(message);
    this.name = 'AiApiError';
    this.code = code;
    this.quotaExceeded = quotaExceeded;
    this.status = status;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AiApiError(
      data.error || `Request failed with status ${res.status}`,
      data.code || 'AI_ERROR',
      Boolean(data.quotaExceeded || res.status === 429),
      res.status
    );
  }
  return data as T;
}

export const aiClient = {
  structureContentCarousel(payload: {
    content: string;
    slideCount: number;
    designInstructions?: string;
    workspaceName: string;
    brandVoice: string;
  }) {
    return postJson<CarouselAiResponse>('/api/ai/carousel-structure', payload);
  },

  generateTopicCarousel(payload: {
    topic: string;
    audience: string;
    objective: string;
    tone: string;
    slideCount: number;
    cta: string;
    keywords?: string;
    referenceMaterial?: string;
    workspaceName: string;
    brandVoice: string;
  }) {
    return postJson<CarouselAiResponse>('/api/ai/carousel-topic', payload);
  },

  regenerateSingleSlide(payload: {
    slide: {
      kicker?: string;
      headline: string;
      body: string;
      highlight?: string;
      layoutVariant?: string;
    };
    instruction?: string;
    workspaceName: string;
    themeName: string;
  }) {
    return postJson<GeneratedSlidePayload>('/api/ai/carousel-slide-regen', payload);
  },

  generateReelsPlan(payload: {
    topic: string;
    existingScript?: string;
    transcript?: string;
    creationMode: string;
    editingPresetName: string;
    targetDuration: number;
    assets: Array<{
      id: string;
      name: string;
      kind: string;
      duration?: number;
      description?: string;
    }>;
    workspaceName: string;
    brandVoice: string;
  }) {
    return postJson<ReelsPlanAiResponse>('/api/ai/reels-plan', payload);
  },

  generateSocialCopy(payload: {
    prompt: string;
    format: string;
    platform: string;
    workspaceName: string;
    brandVoice: string;
  }) {
    return postJson<{
      headline: string;
      caption: string;
      hooks: string[];
      hashtags: string[];
      cta?: string;
    }>('/api/ai/social-copy', payload);
  },

  transcribeAudio(payload: { base64Audio: string; mimeType: string }) {
    return postJson<{ transcript: string }>('/api/ai/transcribe-audio', payload);
  },
};
