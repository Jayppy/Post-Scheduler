import type { AiProviderId } from './aiProviders';

export type VideoStyle = 'stickman' | 'cartoon-2d' | 'motion-graphics' | 'hybrid';

export type StickmanAction =
  | 'idle'
  | 'walking'
  | 'pointing'
  | 'thinking'
  | 'celebrating'
  | 'explaining'
  | 'typing'
  | 'presenting'
  | 'head-shake'
  | 'nodding'
  | 'holding-mic'
  | 'working-at-desk'
  | 'looking-at-phone'
  | 'showing-chart'
  | 'reacting-surprised'
  | 'crossed-arms'
  | 'thumbs-up'
  | 'waving';

export type StickmanHeadShape = 'circle' | 'rounded-square' | 'oval';

export type StickmanAccessory = 'cap' | 'headphones' | 'glasses' | 'chain' | 'hoodie';

export type StickmanExpression = 'neutral' | 'happy' | 'focused' | 'surprised' | 'skeptical';

export interface StickmanConfig {
  enabled: boolean;
  action: StickmanAction;
  bodyColor: string;
  outlineColor: string;
  headShape: StickmanHeadShape;
  headScale: number; // 0.85 to 1.35
  limbThickness: number; // 4 to 14
  expression: StickmanExpression;
  accessories: StickmanAccessory[];
  positionX: number; // 0 to 100 (% of width)
  positionY: number; // 0 to 100 (% of height)
  scale: number; // 0.6 to 1.6
  flipped?: boolean;
}

export type CartoonBackgroundPreset =
  | 'recording-studio'
  | 'vocal-booth'
  | 'desk-setup'
  | 'stage-spotlight'
  | 'mobile-analytics'
  | 'minimal-dark';

export type CartoonCharacterId = 'artist' | 'producer' | 'engineer' | 'creator' | 'none';

export type CartoonPropId =
  | 'condenser-mic'
  | 'studio-monitors'
  | 'laptop-daw'
  | 'vinyl-record'
  | 'waveform'
  | 'stream-counter'
  | 'phone-ui'
  | 'cash-stack';

export interface CartoonSceneConfig {
  enabled: boolean;
  backgroundPreset: CartoonBackgroundPreset;
  characterId: CartoonCharacterId;
  characterColor: string;
  accentColor: string;
  props: CartoonPropId[];
  customImageUrl?: string;
}

export type MotionChartType = 'none' | 'bar' | 'line' | 'timeline' | 'comparison' | 'flowchart';

export type SceneTransitionType = 'cut' | 'crossfade' | 'slide-up' | 'zoom-punch' | 'flash';

export interface MotionGraphicsConfig {
  headline: string;
  subheadline?: string;
  kicker?: string;
  highlightWords: string[];
  kpiValue?: string;
  kpiLabel?: string;
  chartType: MotionChartType;
  chartData?: Array<{ label: string; value: number }>;
  comparisonLeft?: { label: string; points: string[] };
  comparisonRight?: { label: string; points: string[] };
  timelineSteps?: Array<{ step: string; detail: string }>;
  calloutBadge?: string;
  transition: SceneTransitionType;
  accentColor: string;
  backgroundColor: string;
}

export interface VideoScene {
  id: string;
  orderIndex: number;
  title: string;
  durationSeconds: number;
  style: VideoStyle;
  narrationText: string;
  subtitleText: string;
  visualDirection: string;
  stickman: StickmanConfig;
  cartoon: CartoonSceneConfig;
  motion: MotionGraphicsConfig;
  customOverlayAssetUrl?: string;
  customOverlayOpacity?: number;
}

export interface VideoScript {
  id: string;
  hook: string;
  bodySummary: string;
  closingCta: string;
  fullNarration: string;
  estimatedDurationSeconds: number;
  targetDurationSeconds: number;
  educationalTakeaway: string;
  suggestedCaption: string;
  hashtags: string[];
  providerId?: AiProviderId | 'fallback';
  model?: string;
  wasFallback?: boolean;
}

export interface VideoAudioTrackConfig {
  narrationName?: string;
  narrationDataUrl?: string;
  narrationVolume: number; // 0 to 1
  bgmName?: string;
  bgmDataUrl?: string;
  bgmVolume: number; // 0 to 1
  sfxEnabled: boolean;
  sfxVolume: number; // 0 to 1
  fadeInSeconds: number;
  fadeOutSeconds: number;
  trimStartSeconds: number;
}

export interface VideoRenderRecord {
  id: string;
  projectId: string;
  status: 'idle' | 'rendering' | 'completed' | 'failed' | 'cancelled';
  format: 'mp4' | 'webm';
  resolution: '1080x1920' | '540x960';
  fps: number;
  durationSeconds: number;
  engine: 'remotion-web' | 'canvas-ffmpeg-fallback';
  storagePath?: string;
  storageBucket?: string;
  progress: number;
  lastCheckpointFrame?: number;
  error?: string;
  createdAt: string;
}

export type VideoWorkflowStage = 'script' | 'storyboard' | 'assets' | 'preview' | 'export';

export interface VideoProject {
  id: string;
  workspaceId: 'ws-behind-the-release';
  title: string;
  topic: string;
  audience: string;
  destination: 'instagram-reels' | 'youtube-shorts' | 'both';
  primaryStyle: VideoStyle;
  targetDurationSeconds: number; // 60 - 90
  workflowStage: VideoWorkflowStage;
  approvedForRender: boolean;
  status: 'draft' | 'script-ready' | 'approved' | 'rendered';
  script: VideoScript;
  scenes: VideoScene[];
  audio: VideoAudioTrackConfig;
  captionStyle: {
    position: 'bottom' | 'center' | 'top';
    highlightColor: string;
    fontSize: number;
    showProgressBar: boolean;
    showBrandWatermark: boolean;
  };
  renders: VideoRenderRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface VideoGenerationProviderStatus {
  id: 'remotion-local' | 'huggingface' | 'replicate';
  label: string;
  kind: 'built-in-renderer' | 'optional-video-adapter';
  enabled: boolean;
  configured: boolean;
  freeTier: boolean;
  requiresPaidBilling: false;
  note: string;
}
