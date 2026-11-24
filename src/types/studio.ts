export type MainNavSection =
  | 'hub-overview'
  | 'creative-studio'
  | 'ai-assistant'
  | 'media-library'
  | 'post-composer'
  | 'content-calendar'
  | 'publishing-queue'
  | 'campaign-manager'
  | 'connected-accounts';

export type CreativeStudioSubView =
  | 'overview'
  | 'carousel-creator'
  | 'carousel-editor'
  | 'reels-studio'
  | 'design-themes'
  | 'creative-projects'
  | 'export-history';

export type SlideAspectRatio = '1080x1350' | '1080x1080' | '1080x1920';

export type SlideLayoutVariant =
  | 'hero-center'
  | 'editorial-split'
  | 'stat-focus'
  | 'quote-card'
  | 'minimal-list'
  | 'cta-end';

export interface Workspace {
  id: string;
  name: string;
  tagline: string;
  aestheticStyle: string;
  brandVoice: string;
  logoDataUrl?: string;
  watermarkText: string;
  watermarkEnabled: boolean;
  defaultThemeId: string;
  defaultOutroText: string;
  palette: {
    background: string;
    surface: string;
    accent: string;
    text: string;
  };
  typography: {
    displayFont: string;
    bodyFont: string;
  };
  createdAt: string;
}

export interface DesignTheme {
  id: string;
  workspaceId: 'global' | string;
  name: string;
  category: string;
  description: string;
  isCustom: boolean;
  colors: {
    background: string;
    surface: string;
    accent: string;
    primaryText: string;
    mutedText: string;
  };
  typography: {
    headingFont: 'Plus Jakarta Sans' | 'Cormorant Garamond' | 'Oswald' | 'Manrope';
    bodyFont: 'Manrope' | 'Plus Jakarta Sans' | 'Cormorant Garamond' | 'JetBrains Mono';
    headingSize: number; // base scale multiplier e.g. 56
    bodySize: number; // e.g. 28
    alignment: 'left' | 'center' | 'right';
  };
  layout: {
    imagePlacement: 'background-scrim' | 'top-band' | 'bottom-band' | 'split-right' | 'none';
    logoPlacement: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none';
    showSlideNumbers: boolean;
    decorativeStyle: 'hairline-frame' | 'editorial-rule' | 'grid-ticks' | 'geometric-corner' | 'minimal';
    grainOpacity: number;
    scrimOpacity: number;
    backgroundImageUrl?: string;
  };
}

export interface CarouselSlide {
  id: string;
  role: string;
  kicker: string;
  headline: string;
  body: string;
  highlight: string;
  layoutVariant: SlideLayoutVariant;
  imageUrl?: string;
  imageBlobKey?: string;
  customBgColor?: string;
  customAccentColor?: string;
  textAlignOverride?: 'left' | 'center' | 'right';
}

export interface CarouselState {
  mode: 'content-first' | 'topic-first' | 'manual';
  aspectRatio: SlideAspectRatio;
  slides: CarouselSlide[];
  selectedSlideId: string;
  rawContentInput?: string;
  uploadedDocName?: string;
  designInstructions?: string;
  topicConfig?: {
    topic: string;
    audience: string;
    objective: string;
    tone: string;
    slideCount: number;
    cta: string;
    keywords: string;
    referenceMaterial: string;
  };
  suggestedCaption?: string;
  suggestedHashtags?: string[];
  brandLogoUrl?: string;
}

export type ReelCreationMode =
  | 'music-promotion'
  | 'educational-reels'
  | 'talking-head'
  | 'cinematic-promotional'
  | 'typography-driven';

export interface EditingPreset {
  id: string;
  name: string;
  description: string;
  colorTreatment: 'obsidian-silver' | 'warm-analog' | 'high-contrast-mono' | 'cinematic-teal' | 'clean-editorial';
  fontFamily: 'Plus Jakarta Sans' | 'Cormorant Garamond' | 'Oswald' | 'Manrope';
  transitionStyle: 'cut' | 'crossfade' | 'slide-up' | 'zoom-punch' | 'flash-silver';
  motionStyle: 'kinetic-pop' | 'editorial-reveal' | 'lower-third' | 'minimal-fade' | 'type-writer';
  pacingSeconds: number;
}

export interface ReelAssetRef {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio' | 'voice';
  mimeType: string;
  blobKey: string;
  sizeBytes: number;
  duration?: number;
  width?: number;
  height?: number;
  description?: string;
}

export interface StoryboardScene {
  id: string;
  sceneNumber: number;
  recommendedAssetId: string;
  recommendedAssetName: string;
  durationSeconds: number;
  sceneDescription: string;
  textOverlay: string;
  lowerThird: string;
  subtitleLine: string;
  transitionStyle: EditingPreset['transitionStyle'];
  motionPreset: EditingPreset['motionStyle'];
  visualEmphasis: string;
}

