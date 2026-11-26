import { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  BlogArticleOutput,
  BusinessKnowledgeBase,
  CentralContentConcept,
  EvidenceClaimRef,
  GenerateMarketingContentInput,
  MarketingDraft,
  OptionalResearchIntegrationStatus,
  PlatformContentBundle,
  ResearchCategory,
  ResearchSourceRecord,
  TopicOpportunity,
} from '../src/types/marketing';
import type { LongFormDocumentManifest } from '../src/types/aiProviders';
import { executeAiTask } from './aiProviders/providerManager';
import {
  auditLongFormManifestConsistency,
  executeSectionManifestGeneration,
  initializeManifestFromHeadings,
} from './aiProviders/longFormEngine';
import { aiGenerationLimiter } from './rateLimiters';
import { ProviderExecutionError } from './aiProviders/types';
import {
  type AuthenticatedRequest,
  requireServerOperator,
} from './aiProviders/authMiddleware';
import {
  checkQuotaAndAvailability,
  recordProviderError,
  recordProviderSuccess,
} from './aiProviders/quotaStore';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const MARKETING_STORE_PATH = path.join(DATA_DIR, 'marketing-studio.json');

interface MarketingStoreFile {
  version: number;
  knowledgeBase: BusinessKnowledgeBase;
  researchSources: ResearchSourceRecord[];
  topicOpportunities: TopicOpportunity[];
  drafts: MarketingDraft[];
  lastLiveResearchAt?: string;
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientAiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

async function generateWithRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientAiError(err)) {
        const delayMs = attempt === 1 ? 1000 : 2500;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function handleMarketingAiError(res: Response, action: string, err: unknown) {
  if (err instanceof ProviderExecutionError) {
    return res.status(err.statusCode || 500).json({
      error: `${action}: ${err.message}`,
      code: err.errorClass,
      providerId: err.providerId,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const isUnavailable = lower.includes('503') || lower.includes('unavailable') || lower.includes('high demand');
  const isQuota = lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota');
  const isAuth = lower.includes('403') || lower.includes('permission_denied') || lower.includes('api_key_invalid');
  const status = isUnavailable ? 503 : isQuota ? 429 : isAuth ? 403 : 500;
  return res.status(status).json({
    error: isUnavailable
      ? `${action}: AI model is temporarily experiencing high demand (503). Please retry shortly.`
      : isQuota
        ? `${action}: AI rate limit or quota reached (429). Please retry shortly.`
        : isAuth
          ? `${action}: AI API key missing or invalid in Settings > Secrets.`
          : `${action}: ${msg}`,
    code: isUnavailable ? 'MODEL_UNAVAILABLE' : isQuota ? 'QUOTA_EXCEEDED' : isAuth ? 'AUTH_ERROR' : 'AI_ERROR',
  });
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function buildDefaultKnowledgeBase(): BusinessKnowledgeBase {
  return {
    id: 'kb-74-studio',
    businessName: '74 STUDIO',
    websiteUrl: 'https://74-studio.com',
    brandVoice:
      'Sharp, credible, music-industry literate creative studio authority. Practical and artist-aware without hype, empty buzzwords, or manipulative pressure.',
    positioning:
      '74 STUDIO is an independent creative visual studio producing music videos, animated visual worlds, music visualizers, Spotify Canvas loops, and short-form promotional edits for recording artists, producers, songwriters, and music brands.',
    pricingSummary:
      'Custom-quoted per project based on visual direction, animation/production scope, deliverables, and release timeline. No fixed public rate card is published on 74-studio.com.',
    contactSummary:
      'Enquire directly via https://74-studio.com, inquire@74-studio.com, or john@74-studio.com (YouTube: @prodby74).',
    knownUrls: [
      { label: '74 STUDIO Home', url: 'https://74-studio.com' },
      { label: '74 STUDIO YouTube (@prodby74)', url: 'https://www.youtube.com/@prodby74' },
    ],
    services: [
      {
        id: 'svc-music-videos',
        name: 'Music Videos (AI-Assisted, 3D & 2D Animated)',
        summary:
          'Concept-to-delivery narrative music videos spanning AI-assisted visual concepts, 3D animated worlds, and custom-illustrated 2D animation.',
        deliverables: [
          'Creative concept treatment & visual worldbuilding',
          'Full-length 16:9 music video master',
          'Cohesive color, typography & scene pacing aligned to the track',
        ],
        idealFor: ['Independent recording artists', 'Established recording artists', 'Record labels', 'Music managers'],
        differentiator:
          'Combines animation, 3D/2D storytelling, and agile production workflows so artists do not need a bloated label shoot budget to establish a recognizable visual world.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-visualizers',
        name: 'Music Visualizers',
        summary:
          'Audio-reactive and atmospheric visualizers engineered for YouTube premieres, album tracks, and streaming rollout consistency.',
        deliverables: [
          'Full-track 16:9 YouTube visualizer',
          'Typography-integrated track identity & album aesthetic alignment',
        ],
        idealFor: ['Independent recording artists', 'Music producers', 'Beatmakers', 'Record labels'],
        differentiator:
          'Gives B-sides, singles, and beat showcases a cohesive visual signature instead of static cover-art uploads.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-spotify-canvas-shortform',
        name: 'Spotify Canvas & Short-Form Release Edits',
        summary:
          'Vertical 9:16 looping Spotify Canvas visuals plus TikTok, Instagram Reels, and YouTube Shorts release cuts designed around the strongest 15–30 second hook.',
        deliverables: [
          '3–8 second seamless Spotify Canvas loop',
          '9:16 TikTok, Instagram Reels & YouTube Shorts teaser edits',
          'Consistent release typography & hook framing',
        ],
        idealFor: ['Independent recording artists', 'Songwriters', 'Artist development teams', 'Music managers'],
        differentiator:
          'Built specifically around audio hook retention and streaming visual identity so release rollouts stay visually consistent across DSPs and short-form feeds.',
        verifiedFromWebsite: true,
      },
      {
        id: 'svc-video-editing-ads',
        name: 'Video Editing & Promotional Ads',
        summary:
          'Release trailers, ad-ready short-form creatives, UGC cuts, and post-production finishing for music campaigns and music businesses.',
        deliverables: [
          'Multi-aspect campaign ad variations',
          'Post-production editing, pacing & motion titles',
        ],
        idealFor: ['Music businesses', 'Music producers', 'Record labels', 'Independent music entrepreneurs'],
        differentiator:
          'Creative cuts engineered with clear narrative hooks rather than generic template transitions.',
        verifiedFromWebsite: true,
      },
    ],
    idealCustomerProfiles: [
      {
        id: 'icp-indie-artists',
        segment: 'Independent recording artists',
        goals: [
          'Stand out visually on Spotify, YouTube, Reels, and TikTok during a release window',
          'Build a memorable artistic identity rather than posting forgettable cover-art loops',
          'Turn listeners into repeat fans across releases',
        ],
        frustrations: [
          'Difficulty getting music noticed in crowded algorithmic feeds',
          'Spending budget on ad clicks or generic promos that fail to build artist identity',
          'Poor release asset planning leading to rushed visuals in release week',
        ],
        commonObjections: [
          'Can a custom animated/visual production fit an independent budget?',
          'Will the visuals actually feel original to my sound rather than templated?',
          'Will I receive assets on time for Spotify Canvas and pre-release teasers?',
        ],
        purchasingConsiderations: [
          'Clear deliverable scope before committing budget',
          'Proof of aesthetic craft and pacing quality',
          'Turnaround predictability aligned with distributor & DSP deadlines',
        ],
        trustRequirements: [
          'Transparent custom scoping with zero hidden surprises',
          'Cohesive creative treatment aligned to the song mood',
          'Multi-format utility (YouTube + Spotify Canvas + vertical teasers)',
        ],
      },
      {
        id: 'icp-producers-beatmakers',
        segment: 'Music producers',
        goals: [
          'Differentiate their catalog from look-alike type-beat channels',
          'Attract higher-tier vocalists, artists, and sync/custom production clients',
          'Present beats and studio releases as a serious brand',
        ],
        frustrations: [
          'Commoditized static artwork failing to stop scrollers on YouTube and Reels',
          'Difficulty communicating production quality before a listener clicks play',
          'Inconsistent client pipeline driven solely by price competition',
        ],
        commonObjections: [
          'Do visualizers and short-form visual packs actually help win better artist clients?',
          'How reusable is a visual direction system across multiple uploads?',
        ],
        purchasingConsiderations: [
          'Visual distinctiveness vs generic audio spectrum templates',
          'Speed of rollout across YouTube and vertical channels',
        ],
        trustRequirements: [
          'Taste level suited to serious music brands',
          'Repeatable visual architecture that elevates perceived catalog value',
        ],
      },
      {
        id: 'icp-songwriters-managers-labels',
        segment: 'Music managers',
        goals: [
          'Coordinate cohesive campaign visual assets ahead of release day without logistical bottlenecks',
          'Maximize visual mileage from each single or EP cycle across YouTube, Spotify, and short-form',
        ],
        frustrations: [
          'Coordinating unreliable freelancers who miss distributor deadlines',
          'Disconnected visual deliverables between cover art, Spotify Canvas, and video teasers',
        ],
        commonObjections: [
          'Can 74 STUDIO execute reliably against fixed release schedules?',
          'Can one visual direction scale across full video, visualizer, and short-form edits?',
        ],
        purchasingConsiderations: [
          'Operational reliability and milestone clarity',
          'Cross-platform consistency from one creative team',
        ],
        trustRequirements: [
          'Clear communication, realistic timelines, and documented scopes',
        ],
      },
    ],
    verifiedProofItems: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildSeedResearchSources(): ResearchSourceRecord[] {
  const accessed = new Date().toISOString().slice(0, 10);
  return [
    {
      id: 'src-spotify-canvas-official',
      sourceName: 'Spotify for Artists — Canvas Visual Guidelines',
      sourceUrl: 'https://canvas.spotify.com/',
      category: 'platform-trend',
      dataClassification: 'verified-fact',
      accessMethod: 'official-reference',
      publicationDate: 'Official Resource (Ongoing)',
      accessedAt: accessed,
      freshnessLabel: 'Verified Platform Spec',
      primaryOrSecondary: 'primary',
      confidence: 'high',
      usageRestrictions: 'Public Spotify for Artists documentation; cite as official platform capability.',
      finding:
        'Spotify Canvas supports 3-to-8 second vertical looping visuals (9:16) on Now Playing views and shares, turning static album-art screens into motion touchpoints.',
      implications:
        'Direct strategic tie-in to 74 STUDIO Spotify Canvas & Short-Form Edits: artists releasing singles without motion Canvas leave an owned in-app visual slot unused.',
      tags: ['Spotify Canvas', '9:16', 'Streaming Identity'],
    },
    {
      id: 'src-spotify-pitching-timeline',
      sourceName: 'Spotify for Artists — Playlist Pitching Lead Time',
      sourceUrl: 'https://artists.spotify.com/help/article/pitching-music-to-playlist-editors',
      category: 'industry-report',
      dataClassification: 'verified-fact',
      accessMethod: 'official-reference',
      publicationDate: 'Official Resource (Ongoing)',
      accessedAt: accessed,
      freshnessLabel: 'Verified Platform Policy',
      primaryOrSecondary: 'primary',
      confidence: 'high',
      usageRestrictions: 'Public Spotify for Artists help specification.',
      finding:
        'Spotify recommends submitting unreleased music at least 7 days before release day so editorial teams have time to review metadata and context.',
      implications:
        'Explains why visual production (cover, Canvas, teaser clips) needs to lock before distribution deadlines rather than during release week.',
      tags: ['Release Planning', 'DSP Pitching', 'Lead Time'],
    },
    {
      id: 'src-ifpi-global-music',
      sourceName: 'IFPI Global Music Report (Industry Benchmark Reference)',
      sourceUrl: 'https://www.ifpi.org/our-industry/global-music-report/',
      category: 'industry-report',
      dataClassification: 'historical',
      accessMethod: 'official-reference',
      publicationDate: 'Annual Report Reference',
      accessedAt: accessed,
      freshnessLabel: 'Historical Benchmark (Run Live Scan for Latest)',
      primaryOrSecondary: 'primary',
      confidence: 'high',
      usageRestrictions: 'Historical industry benchmark; verify current-year figures via live search before quoting annual totals.',
      finding:
        'Recorded music revenue globally remains overwhelmingly streaming-driven, increasing competition among independent and label releases for listener retention across audio and video platforms.',
      implications:
        'With streaming shelf-space saturated, differentiated visual storytelling helps independent releases earn attention beyond audio alone.',
      tags: ['IFPI', 'Streaming Competition', 'Global Market'],
    },
    {
      id: 'src-billboard-official-charts',
      sourceName: 'Billboard & Official Charts — Discovery & Multi-Format Context',
      sourceUrl: 'https://www.billboard.com/charts/',
      category: 'charts-discovery',
      dataClassification: 'interpretation',
      accessMethod: 'official-reference',
      publicationDate: 'Ongoing Editorial Charts',
      accessedAt: accessed,
      freshnessLabel: 'Chart Reference (Run Live Scan for Current Moves)',
      primaryOrSecondary: 'secondary',
      confidence: 'medium',
      usageRestrictions: 'Do not claim chart rankings prove individual buyer intent.',
      finding:
        'Cross-platform discovery increasingly links short-form video hooks, official visualizers, and streaming replays rather than relying on radio or single-channel premieres alone.',
      implications:
        'Artists and managers planning multi-week campaigns benefit from synchronized 16:9 visualizers and 9:16 short-form motion assets.',
      tags: ['Charts', 'Discovery', 'Short-Form'],
    },
    {
      id: 'src-buyer-jtbd-framework',
      sourceName: 'Independent Music Buyer Objection & JTBD Framework',
      sourceUrl: 'https://74-studio.com',
      category: 'buyer-objection',
      dataClassification: 'interpretation',
      accessMethod: 'owner-supplied',
      publicationDate: 'Internal Strategy Baseline',
      accessedAt: accessed,
      freshnessLabel: 'Editorial Framework',
      primaryOrSecondary: 'secondary',
      confidence: 'medium',
      usageRestrictions: 'Behavioral strategy framework; do not present as a statistical survey.',
      finding:
        'Independent artists and producers often delay hiring visual studios not because they undervalue visuals, but because they fear unclear scope, missed release deadlines, or generic template work.',
      implications:
        'High-converting 74 STUDIO marketing content should reduce perceived risk by explaining creative scoping, milestone reliability, and visual differentiation transparently.',
      tags: ['Buyer Psychology', 'Objection Handling', 'JTBD'],
    },
  ];
}

function buildSeedTopicOpportunities(): TopicOpportunity[] {
  return [
    {
      id: 'opp-canvas-release-window',
      topic: 'Why Treating Spotify Canvas & Release Visuals as an Afterthought Weakens First-Week Momentum',
      targetAudience: 'Independent recording artists',
      serviceOffer: 'Spotify Canvas & Short-Form Release Edits',
      awarenessStage: 'Problem Aware',
      contentCategory: 'Common mistakes',
      audienceProblem:
        'Artists spend months perfecting a mix, then upload static cover art and rush vertical clips two days before release.',
      strategicObjective:
        'Educate artists on pre-release visual readiness and position 74 STUDIO short-form/Canvas packages early in the planning window.',
      recommendedAngle:
        'Contrast rushed release-week asset scrambling against a unified 9:16 visual system spanning Spotify Canvas, Reels, and Shorts.',
      psychologyPrinciple: 'Risk reduction & release-window loss framing (non-manipulative)',
      supportingSourceIds: ['src-spotify-canvas-official', 'src-spotify-pitching-timeline'],
    },
    {
      id: 'opp-visualizer-vs-static',
      topic: 'Beyond Static Cover Art: Using Animated Visualizers to Differentiate Releases & Beat Catalogs',
      targetAudience: 'Music producers',
      serviceOffer: 'Music Visualizers',
      awarenessStage: 'Solution Aware',
      contentCategory: 'Service comparison and differentiation',
      audienceProblem:
        'Producers and artists struggle to stand out on YouTube when every release uses interchangeable static art or generic waveform bars.',
      strategicObjective:
        'Attract serious producers and artists seeking bespoke visual identity on YouTube.',
      recommendedAngle:
        'Show how cohesive typography, atmosphere, and motion pacing signal artistic professionalism before a listener commits 3 minutes.',
      psychologyPrinciple: 'Authority, differentiation & Jobs To Be Done',
      supportingSourceIds: ['src-billboard-official-charts', 'src-buyer-jtbd-framework'],
    },
    {
      id: 'opp-indie-video-budget-myth',
      topic: 'The Myth That Every Memorable Music Video Requires a Five-Figure Traditional Shoot',
      targetAudience: 'Independent recording artists',
      serviceOffer: 'Music Videos (AI-Assisted, 3D & 2D Animated)',
      awarenessStage: 'Problem Aware',
      contentCategory: 'Myth correction',
      audienceProblem:
        'Artists assume they must choose between an expensive camera crew shoot or skipping full music videos entirely.',
      strategicObjective:
        'Handle budget/feasibility objections and drive qualified project enquiries via 74-studio.com.',
      recommendedAngle:
        'Break down how 3D worlds, 2D custom illustration, and AI-assisted visual direction unlock bold storytelling scoped to release reality.',
      psychologyPrinciple: 'Objection handling & value proposition design',
      supportingSourceIds: ['src-ifpi-global-music', 'src-buyer-jtbd-framework'],
    },
  ];
}

function getStorePath(scopeKey: string): string {
  const safeScope = scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96) || 'local-operator';
  return safeScope === 'local-operator'
    ? MARKETING_STORE_PATH
    : path.join(DATA_DIR, `marketing-studio-${safeScope}.json`);
}

function loadStore(scopeKey = 'local-operator'): MarketingStoreFile {
  const storePath = getStorePath(scopeKey);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(storePath)) {
      const initial: MarketingStoreFile = {
        version: 1,
        knowledgeBase: buildDefaultKnowledgeBase(),
        researchSources: buildSeedResearchSources(),
        topicOpportunities: buildSeedTopicOpportunities(),
        drafts: [],
      };
      fs.writeFileSync(storePath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<MarketingStoreFile>;
    return {
      version: 1,
      knowledgeBase: parsed.knowledgeBase || buildDefaultKnowledgeBase(),
      researchSources:
        Array.isArray(parsed.researchSources) && parsed.researchSources.length > 0
          ? parsed.researchSources
          : buildSeedResearchSources(),
      topicOpportunities:
        Array.isArray(parsed.topicOpportunities) && parsed.topicOpportunities.length > 0
          ? parsed.topicOpportunities
          : buildSeedTopicOpportunities(),
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
      lastLiveResearchAt: parsed.lastLiveResearchAt,
    };
  } catch {
    return {
      version: 1,
      knowledgeBase: buildDefaultKnowledgeBase(),
      researchSources: buildSeedResearchSources(),
      topicOpportunities: buildSeedTopicOpportunities(),
      drafts: [],
    };
  }
}

function saveStore(store: MarketingStoreFile, scopeKey = 'local-operator'): void {
  const storePath = getStorePath(scopeKey);
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${storePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, storePath);
}

function getOptionalIntegrationsStatus(): OptionalResearchIntegrationStatus[] {
  return [
    {
      id: 'chartmetric',
      name: 'Chartmetric API',
      envVar: 'CHARTMETRIC_API_KEY',
      configured: Boolean(process.env.CHARTMETRIC_API_KEY?.trim()),
      category: 'Charts, Streaming Velocity & Artist Discovery',
      note: 'Requires paid Chartmetric API subscription token stored in AI Studio Settings > Secrets.',
    },
    {
      id: 'soundcharts',
      name: 'Soundcharts API',
      envVar: 'SOUNDCHARTS_API_KEY',
      configured: Boolean(process.env.SOUNDCHARTS_API_KEY?.trim()),
      category: 'Global Charts, Radio & Playlist Analytics',
      note: 'Requires authorized Soundcharts API key in server environment secrets.',
    },
    {
      id: 'luminate',
      name: 'Luminate Data API',
      envVar: 'LUMINATE_API_KEY',
      configured: Boolean(process.env.LUMINATE_API_KEY?.trim()),
      category: 'Verified Market & Consumption Reports',
      note: 'Enterprise license credential; when unconfigured, public research & Google Search grounding cover public summaries.',
    },
  ];
}

function safeParseJson<T>(rawText: string, fallback: T): T {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

function buildFallbackGeneration(
  input: GenerateMarketingContentInput,
  kb: BusinessKnowledgeBase,
  sources: ResearchSourceRecord[]
): {
  centralConcept: CentralContentConcept;
  platforms: PlatformContentBundle;
  evidenceClaims: EvidenceClaimRef[];
} {
  const matchedSource =
    sources.find((s) => input.selectedSourceIds?.includes(s.id)) || sources[0];
  const matchedService =
    kb.services.find((s) => s.name === input.serviceOffer) || kb.services[0];
  const xTarget = Math.max(25, Math.min(280, Number(input.xTargetChars) || 50));

  const centralConcept: CentralContentConcept = {
    targetAudience: input.targetAudience,
    audienceProblem: `Many ${input.targetAudience.toLowerCase()} invest heavily in audio production while leaving release visuals disconnected or rushed, limiting discoverability and listener trust.`,
    awarenessStage: input.awarenessStage,
    strategicObjective: input.objective,
    coreMessage: `Visual direction is part of how listeners judge audio credibility. Cohesive motion assets aligned before release deadlines improve presentation across DSPs and social discovery without bloated shoots.`,
    recommendedAngle: `${input.contentCategory} focused on ${input.topic}`,
    psychologyFramework: 'Jobs To Be Done + Risk Reduction + Objection Handling',
    ctaObjective: input.ctaObjective,
    serviceTieIn: `${matchedService.name}: ${matchedService.summary}`,
  };

  const ultraShortCandidate = `Great mixes still lose to weak release visuals.`.slice(0, xTarget);

  const platforms: PlatformContentBundle = {
    linkedin: `Most releases don't fail on audio quality.\nThey lose attention in the first 3 seconds of presentation.\n\nFor ${input.targetAudience.toLowerCase()}, the pattern shows up constantly around ${input.topic}:\n\n→ Distribution and audio masters lock weeks ahead.\n→ Visual assets (Spotify Canvas, YouTube visualizers, vertical hooks) get improvised right before release day.\n\nWhen every platform shows a disconnected visual, new listeners never lock onto a recognizable world.\n\nAt 74 STUDIO, we build ${matchedService.name.toLowerCase()} with clear scope and release-calendar pacing—so artists and teams ship cohesive visuals across 16:9 and 9:16 formats.\n\n${input.ctaObjective}\nScope a project via ${kb.websiteUrl} or inquire@74-studio.com`,
    x: {
      ultraShort: ultraShortCandidate,
      expanded: `Artists spend months on the mix, then improvise release visuals in 48 hours.\n\nA cohesive visual world across Spotify Canvas, YouTube, and vertical cuts makes new listeners take the track seriously on first impression.\n\nExplore custom visual scopes: ${kb.websiteUrl}`,
      targetShortChars: xTarget,
    },
    threads: `Hot take for ${input.targetAudience.toLowerCase()}:\n\nPeople hear your music with their eyes first—on Spotify Now Playing, YouTube search, and vertical feeds.\n\nIf the visual feels slapped together right before drop day, listeners assume the release isn't serious yet.\n\nWe build custom music videos, visualizers, and Spotify Canvas worlds at 74 STUDIO so your visuals match the weight of the record.\n\n${input.ctaObjective} -> ${kb.websiteUrl}`,
    blog: {
      seoTitle: `${input.topic} | 74 STUDIO`,
      metaDescription: `Practical creative strategy for ${input.targetAudience.toLowerCase()} on ${input.topic}, Spotify Canvas readiness, and cohesive music visuals at 74 STUDIO.`,
      primaryKeyword: input.topic.slice(0, 60),
      secondaryKeywords: [
        '74 STUDIO',
        matchedService.name,
        input.targetAudience,
        'music release visuals',
      ],
      searchIntent: 'Commercial Investigation & Educational',
      h2Outline: [
        `Why ${input.topic} Matters for ${input.targetAudience}`,
        'The Operational Gap Between Audio Finish and Visual Rollout',
        'Platform Reality: Spotify Canvas, YouTube & Vertical Discovery',
        `How ${matchedService.name} Fits Without Bloated Production Friction`,
        'Next Steps for Planning Your Next Release Visuals',
      ],
      featuredImageConcept:
        'High-contrast obsidian studio scene pairing a 9:16 Spotify Canvas motion frame beside a widescreen animated visualizer storyboard.',
      internalLinks: kb.knownUrls.map((u) => ({ anchor: u.label, url: u.url })),
      bodyMarkdown: `## Why ${input.topic} Matters for ${input.targetAudience}\n\n${centralConcept.audienceProblem}\n\n## The Operational Gap Between Audio Finish and Visual Rollout\n\nAcross independent and label-backed campaigns, music distribution timelines demand early metadata delivery. Visual systems work best when planned on that same schedule rather than improvised during release week.\n\n## Platform Reality: Spotify Canvas, YouTube & Vertical Discovery\n\n${matchedSource ? `${matchedSource.finding} (Source: ${matchedSource.sourceName}, ${matchedSource.sourceUrl})` : 'Motion surfaces on streaming and video platforms turn passive cover displays into active visual hooks.'}\n\n## How ${matchedService.name} Fits\n\n${matchedService.summary} Deliverables typically include ${matchedService.deliverables.join('; ')}. ${kb.pricingSummary}\n\n## Next Steps\n\n${input.ctaObjective}. ${kb.contactSummary}`,
    },
  };

  const evidenceClaims: EvidenceClaimRef[] = matchedSource
    ? [
        {
          id: createId('ev'),
          claim: matchedSource.finding,
          researchSourceId: matchedSource.id,
          sourceName: matchedSource.sourceName,
          sourceUrl: matchedSource.sourceUrl,
          publicationDate: matchedSource.publicationDate,
          accessedAt: matchedSource.accessedAt,
          relevantFinding: matchedSource.finding,
          primaryOrSecondary: matchedSource.primaryOrSecondary,
          confidence: matchedSource.confidence,
          dataClassification: matchedSource.dataClassification,
          isUnverifiedHypothesis: false,
        },
      ]
    : [
        {
          id: createId('ev'),
          claim: centralConcept.audienceProblem,
          sourceName: 'Strategic Editorial Interpretation',
          sourceUrl: kb.websiteUrl,
          publicationDate: new Date().toISOString().slice(0, 10),
          accessedAt: new Date().toISOString().slice(0, 10),
          relevantFinding: 'Derived from marketing buyer psychology baseline; no external stat asserted.',
          primaryOrSecondary: 'secondary',
          confidence: 'medium',
          dataClassification: 'hypothesis',
          isUnverifiedHypothesis: true,
        },
      ];

  return { centralConcept, platforms, evidenceClaims };
}

export function registerMarketingIntelligence(app: Express): void {
  const mktGuard = requireServerOperator('ws-behind-the-release');

  // 1. Optional external data API credential status (never exposes secrets)
  app.get('/api/marketing/integrations', mktGuard, (_req: Request, res: Response) => {
    const integrations = getOptionalIntegrationsStatus();
    const aiConfigured = Boolean(getAiClient());
    return res.json({
      geminiConfigured: aiConfigured,
      liveWebSearchEnabled: aiConfigured,
      integrations,
      disclosure:
        integrations.every((i) => !i.configured)
          ? 'Optional paid music-data APIs (Chartmetric, Soundcharts, Luminate) are not configured. Public research uses Gemini Google Search grounding plus verified official reference benchmarks.'
          : 'Configured external data integrations active alongside public research.',
    });
  });

  // 2. Business Knowledge Base (74 STUDIO)
  app.get('/api/marketing/knowledge-base', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const store = loadStore(scope);
    return res.json({ knowledgeBase: store.knowledgeBase });
  });

  app.put('/api/marketing/knowledge-base', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const body = (req.body || {}) as Partial<BusinessKnowledgeBase>;
    if (!body || !body.businessName?.trim()) {
      return res.status(400).json({ error: 'Valid businessName is required.' });
    }
    const store = loadStore(scope);
    const cur = store.knowledgeBase;
    store.knowledgeBase = {
      id: cur.id,
      businessName: String(body.businessName).trim().slice(0, 160),
      websiteUrl: String(body.websiteUrl ?? cur.websiteUrl).trim().slice(0, 300),
      brandVoice: String(body.brandVoice ?? cur.brandVoice).slice(0, 2000),
      positioning: String(body.positioning ?? cur.positioning).slice(0, 3000),
      pricingSummary: String(body.pricingSummary ?? cur.pricingSummary).slice(0, 2000),
      contactSummary: String(body.contactSummary ?? cur.contactSummary).slice(0, 1200),
      knownUrls: Array.isArray(body.knownUrls) ? body.knownUrls.slice(0, 30) : cur.knownUrls,
      services: Array.isArray(body.services) ? body.services.slice(0, 25) : cur.services,
      idealCustomerProfiles: Array.isArray(body.idealCustomerProfiles)
        ? body.idealCustomerProfiles.slice(0, 20)
        : cur.idealCustomerProfiles,
      verifiedProofItems: Array.isArray(body.verifiedProofItems)
        ? body.verifiedProofItems.slice(0, 50)
        : cur.verifiedProofItems,
      updatedAt: new Date().toISOString(),
    };
    saveStore(store, scope);
    return res.json({ knowledgeBase: store.knowledgeBase });
  });

  // 3. Research & Intelligence Repository
  app.get('/api/marketing/research', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const store = loadStore(scope);
    return res.json({
      sources: store.researchSources,
      opportunities: store.topicOpportunities,
      lastLiveResearchAt: store.lastLiveResearchAt,
    });
  });

  app.post('/api/marketing/research', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const body = req.body as Partial<ResearchSourceRecord>;
    if (!body.sourceName?.trim() || !body.finding?.trim()) {
      return res.status(400).json({ error: 'sourceName and finding are required.' });
    }
    const store = loadStore(scope);
    const resolvedAccessMethod = body.accessMethod || 'owner-supplied';
    const record: ResearchSourceRecord = {
      id: createId('src'),
      sourceName: body.sourceName.trim().slice(0, 200),
      sourceUrl: (body.sourceUrl || 'https://74-studio.com').trim().slice(0, 600),
      category: body.category || 'audience-insight',
      dataClassification:
        body.dataClassification ||
        (resolvedAccessMethod === 'owner-supplied' ? 'verified-fact' : 'interpretation'),
      accessMethod: resolvedAccessMethod,
      publicationDate: body.publicationDate?.trim() || new Date().toISOString().slice(0, 10),
      accessedAt: body.accessedAt?.trim() || new Date().toISOString().slice(0, 10),
      freshnessLabel: body.freshnessLabel?.trim() || 'Owner Supplied',
      primaryOrSecondary: body.primaryOrSecondary || 'primary',
      confidence: body.confidence || 'high',
      usageRestrictions: body.usageRestrictions?.trim() || 'Owner-verified internal or cited note.',
      finding: body.finding.trim().slice(0, 4000),
      implications: body.implications?.trim().slice(0, 2000) || '',
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : [],
    };
    store.researchSources = [record, ...store.researchSources];
    saveStore(store, scope);
    return res.json({ source: record });
  });

  app.delete('/api/marketing/research/:id', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const id = String(req.params.id || '');
    const store = loadStore(scope);
    store.researchSources = store.researchSources.filter((s) => s.id !== id);
    saveStore(store, scope);
    return res.json({ ok: true });
  });

  // 3B. Live Grounded Web Research Scan (Gemini + Google Search Grounding)
  app.post('/api/marketing/research/discover', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const { focusQuery, category, forceRefresh } = (req.body || {}) as {
      focusQuery?: string;
      category?: ResearchCategory;
      forceRefresh?: boolean;
    };
    const store = loadStore(scope);

    // Respect responsible caching when same scan requested recently unless forced
    if (
      !forceRefresh &&
      !focusQuery?.trim() &&
      store.lastLiveResearchAt &&
      Date.now() - new Date(store.lastLiveResearchAt).getTime() < 30 * 60 * 1000
    ) {
      return res.json({
        cached: true,
        addedSources: [],
        sources: store.researchSources,
        lastLiveResearchAt: store.lastLiveResearchAt,
      });
    }

    const quotaGate = checkQuotaAndAvailability('ws-behind-the-release', 'gemini');
    if (!quotaGate.ok) {
      return res.status(429).json({
        error: quotaGate.reason,
        code: quotaGate.code,
      });
    }

    const ai = getAiClient();
    if (!ai) {
      return res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured in Settings > Secrets. Add an owner-supplied source manually or configure Gemini for live web research.',
        code: 'NO_API_KEY',
      });
    }

    const queryFocus =
      focusQuery?.trim() ||
      'independent music artist marketing trends, Spotify Canvas and short-form video discovery, music charts consumption shifts, IFPI and streaming discovery 2025 2026';

    const startedAt = Date.now();
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Conduct live public music-industry and audience research using Google Search.
Focus: ${queryFocus}
Category emphasis: ${category || 'all (industry reports, music charts & discovery, emerging trends, audience/buyer needs)'}

CRITICAL EVIDENCE RULES:
1. Only summarize facts verified from actual search results. Never fabricate statistics, chart positions, or source URLs.
2. Distinguish clearly between current figures, historical benchmarks, emerging patterns, verified facts, and strategic interpretations.
3. Return 3 to 5 concise structured findings in JSON format with keys:
   {
     "findings": [
       {
         "sourceName": "string",
         "category": "industry-report | charts-discovery | audience-insight | buyer-objection | platform-trend",
         "dataClassification": "current | historical | emerging-pattern | verified-fact | interpretation",
         "publicationDate": "string (exact date or year from article, or 'Not stated')",
         "primaryOrSecondary": "primary | secondary",
         "confidence": "high | medium | low",
         "finding": "concise factual summary (<= 60 words)",
         "implications": "how this affects visual storytelling, music videos, visualizers, or Spotify Canvas for 74 STUDIO clients (<= 45 words)",
         "tags": ["tag1", "tag2"]
       }
     ]
   }
Return valid JSON only.`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            tools: [{ googleSearch: {} }],
          },
        })
      );

      const groundingChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const groundedWebUrls = groundingChunks
        .map((c) => ({
          title: c.web?.title || '',
          url: c.web?.uri || '',
        }))
        .filter((g) => g.url.startsWith('http'));

      const parsed = safeParseJson<{
        findings?: Array<{
          sourceName?: string;
          category?: ResearchCategory;
          dataClassification?: ResearchSourceRecord['dataClassification'];
          publicationDate?: string;
          primaryOrSecondary?: 'primary' | 'secondary';
          confidence?: 'high' | 'medium' | 'low';
          finding?: string;
          implications?: string;
          tags?: string[];
        }>;
      }>(response.text || '{}', { findings: [] });

      const addedSources: ResearchSourceRecord[] = [];
      const rawFindings = parsed.findings || [];

      for (let i = 0; i < rawFindings.length; i++) {
        const f = rawFindings[i];
        if (!f.finding) continue;
        // Ground strictly to real URL returned by googleSearch metadata; never invent URLs
        const matchedChunk = groundedWebUrls[i] || groundedWebUrls[0];
        const safeUrl = matchedChunk?.url || '';
        if (!safeUrl) continue;

        const record: ResearchSourceRecord = {
          id: createId('live'),
          sourceName: (f.sourceName || matchedChunk.title || 'Public Search Result').slice(0, 200),
          sourceUrl: safeUrl.slice(0, 600),
          category: f.category || category || 'industry-report',
          dataClassification: f.dataClassification || 'current',
          accessMethod: 'live-web-search',
          publicationDate: (f.publicationDate || 'Not stated').slice(0, 64),
          accessedAt: todayIso,
          freshnessLabel: `Live Grounded (${todayIso})`,
          primaryOrSecondary: f.primaryOrSecondary || 'secondary',
          confidence: f.confidence || 'medium',
          usageRestrictions: 'Public search grounding snippet; verify primary article before quoting verbatim.',
          finding: f.finding.slice(0, 4000),
          implications: (f.implications || '').slice(0, 2000),
          tags: Array.isArray(f.tags) ? f.tags.slice(0, 6) : ['Live Research'],
        };
        addedSources.push(record);
      }

      const usageMeta = (response as {
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      }).usageMetadata;
      const inTok = usageMeta?.promptTokenCount || 450;
      const outTok = usageMeta?.candidatesTokenCount || Math.max(120, Math.ceil((response.text || '').length / 4));
      recordProviderSuccess({
        workspaceId: 'ws-behind-the-release',
        providerId: 'gemini',
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: usageMeta?.totalTokenCount || inTok + outTok,
        latencyMs: Date.now() - startedAt,
      });

      if (addedSources.length > 0) {
        store.researchSources = [...addedSources, ...store.researchSources].slice(0, 60);
        store.lastLiveResearchAt = new Date().toISOString();
        saveStore(store, scope);
      }

      return res.json({
        cached: false,
        addedSources,
        sources: store.researchSources,
        groundingCount: groundedWebUrls.length,
        lastLiveResearchAt: store.lastLiveResearchAt,
      });
    } catch (err) {
      recordProviderError({
        workspaceId: 'ws-behind-the-release',
        providerId: 'gemini',
        taskType: 'grounded-search',
        errorClass: 'UPSTREAM_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      });
      return handleMarketingAiError(res, 'Live research scan failed', err);
    }
  });

  // 4. Automatic Topic Discovery (Multi-Provider Workspace A Profile)
  app.post('/api/marketing/discover-topics', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const { targetAudience, serviceOffer, contentCategory } = (req.body || {}) as {
      targetAudience?: string;
      serviceOffer?: string;
      contentCategory?: string;
    };
    const store = loadStore(scope);

    try {
      const sourceSummary = store.researchSources
        .slice(0, 8)
        .map((s) => `[id=${s.id}] ${s.sourceName} (${s.dataClassification}): ${s.finding}`)
        .join('\n');
      const serviceSummary = store.knowledgeBase.services
        .map((s) => `- ${s.name}: ${s.summary}`)
        .join('\n');

      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'marketing-generate',
        responseFormat: 'json',
        prompt: `You are the Chief Content Strategist for ${store.knowledgeBase.businessName} (${store.knowledgeBase.websiteUrl}).
Identify 4 high-intent marketing content opportunities that connect real music-industry developments & buyer psychology to actual services.

ACTUAL SERVICES:
${serviceSummary}

RESEARCH & AUDIENCE SOURCES:
${sourceSummary}

FILTERS (optional):
- Preferred Audience: ${targetAudience || 'Any priority music buyer segment'}
- Preferred Service: ${serviceOffer || 'Best strategic fit'}
- Preferred Category: ${contentCategory || 'Varied across awareness, myth correction, objection handling, and conversion'}

STRICT RULES:
- Only cite research source IDs from the provided list above.
- Never invent prices, client results, testimonials, or statistical claims.
- Return strictly JSON: { "opportunities": [{ "topic": string, "targetAudience": string, "serviceOffer": string, "awarenessStage": string, "contentCategory": string, "audienceProblem": string, "strategicObjective": string, "recommendedAngle": string, "psychologyPrinciple": string, "supportingSourceIds": string[] }] }`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            opportunities: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  topic: { type: Type.STRING },
                  targetAudience: { type: Type.STRING },
                  serviceOffer: { type: Type.STRING },
                  awarenessStage: { type: Type.STRING },
                  contentCategory: { type: Type.STRING },
                  audienceProblem: { type: Type.STRING },
                  strategicObjective: { type: Type.STRING },
                  recommendedAngle: { type: Type.STRING },
                  psychologyPrinciple: { type: Type.STRING },
                  supportingSourceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: [
                  'topic',
                  'targetAudience',
                  'serviceOffer',
                  'awarenessStage',
                  'contentCategory',
                  'audienceProblem',
                  'strategicObjective',
                  'recommendedAngle',
                  'psychologyPrinciple',
                ],
              },
            },
          },
          required: ['opportunities'],
        },
      });

      const parsed = safeParseJson<{ opportunities?: Array<Omit<TopicOpportunity, 'id'>> }>(
        aiResp.text || '{}',
        {}
      );
      const validSourceIds = new Set(store.researchSources.map((s) => s.id));
      const newOpps: TopicOpportunity[] = (parsed.opportunities || []).map((o) => ({
        id: createId('opp'),
        topic: o.topic,
        targetAudience: o.targetAudience as TopicOpportunity['targetAudience'],
        serviceOffer: o.serviceOffer,
        awarenessStage: o.awarenessStage as TopicOpportunity['awarenessStage'],
        contentCategory: o.contentCategory as TopicOpportunity['contentCategory'],
        audienceProblem: o.audienceProblem,
        strategicObjective: o.strategicObjective,
        recommendedAngle: o.recommendedAngle,
        psychologyPrinciple: o.psychologyPrinciple,
        supportingSourceIds: (o.supportingSourceIds || []).filter((id) => validSourceIds.has(id)),
      }));

      if (newOpps.length > 0) {
        store.topicOpportunities = [...newOpps, ...store.topicOpportunities].slice(0, 12);
        saveStore(store, scope);
      }

      return res.json({
        opportunities: newOpps.length > 0 ? newOpps : store.topicOpportunities,
        providerMeta: { providerId: aiResp.providerId, model: aiResp.model, wasFallback: aiResp.wasFallback },
      });
    } catch (err) {
      if (err instanceof ProviderExecutionError && err.errorClass === 'BUDGET_EXHAUSTED') {
        return handleMarketingAiError(res, 'Topic discovery blocked by quota budget', err);
      }
      if (err instanceof ProviderExecutionError && !err.allowFallback && err.errorClass === 'AUTH_INVALID') {
        return handleMarketingAiError(res, 'Topic discovery failed authentication', err);
      }
      return res.json({ opportunities: store.topicOpportunities, fallback: true });
    }
  });

  // 5. Generate 1 Central Concept + 4 Distinct Platform Outputs + Verified Evidence Mapping (Multi-Provider)
  app.post('/api/marketing/generate', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const input = (req.body || {}) as GenerateMarketingContentInput;
    if (!input.topic?.trim() || !input.targetAudience?.trim()) {
      return res.status(400).json({ error: 'topic and targetAudience are required.' });
    }

    const store = loadStore(scope);
    const kb = store.knowledgeBase;
    const xTargetChars = Math.max(25, Math.min(280, Number(input.xTargetChars) || 50));
    const blogWordTarget = Math.max(600, Math.min(2400, Number(input.blogWordTarget) || 1100));

    const selectedSources =
      input.selectedSourceIds && input.selectedSourceIds.length > 0
        ? store.researchSources.filter((s) => input.selectedSourceIds!.includes(s.id))
        : store.researchSources.slice(0, input.researchDepth === 'deep' ? 8 : 5);

    try {
      const kbContext = `Business: ${kb.businessName} (${kb.websiteUrl})
Positioning: ${kb.positioning}
Brand Voice: ${kb.brandVoice}
Pricing Policy: ${kb.pricingSummary}
Contact: ${kb.contactSummary}
Known Official URLs: ${kb.knownUrls.map((u) => `${u.label}: ${u.url}`).join(' | ')}
Verified Services:\n${kb.services
        .map((s) => `- ${s.name}: ${s.summary} (Deliverables: ${s.deliverables.join(', ')})`)
        .join('\n')}
Owner-Verified Proof/Case Studies: ${
        kb.verifiedProofItems.length > 0
          ? kb.verifiedProofItems.map((p) => `${p.title} (${p.clientOrProject}): ${p.summary}`).join(' | ')
          : 'NONE SUPPLIED — Do NOT invent client results, testimonials, case studies, or statistics.'
      }`;

      const sourcesContext = selectedSources
        .map(
          (s) =>
            `[id=${s.id}] Source="${s.sourceName}" URL="${s.sourceUrl}" Class="${s.dataClassification}" PubDate="${s.publicationDate}" Accessed="${s.accessedAt}" Type="${s.primaryOrSecondary}" Confidence="${s.confidence}"\nFinding: ${s.finding}`
        )
        .join('\n\n');

      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'marketing-generate',
        responseFormat: 'json',
        maxOutputTokens: 8192,
        prompt: `You are the senior marketing intelligence director for ${kb.businessName}.
Transform ONE strategic marketing concept into FOUR genuinely distinct platform-specific outputs while keeping the central argument, facts, and business goal identical.

BRIEF:
- Target Audience: ${input.targetAudience}
- Service / Offer: ${input.serviceOffer}
- Content Objective: ${input.objective}
- Customer Awareness Stage: ${input.awarenessStage}
- Content Category: ${input.contentCategory}
- Topic: ${input.topic}
- Tone: ${input.tone}
- CTA Objective: ${input.ctaObjective}
- Research Depth: ${input.researchDepth}
- X Ultra-Short Target Length: ~${xTargetChars} characters
- Website Blog Target Length: ~${blogWordTarget} words

VERIFIED KNOWLEDGE BASE:
${kbContext}

RESEARCH & EVIDENCE POOL (ONLY cite IDs and facts from here or verified KB; never fabricate citations, prices, stats, or testimonials):
${sourcesContext}

STRICT NON-FABRICATION & QUALITY RULES:
1. ZERO copy-paste across platforms: LinkedIn, X, Threads, and Website Blog must each have native structure, pacing, and formatting.
2. LinkedIn: Strong opening hook, readable short paragraphs, credible positioning, natural CTA, max 0-3 subtle hashtags.
3. X (Twitter): "ultraShort" (~${xTargetChars} chars, <= ${Math.max(xTargetChars + 15, 70)} chars) + "expanded" (~180-280 chars).
4. Threads: Conversational, natural, short lines, NOT formal like LinkedIn.
5. Blog: SEO title, meta description (135-160 chars), primaryKeyword, secondaryKeywords, searchIntent, h2Outline (4-6 headings), featuredImageConcept, internalLinks ONLY from Known Official URLs above, and complete H2/H3 bodyMarkdown.
6. Evidence Claims: Map verified claims to "researchSourceId"; mark unsupported points with isUnverifiedHypothesis=true.
Return strictly valid JSON matching the schema.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            centralConcept: {
              type: Type.OBJECT,
              properties: {
                targetAudience: { type: Type.STRING },
                audienceProblem: { type: Type.STRING },
                awarenessStage: { type: Type.STRING },
                strategicObjective: { type: Type.STRING },
                coreMessage: { type: Type.STRING },
                recommendedAngle: { type: Type.STRING },
                psychologyFramework: { type: Type.STRING },
                ctaObjective: { type: Type.STRING },
                serviceTieIn: { type: Type.STRING },
              },
              required: [
                'targetAudience',
                'audienceProblem',
                'awarenessStage',
                'strategicObjective',
                'coreMessage',
                'recommendedAngle',
                'psychologyFramework',
                'ctaObjective',
                'serviceTieIn',
              ],
            },
            linkedin: { type: Type.STRING },
            x: {
              type: Type.OBJECT,
              properties: {
                ultraShort: { type: Type.STRING },
                expanded: { type: Type.STRING },
              },
              required: ['ultraShort', 'expanded'],
            },
            threads: { type: Type.STRING },
            blog: {
              type: Type.OBJECT,
              properties: {
                seoTitle: { type: Type.STRING },
                metaDescription: { type: Type.STRING },
                primaryKeyword: { type: Type.STRING },
                secondaryKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
                searchIntent: { type: Type.STRING },
                h2Outline: { type: Type.ARRAY, items: { type: Type.STRING } },
                featuredImageConcept: { type: Type.STRING },
                internalLinks: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      anchor: { type: Type.STRING },
                      url: { type: Type.STRING },
                    },
                    required: ['anchor', 'url'],
                  },
                },
                bodyMarkdown: { type: Type.STRING },
              },
              required: [
                'seoTitle',
                'metaDescription',
                'primaryKeyword',
                'secondaryKeywords',
                'searchIntent',
                'h2Outline',
                'featuredImageConcept',
                'bodyMarkdown',
              ],
            },
            evidenceClaims: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.STRING },
                  researchSourceId: { type: Type.STRING },
                  isUnverifiedHypothesis: { type: Type.BOOLEAN },
                },
                required: ['claim', 'isUnverifiedHypothesis'],
              },
            },
          },
          required: ['title', 'centralConcept', 'linkedin', 'x', 'threads', 'blog', 'evidenceClaims'],
        },
      });

      const parsed = safeParseJson<{
        title?: string;
        centralConcept?: CentralContentConcept;
        linkedin?: string;
        x?: { ultraShort?: string; expanded?: string };
        threads?: string;
        blog?: BlogArticleOutput;
        evidenceClaims?: Array<{
          claim: string;
          researchSourceId?: string;
          isUnverifiedHypothesis?: boolean;
        }>;
      }>(aiResp.text || '{}', {});

      if (!parsed.centralConcept || !parsed.linkedin || !parsed.x || !parsed.threads || !parsed.blog) {
        const fallback = buildFallbackGeneration(input, kb, selectedSources);
        return res.json({ ...fallback, fallbackMode: true });
      }

      const sourceMap = new Map(store.researchSources.map((s) => [s.id, s]));
      const todayIso = new Date().toISOString().slice(0, 10);

      const evidenceClaims: EvidenceClaimRef[] = (parsed.evidenceClaims || []).map((ec) => {
        const matched = ec.researchSourceId ? sourceMap.get(ec.researchSourceId) : undefined;
        if (matched && !ec.isUnverifiedHypothesis) {
          return {
            id: createId('ev'),
            claim: ec.claim,
            researchSourceId: matched.id,
            sourceName: matched.sourceName,
            sourceUrl: matched.sourceUrl,
            publicationDate: matched.publicationDate,
            accessedAt: matched.accessedAt,
            relevantFinding: matched.finding,
            primaryOrSecondary: matched.primaryOrSecondary,
            confidence: matched.confidence,
            dataClassification: matched.dataClassification,
            isUnverifiedHypothesis: false,
          };
        }
        return {
          id: createId('ev'),
          claim: ec.claim,
          sourceName: 'Unverified hypothesis (no direct external citation)',
          sourceUrl: '',
          publicationDate: 'N/A',
          accessedAt: todayIso,
          relevantFinding: 'Marked explicitly as editorial hypothesis rather than fabricated citation.',
          primaryOrSecondary: 'secondary',
          confidence: 'low',
          dataClassification: 'hypothesis',
          isUnverifiedHypothesis: true,
        };
      });

      // Build Section Completion Manifest for transparency (never falsely claim complete if truncated)
      const headings =
        Array.isArray(parsed.blog.h2Outline) && parsed.blog.h2Outline.length > 0
          ? parsed.blog.h2Outline
          : ['Overview', 'Key Framework', 'Next Steps'];
      const rawManifest = initializeManifestFromHeadings(headings);
      const bodyLower = (parsed.blog.bodyMarkdown || '').toLowerCase();
      rawManifest.sections = rawManifest.sections.map((sec) => {
        const foundInBody = bodyLower.includes(sec.expectedHeading.toLowerCase());
        return {
          ...sec,
          generationStatus: foundInBody ? 'generated' : 'pending',
          completionStatus: !aiResp.truncated && foundInBody ? 'verified' : 'incomplete',
          savedContent: foundInBody ? parsed.blog!.bodyMarkdown : '',
          wordCount: foundInBody ? parsed.blog!.bodyMarkdown.trim().split(/\s+/).length : 0,
          providerId: aiResp.providerId,
          model: aiResp.model,
        };
      });
      const verifiedManifest = auditLongFormManifestConsistency(rawManifest);

      return res.json({
        title: parsed.title || input.topic,
        centralConcept: parsed.centralConcept,
        platforms: {
          linkedin: parsed.linkedin,
          x: {
            ultraShort: parsed.x.ultraShort || '',
            expanded: parsed.x.expanded || '',
            targetShortChars: xTargetChars,
          },
          threads: parsed.threads,
          blog: {
            ...parsed.blog,
            internalLinks:
              parsed.blog.internalLinks && parsed.blog.internalLinks.length > 0
                ? parsed.blog.internalLinks
                : kb.knownUrls.map((u) => ({ anchor: u.label, url: u.url })),
            blogManifest: verifiedManifest,
          },
        },
        evidenceClaims,
        providerMeta: {
          providerId: aiResp.providerId,
          model: aiResp.model,
          wasFallback: aiResp.wasFallback,
          fallbackChain: aiResp.fallbackChain,
          usage: aiResp.usage,
        },
      });
    } catch (err) {
      return handleMarketingAiError(res, 'Content generation failed', err);
    }
  });

  // 5B. SSE Long-Form Blog Section-Manifest Streaming Endpoint
  app.post('/api/marketing/blog/stream-manifest', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const {
      draftId,
      title,
      centralConcept,
      h2Outline,
      evidenceClaims,
      blogWordTarget,
    } = (req.body || {}) as {
      draftId?: string;
      title?: string;
      centralConcept?: CentralContentConcept;
      h2Outline?: string[];
      evidenceClaims?: EvidenceClaimRef[];
      blogWordTarget?: number;
    };

    if (!title?.trim() || !centralConcept) {
      return res.status(400).json({ error: 'title and centralConcept are required.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const store = loadStore(scope);
      const kb = store.knowledgeBase;
      const outlineHeadings =
        Array.isArray(h2Outline) && h2Outline.length >= 2
          ? h2Outline.slice(0, 8)
          : [
              'Why This Matters for Independent Releases',
              'Core Visual & Audience Mechanics',
              'Practical Step-by-Step Playbook',
              'Common Mistakes to Avoid',
              'Next Step & Action Plan',
            ];

      const manifest = initializeManifestFromHeadings(outlineHeadings);
      sendEvent('manifest_init', { manifest });

      const evidenceText = (evidenceClaims || [])
        .map((c) => `- ${c.claim} [${c.isUnverifiedHypothesis ? 'Editorial hypothesis' : c.sourceName}]`)
        .join('\n');
      const contextSummary = `Brand: ${kb.businessName} (${kb.websiteUrl})\nVoice: ${kb.brandVoice}\nPricing: ${kb.pricingSummary}\nCentral Concept: ${JSON.stringify(centralConcept)}\nEvidence:\n${evidenceText}`;
      const wordsPerSec = Math.round(Math.max(600, Math.min(2500, Number(blogWordTarget) || 1200)) / manifest.sections.length);

      const result = await executeSectionManifestGeneration({
        workspaceId: 'ws-behind-the-release',
        taskType: 'long-form-article',
        manifest,
        documentTitle: title.trim(),
        contextSummary,
        targetWordsPerSection: wordsPerSec,
        stream: true,
        onSectionStart: (index, heading) => sendEvent('section_start', { index, heading }),
        onSectionChunk: (index, heading, chunk, providerId, model) =>
          sendEvent('chunk', { index, heading, chunk, providerId, model }),
        onSectionDone: (item, updatedManifest) => {
          if (draftId) {
            const latestStore = loadStore(scope);
            const idx = latestStore.drafts.findIndex((d) => d.id === draftId);
            if (idx !== -1 && latestStore.drafts[idx].platforms?.blog) {
              latestStore.drafts[idx] = {
                ...latestStore.drafts[idx],
                platforms: {
                  ...latestStore.drafts[idx].platforms,
                  blog: {
                    ...latestStore.drafts[idx].platforms.blog,
                    blogManifest: updatedManifest,
                  },
                },
                updatedAt: new Date().toISOString(),
              };
              saveStore(latestStore, scope);
            }
          }
          sendEvent('section_done', { section: item, manifest: updatedManifest });
        },
        onFallback: (from, to, reason) => sendEvent('fallback', { from, to, reason }),
      });

      sendEvent('complete', {
        manifest: result.manifest,
        bodyMarkdown: result.markdown,
        providerId: result.lastProviderId,
        model: result.lastModel,
        wasFallback: result.wasFallback,
      });
      res.end();
    } catch (err) {
      sendEvent('error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.end();
    }
  });

  // 5C. Incomplete-Section Continuation / Recovery (No Duplicate Headings)
  app.post('/api/marketing/blog/continue-manifest', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const {
      title,
      centralConcept,
      manifest,
      evidenceClaims,
      blogWordTarget,
    } = (req.body || {}) as {
      title?: string;
      centralConcept?: CentralContentConcept;
      manifest?: LongFormDocumentManifest;
      evidenceClaims?: EvidenceClaimRef[];
      blogWordTarget?: number;
    };

    if (!title?.trim() || !centralConcept || !manifest || !Array.isArray(manifest.sections)) {
      return res.status(400).json({ error: 'title, centralConcept, and manifest.sections are required.' });
    }

    try {
      const store = loadStore(scope);
      const kb = store.knowledgeBase;
      const evidenceText = (evidenceClaims || [])
        .map((c) => `- ${c.claim} [${c.isUnverifiedHypothesis ? 'Editorial hypothesis' : c.sourceName}]`)
        .join('\n');
      const contextSummary = `Brand: ${kb.businessName} (${kb.websiteUrl})\nVoice: ${kb.brandVoice}\nPricing: ${kb.pricingSummary}\nCentral Concept: ${JSON.stringify(centralConcept)}\nEvidence:\n${evidenceText}`;
      const wordsPerSec = Math.round(Math.max(600, Math.min(2500, Number(blogWordTarget) || 1200)) / Math.max(1, manifest.sections.length));

      const result = await executeSectionManifestGeneration({
        workspaceId: 'ws-behind-the-release',
        taskType: 'long-form-article',
        manifest,
        documentTitle: title.trim(),
        contextSummary,
        targetWordsPerSection: wordsPerSec,
        stream: false,
      });

      return res.json({
        manifest: result.manifest,
        bodyMarkdown: result.markdown,
        providerId: result.lastProviderId,
        model: result.lastModel,
        wasFallback: result.wasFallback,
      });
    } catch (err) {
      return handleMarketingAiError(res, 'Blog continuation failed', err);
    }
  });

  // 6. Regenerate SINGLE Platform Output (Preserves Central Content Concept Unchanged)
  app.post('/api/marketing/regenerate-platform', mktGuard, aiGenerationLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const {
      platform,
      centralConcept,
      evidenceClaims,
      tone,
      xTargetChars,
      blogWordTarget,
      instruction,
    } = (req.body || {}) as {
      platform: 'linkedin' | 'x' | 'threads' | 'blog';
      centralConcept: CentralContentConcept;
      evidenceClaims?: EvidenceClaimRef[];
      tone?: string;
      xTargetChars?: number;
      blogWordTarget?: number;
      instruction?: string;
    };

    if (!platform || !centralConcept) {
      return res.status(400).json({ error: 'platform and centralConcept are required.' });
    }

    const store = loadStore(scope);
    const kb = store.knowledgeBase;
    const shortChars = Math.max(25, Math.min(280, Number(xTargetChars) || 50));
    const targetWords = Math.max(600, Math.min(2400, Number(blogWordTarget) || 1100));

    try {
      const evidenceText = (evidenceClaims || [])
        .map((c) => `- ${c.claim} [${c.isUnverifiedHypothesis ? 'Unverified hypothesis' : c.sourceName}]`)
        .join('\n');

      if (platform === 'linkedin') {
        const aiResp = await executeAiTask({
          workspaceId: 'ws-behind-the-release',
          taskType: 'marketing-platform',
          responseFormat: 'json',
          prompt: `Rewrite ONLY the LinkedIn post while keeping the central concept, core facts, and CTA goal strictly unchanged.
Central Concept: ${JSON.stringify(centralConcept)}
Verified Context:\n${evidenceText}
Voice: ${kb.brandVoice} (${kb.websiteUrl})
Tone: ${tone || 'Credible, conversational studio authority'}
${instruction ? `Refinement note: ${instruction}` : ''}

Return JSON { "linkedin": "..." }`,
          geminiJsonSchema: {
            type: Type.OBJECT,
            properties: { linkedin: { type: Type.STRING } },
            required: ['linkedin'],
          },
        });
        const parsed = safeParseJson<{ linkedin: string }>(aiResp.text || '{}', { linkedin: '' });
        return res.json({
          platform: 'linkedin',
          data: parsed.linkedin,
          providerMeta: { providerId: aiResp.providerId, model: aiResp.model, wasFallback: aiResp.wasFallback },
        });
      }

      if (platform === 'x') {
        const aiResp = await executeAiTask({
          workspaceId: 'ws-behind-the-release',
          taskType: 'marketing-platform',
          responseFormat: 'json',
          prompt: `Rewrite ONLY the X (Twitter) outputs while keeping the central concept strictly unchanged.
Central Concept: ${JSON.stringify(centralConcept)}
Target length for ultraShort: ~${shortChars} characters (crisp single thought).
Also provide "expanded" (~180-280 chars with CTA to ${kb.websiteUrl}).
${instruction ? `Refinement note: ${instruction}` : ''}

Return JSON { "ultraShort": "...", "expanded": "..." }`,
          geminiJsonSchema: {
            type: Type.OBJECT,
            properties: {
              ultraShort: { type: Type.STRING },
              expanded: { type: Type.STRING },
            },
            required: ['ultraShort', 'expanded'],
          },
        });
        const parsed = safeParseJson<{ ultraShort: string; expanded: string }>(aiResp.text || '{}', {
          ultraShort: '',
          expanded: '',
        });
        return res.json({
          platform: 'x',
          data: {
            ultraShort: parsed.ultraShort,
            expanded: parsed.expanded,
            targetShortChars: shortChars,
          },
          providerMeta: { providerId: aiResp.providerId, model: aiResp.model, wasFallback: aiResp.wasFallback },
        });
      }

      if (platform === 'threads') {
        const aiResp = await executeAiTask({
          workspaceId: 'ws-behind-the-release',
          taskType: 'marketing-platform',
          responseFormat: 'json',
          prompt: `Rewrite ONLY the Threads post while keeping the central concept strictly unchanged.
Make it conversational, natural, short engaging lines with a relatable observation and conversational CTA—NOT formal like LinkedIn.
Central Concept: ${JSON.stringify(centralConcept)}
${instruction ? `Refinement note: ${instruction}` : ''}

Return JSON { "threads": "..." }`,
          geminiJsonSchema: {
            type: Type.OBJECT,
            properties: { threads: { type: Type.STRING } },
            required: ['threads'],
          },
        });
        const parsed = safeParseJson<{ threads: string }>(aiResp.text || '{}', { threads: '' });
        return res.json({
          platform: 'threads',
          data: parsed.threads,
          providerMeta: { providerId: aiResp.providerId, model: aiResp.model, wasFallback: aiResp.wasFallback },
        });
      }

      // blog
      const aiResp = await executeAiTask({
        workspaceId: 'ws-behind-the-release',
        taskType: 'long-form-article',
        responseFormat: 'json',
        maxOutputTokens: 8192,
        prompt: `Rewrite ONLY the website blog article (~${targetWords} words) while keeping the central concept strictly unchanged.
Central Concept: ${JSON.stringify(centralConcept)}
Evidence Context:\n${evidenceText}
Known URLs: ${kb.knownUrls.map((u) => `${u.label}: ${u.url}`).join(' | ')}
Pricing truth: ${kb.pricingSummary}
${instruction ? `Refinement note: ${instruction}` : ''}

Include SEO title, meta description, primaryKeyword, secondaryKeywords, searchIntent, h2Outline, featuredImageConcept, internalLinks (using only known URLs), and full H2/H3 bodyMarkdown. Return strictly JSON.`,
        geminiJsonSchema: {
          type: Type.OBJECT,
          properties: {
            seoTitle: { type: Type.STRING },
            metaDescription: { type: Type.STRING },
            primaryKeyword: { type: Type.STRING },
            secondaryKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            searchIntent: { type: Type.STRING },
            h2Outline: { type: Type.ARRAY, items: { type: Type.STRING } },
            featuredImageConcept: { type: Type.STRING },
            internalLinks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  anchor: { type: Type.STRING },
                  url: { type: Type.STRING },
                },
                required: ['anchor', 'url'],
              },
            },
            bodyMarkdown: { type: Type.STRING },
          },
          required: [
            'seoTitle',
            'metaDescription',
            'primaryKeyword',
            'secondaryKeywords',
            'searchIntent',
            'h2Outline',
            'featuredImageConcept',
            'bodyMarkdown',
          ],
        },
      });
      const parsed = safeParseJson<BlogArticleOutput>(aiResp.text || '{}', {
        seoTitle: '',
        metaDescription: '',
        primaryKeyword: '',
        secondaryKeywords: [],
        searchIntent: '',
        h2Outline: [],
        featuredImageConcept: '',
        internalLinks: [],
        bodyMarkdown: '',
      });
      return res.json({
        platform: 'blog',
        data: parsed,
        providerMeta: { providerId: aiResp.providerId, model: aiResp.model, wasFallback: aiResp.wasFallback },
      });
    } catch (err) {
      return handleMarketingAiError(res, 'Regeneration failed', err);
    }
  });

  // 7. Content Library Drafts CRUD (Strictly isolated from Behind The Release scheduler)
  app.get('/api/marketing/drafts', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const store = loadStore(scope);
    return res.json({ drafts: store.drafts });
  });

  app.post('/api/marketing/drafts', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const body = req.body as Partial<MarketingDraft>;
    if (!body.title?.trim() || !body.centralConcept || !body.platforms) {
      return res.status(400).json({ error: 'title, centralConcept, and platforms are required.' });
    }
    const store = loadStore(scope);
    const nowIso = new Date().toISOString();
    const existingIdx = body.id ? store.drafts.findIndex((d) => d.id === body.id) : -1;
    const assignedId = existingIdx !== -1 ? store.drafts[existingIdx].id : createId('mdraft');
    const draft: MarketingDraft = {
      id: assignedId,
      title: body.title.trim().slice(0, 240),
      status: body.status || 'draft',
      targetAudience: body.targetAudience || '',
      serviceOffer: body.serviceOffer || '',
      objective: body.objective || '',
      awarenessStage: body.awarenessStage || '',
      contentCategory: body.contentCategory || '',
      topic: body.topic || body.title,
      tone: body.tone || '',
      ctaObjective: body.ctaObjective || '',
      researchDepth: body.researchDepth || 'standard',
      xTargetChars: Number(body.xTargetChars) || 50,
      blogWordTarget: Number(body.blogWordTarget) || 1100,
      centralConcept: body.centralConcept,
      platforms: body.platforms,
      evidenceClaims: Array.isArray(body.evidenceClaims) ? body.evidenceClaims : [],
      createdAt: existingIdx !== -1 ? store.drafts[existingIdx].createdAt : nowIso,
      updatedAt: nowIso,
    };

    if (existingIdx !== -1) {
      store.drafts[existingIdx] = draft;
    } else {
      store.drafts.unshift(draft);
    }
    saveStore(store, scope);
    return res.json({ draft });
  });

  app.put('/api/marketing/drafts/:id', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const id = String(req.params.id || '');
    const store = loadStore(scope);
    const idx = store.drafts.findIndex((d) => d.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Marketing draft not found.' });
    }
    const existing = store.drafts[idx];
    const body = (req.body || {}) as Partial<MarketingDraft>;
    const updated: MarketingDraft = {
      ...existing,
      ...(body.title !== undefined ? { title: String(body.title).trim().slice(0, 240) || existing.title } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.targetAudience !== undefined ? { targetAudience: body.targetAudience } : {}),
      ...(body.serviceOffer !== undefined ? { serviceOffer: String(body.serviceOffer).slice(0, 200) } : {}),
      ...(body.objective !== undefined ? { objective: String(body.objective).slice(0, 600) } : {}),
      ...(body.awarenessStage !== undefined ? { awarenessStage: body.awarenessStage } : {}),
      ...(body.contentCategory !== undefined ? { contentCategory: body.contentCategory } : {}),
      ...(body.topic !== undefined ? { topic: String(body.topic).slice(0, 500) } : {}),
      ...(body.tone !== undefined ? { tone: String(body.tone).slice(0, 200) } : {}),
      ...(body.ctaObjective !== undefined ? { ctaObjective: String(body.ctaObjective).slice(0, 400) } : {}),
      ...(body.centralConcept !== undefined ? { centralConcept: body.centralConcept } : {}),
      ...(body.platforms !== undefined ? { platforms: body.platforms } : {}),
      ...(Array.isArray(body.evidenceClaims) ? { evidenceClaims: body.evidenceClaims } : {}),
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    store.drafts[idx] = updated;
    saveStore(store, scope);
    return res.json({ draft: updated });
  });

  app.delete('/api/marketing/drafts/:id', mktGuard, (req: AuthenticatedRequest, res: Response) => {
    const scope = req.operatorContext?.ownerScopeKey || 'local-operator';
    const id = String(req.params.id || '');
    const store = loadStore(scope);
    store.drafts = store.drafts.filter((d) => d.id !== id);
    saveStore(store, scope);
    return res.json({ ok: true });
  });
}
