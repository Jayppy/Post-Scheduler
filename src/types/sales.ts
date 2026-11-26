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

export interface SalesServiceOffer {
  id: string;
  name: string;
  summary: string;
  deliverables: string[];
  idealFor: string[];
  differentiator: string;
  verifiedFromWebsite: boolean;
}

export interface SalesKnowledgeBase {
  id: string;
  workspaceId: 'ws-74-studio-sales';
  businessName: string;
  websiteUrl: string;
  brandVoice: string;
  positioning: string;
  pricingPolicy: string;
  contactSummary: string;
  knownUrls: Array<{ label: string; url: string }>;
  services: SalesServiceOffer[];
  qualificationCriteria: string;
  approvedMessagingNotes: string;
  noFabricationGuard: string;
  updatedAt: string;
}

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