export interface TimelineClip {
  id: string;
  assetId: string;
  assetName: string;
  kind: 'video' | 'image' | 'typography-card';
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  transition: EditingPreset['transitionStyle'];
  cropX: number; // -50 to 50 %
  cropY: number; // -50 to 50 %
  zoom: number; // 1 to 1.6
  textOverlay: string;
  lowerThird: string;
  motionStyle: EditingPreset['motionStyle'];
  bgColor?: string;
}

export interface SubtitleSegment {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  highlightWord: string;
}

export interface SubtitleSettings {
  fontFamily: 'Plus Jakarta Sans' | 'Oswald' | 'Cormorant Garamond' | 'Manrope';
  fontSize: number;
  position: 'bottom' | 'center' | 'top';
  animationPreset: 'word-highlight' | 'fade-up' | 'bold-box' | 'minimal-clean';
  highlightColor: string;
}

export interface ReelState {
  step: 1 | 2 | 3 | 4; // 1: Inputs & Assets, 2: Storyboard & AI Plan, 3: Timeline Editor, 4: Export
  creationMode: ReelCreationMode;
  presetId: string;
  topic: string;
  script: string;
  transcript: string;
  targetDuration: number;
  assets: ReelAssetRef[];
  storyboardApproved: boolean;
  storyboard: StoryboardScene[];
  editingNotes: string;
  hookLine: string;
  closingCta: string;
  timelineClips: TimelineClip[];
  audioTrackAssetId?: string;
  voiceTrackAssetId?: string;
  musicVolume: number; // 0 to 1
  voiceVolume: number; // 0 to 1
  audioFadeIn: number; // seconds
  audioFadeOut: number; // seconds
  subtitles: SubtitleSegment[];
  subtitleSettings: SubtitleSettings;
  showProgressBar: boolean;
  showBrandLogo: boolean;
  introTemplate: 'none' | 'minimal-title' | 'studio-slate';
  outroTemplate: 'none' | 'brand-cta' | 'follow-endcard';
  colorTreatment: EditingPreset['colorTreatment'];
  destinationProfile: 'instagram-reels' | 'youtube-shorts';
  suggestedCaption?: string;
}

export interface CreativeProject {
  id: string;
  workspaceId: string;
  title: string;
  type: 'carousel' | 'reel';
  themeId: string;
  status: 'draft' | 'storyboard-ready' | 'edited' | 'exported';
  carouselState?: CarouselState;
  reelState?: ReelState;
  createdAt: string;
  updatedAt: string;
}

export interface MediaAsset {
  id: string;
  workspaceId: string;
  name: string;
  mediaType: 'carousel-slide' | 'reel-export' | 'image' | 'video' | 'audio';
  mimeType: string;
  blobKey: string;
  dimensions?: string;
  duration?: number;
  fps?: number;
  projectName?: string;
  themeName?: string;
  slideNumber?: number;
  sourceExportHash?: string;
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  exportType: 'carousel-png' | 'carousel-zip' | 'reel-mp4';
  themeName: string;
  format: string;
  dimensions: string;
  slideCount?: number;
  duration?: number;
  fps?: number;
  destinationProfile?: string;
  blobKeys: string[];
  exportHash: string;
  savedToMediaLibrary: boolean;
  createdAt: string;
}

export type SocialPlatform = 'instagram-carousel' | 'instagram-reel' | 'youtube-shorts' | 'instagram-feed';

export type PublishingLifecycleStatus =
  | 'draft'
  | 'scheduled'
  | 'ready-to-send'
  | 'publishing'
  | 'published'
  | 'partially-published'
  | 'failed'
  | 'cancelled';

export type YouTubePrivacyStatus = 'public' | 'unlisted' | 'private';

export interface DestinationPublishState {
  platform: 'instagram' | 'youtube';
  format: SocialPlatform;
  status: 'scheduled' | 'ready-to-send' | 'publishing' | 'published' | 'failed' | 'cancelled';
  attempts: number;
  publishedAt?: string;
  platformPostId?: string;
  resultUrl?: string;
  error?: string;
  inFlightId?: string;
  needsReconciliation?: boolean;
  youtubeTitle?: string;
  youtubeDescription?: string;
  youtubeTags?: string[];
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  instagramCaption?: string;
}

export interface SocialPost {
  id: string;
  workspaceId: string;
  title: string;
  platform: SocialPlatform;
  platforms?: Array<'instagram' | 'youtube'>;
  caption: string;
  hashtags: string[];
  mediaAssetIds: string[];
  status: 'draft' | 'queued' | 'scheduled' | 'ready-to-send' | 'publishing' | 'published' | 'partially-published' | 'failed' | 'cancelled';
  scheduledDate?: string; // YYYY-MM-DD in selected timezone
  scheduledTime?: string; // HH:mm in selected timezone
  timezone?: string; // Default: Africa/Lagos
  scheduledIso?: string; // Canonical UTC ISO-8601
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  backendJobId?: string;
  backendStatus?: PublishingLifecycleStatus | 'pending';
  publishResultUrl?: string;
  publishError?: string;
  campaignId?: string;
  sourceProjectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  workspaceId: string;
  name: string;
  objective: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'planning' | 'completed';
  linkedProjectIds: string[];
}
