import type { LongFormDocumentManifest } from './aiProviders';

export type ResearchCategory =
  | 'industry-report'
  | 'charts-discovery'
  | 'audience-insight'
  | 'buyer-objection'
  | 'platform-trend';

export type DataClassification =
  | 'current'
  | 'historical'
  | 'emerging-pattern'
  | 'verified-fact'
  | 'interpretation'
  | 'hypothesis';

export type ResearchAccessMethod =
  | 'live-web-search'
  | 'official-reference'
  | 'owner-supplied'
  | 'optional-api';

export interface ResearchSourceRecord {
  id: string;
  sourceName: string;
  sourceUrl: string;
  category: ResearchCategory;
  dataClassification: DataClassification;
  accessMethod: ResearchAccessMethod;
  publicationDate: string;
  accessedAt: string;
  freshnessLabel: string;
  primaryOrSecondary: 'primary' | 'secondary';
  confidence: 'high' | 'medium' | 'low';
  usageRestrictions: string;
  finding: string;
  implications: string;
  tags: string[];
}

export interface StudioServiceOffer {
  id: string;
  name: string;
  summary: string;
  deliverables: string[];
  idealFor: string[];
  differentiator: string;
  verifiedFromWebsite: boolean;
}

export interface IdealCustomerProfile {
  id: string;
  segment: string;
  goals: string[];
  frustrations: string[];
  commonObjections: string[];
  purchasingConsiderations: string[];
  trustRequirements: string[];
}

export interface VerifiedProofItem {
  id: string;
  title: string;
  clientOrProject: string;
  summary: string;
  sourceNote: string;
}

export interface BusinessKnowledgeBase {
  id: string;
  businessName: string;
  websiteUrl: string;
  brandVoice: string;
  positioning: string;
  pricingSummary: string;
  contactSummary: string;
  knownUrls: Array<{ label: string; url: string }>;
  services: StudioServiceOffer[];
  idealCustomerProfiles: IdealCustomerProfile[];
  verifiedProofItems: VerifiedProofItem[];
  updatedAt: string;
}

export type TargetAudienceSegment =
  | 'Independent recording artists'
  | 'Established recording artists'
  | 'Music producers'
  | 'Beatmakers'
  | 'Songwriters'
  | 'Independent music entrepreneurs'
  | 'Record labels'
  | 'Music managers'
  | 'Artist development teams'
  | 'Music businesses';

export type AwarenessStage =
  | 'Unaware'
  | 'Problem Aware'
  | 'Solution Aware'
  | 'Product / Studio Aware'
  | 'Most Aware / Decision Ready';

export type ContentCategory15 =
  | 'Problem awareness'
  | 'Industry education'
  | 'Expert authority'
  | 'Myth correction'
  | 'Common mistakes'
  | 'Buyer objection handling'
  | 'Service education'
  | 'Case-study storytelling'
  | 'Industry trend analysis'
  | 'Customer transformation'
  | 'Service comparison and differentiation'
  | 'Lead generation'
  | 'Purchase-intent content'
  | 'Brand positioning'
  | 'Conversion-focused content';

export interface TopicOpportunity {
  id: string;
  topic: string;
  targetAudience: TargetAudienceSegment;
  serviceOffer: string;
  awarenessStage: AwarenessStage;
  contentCategory: ContentCategory15;
  audienceProblem: string;
  strategicObjective: string;
  recommendedAngle: string;
  psychologyPrinciple: string;
  supportingSourceIds: string[];
}

export interface EvidenceClaimRef {
  id: string;
  claim: string;
  researchSourceId?: string;
  sourceName: string;
  sourceUrl: string;
  publicationDate: string;
  accessedAt: string;
  relevantFinding: string;
  primaryOrSecondary: 'primary' | 'secondary';
  confidence: 'high' | 'medium' | 'low';
  dataClassification: DataClassification;
  isUnverifiedHypothesis: boolean;
}

export interface CentralContentConcept {
  targetAudience: string;
  audienceProblem: string;
  awarenessStage: string;
  strategicObjective: string;
  coreMessage: string;
  recommendedAngle: string;
  psychologyFramework: string;
  ctaObjective: string;
  serviceTieIn: string;
}

export interface BlogArticleOutput {
  seoTitle: string;
  metaDescription: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: string;
  h2Outline: string[];
  featuredImageConcept: string;
  internalLinks: Array<{ anchor: string; url: string }>;
  bodyMarkdown: string;
  blogManifest?: LongFormDocumentManifest;
}

export interface PlatformContentBundle {
  linkedin: string;
  x: {
    ultraShort: string;
    expanded: string;
    targetShortChars: number;
  };
  threads: string;
  blog: BlogArticleOutput;
}

export interface MarketingDraft {
  id: string;
  title: string;
  status: 'draft' | 'reviewed' | 'ready-to-copy' | 'archived';
  targetAudience: string;
  serviceOffer: string;
  objective: string;
  awarenessStage: string;
  contentCategory: string;
  topic: string;
  tone: string;
  ctaObjective: string;
  researchDepth: 'standard' | 'deep';
  xTargetChars: number;
  blogWordTarget: number;
  centralConcept: CentralContentConcept;
  platforms: PlatformContentBundle;
  evidenceClaims: EvidenceClaimRef[];
  generationMeta?: {
    providerId: string;
    model: string;
    wasFallback?: boolean;
    completionStatus?: 'incomplete' | 'complete' | 'verified';
  };
  createdAt: string;
  updatedAt: string;
}

export interface OptionalResearchIntegrationStatus {
  id: string;
  name: string;
  envVar: string;
  configured: boolean;
  category: string;
  note: string;
}

export interface GenerateMarketingContentInput {
  targetAudience: string;
  serviceOffer: string;
  objective: string;
  awarenessStage: string;
  contentCategory: string;
  topic: string;
  tone: string;
  ctaObjective: string;
  researchDepth: 'standard' | 'deep';
  xTargetChars?: number;
  blogWordTarget?: number;
  selectedSourceIds?: string[];
}
