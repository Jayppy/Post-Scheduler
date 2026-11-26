import type { AiProviderId, LongFormDocumentManifest } from './aiProviders';

export type SalesLeadSegment =
  | 'Independent recording artist'
  | 'Established recording artist'
  | 'Music producer'
  | 'Beatmaker'
  | 'Songwriter'
  | 'Record label'
  | 'Music manager'
  | 'Music business';

export type BuyerIntentLevel = 'high' | 'medium' | 'low' | 'exploratory';

export type SalesPipelineStage =
  | 'new-lead'
  | 'researched'
  | 'qualified'
  | 'proposal-sent'
  | 'follow-up'
  | 'won'
  | 'archived';

export interface SalesServiceTier {
  id: string;
  tierName: string;
  priceLabel: string;
  durationOrScope: string;
}

export interface SalesServiceOffer {
  id: string;
  name: string;
  summary: string;
  deliverables: string[];
  idealFor: string[];
  differentiator: string;
  tiers?: SalesServiceTier[];
  verifiedFromWebsite: boolean;
}

export interface SalesKbCustomEntry {
  id: string;
  title: string;
  category: 'pricing' | 'service' | 'faq' | 'objection' | 'policy';
  content: string;
  updatedAt: string;
}

export interface SalesKnowledgeBase {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  businessName: string;
  websiteUrl: string;
  contactPageUrl: string;
  brandVoice: string;
  positioning: string;
  pricingPolicy: string;
  contactSummary: string;
  knownUrls: Array<{ label: string; url: string }>;
  services: SalesServiceOffer[];
  customEntries?: SalesKbCustomEntry[];
  qualificationCriteria: string;
  approvedMessagingNotes: string;
  noFabricationGuard: string;
  updatedAt: string;
}

export interface SalesStudioSettings {
  promoEnabled: boolean;
  promoPercentage: number;
  promoLabel: string;
  promoScope: string;
  enforceLowercase: boolean;
  defaultLengthGuidance: string;
  extraToneNotes: string;
  updatedAt: string;
}

export interface SalesChatMessage {
  id: string;
  conversationId: string;
  role: 'artist' | 'assistant';
  content: string;
  artistNote?: string;
  attachmentName?: string;
  attachmentPreviewUrl?: string;
  providerId?: AiProviderId | 'fallback';
  model?: string;
  wasFallback?: boolean;
  edited?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SalesConversation {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  title: string;
  artistName?: string;
  lastMessagePreview: string;
  messages: SalesChatMessage[];
  pinned?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

// Legacy CRM types retained solely for archived backend records & Supabase migration
export interface SalesLeadRecord {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  name: string;
  handleOrOrg: string;
  contactChannel: string;
  segment: SalesLeadSegment;
  channelSource: string;
  releaseOrProjectContext: string;
  rawInquiryNotes: string;
  researchSummary: string;
  painPoints: string[];
  buyerIntentLevel: BuyerIntentLevel;
  buyerIntentSignals: string[];
  qualificationScore: number;
  qualificationRationale: string;
  opportunityScore: number;
  recommendedServices: string[];
  recommendedNextStep: string;
  stage: SalesPipelineStage;
  lastAiProvider?: AiProviderId | 'fallback';
  lastAiModel?: string;
  createdAt: string;
  updatedAt: string;
}

export type SalesOutputType =
  | 'personalized-response'
  | 'proposal'
  | 'follow-up'
  | 'sales-campaign-intel';

export interface SalesOutputRecord {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  leadId: string;
  leadName: string;
  outputType: SalesOutputType;
  title: string;
  contentMarkdown: string;
  manifest?: LongFormDocumentManifest;
  providerId: AiProviderId | 'fallback';
  model: string;
  wasFallback: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SalesActivityRecord {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  leadId?: string;
  leadName?: string;
  activityType:
    | 'lead-created'
    | 'lead-researched'
    | 'lead-qualified'
    | 'response-generated'
    | 'proposal-generated'
    | 'follow-up-drafted'
    | 'campaign-intel-generated'
    | 'stage-updated';
  summary: string;
  detail?: string;
  providerId?: AiProviderId | 'fallback';
  model?: string;
  timestamp: string;
}
