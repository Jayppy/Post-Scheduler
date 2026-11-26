import type {
  AiProviderId,
  AiTaskType,
  BusinessWorkspaceId,
  LongFormDocumentManifest,
  SectionCompletionManifestItem,
} from '../../src/types/aiProviders';
import { executeAiTask } from './providerManager';
import type { AiProviderAdapter } from './types';

export function normalizeHeadingSlug(heading: string): string {
  return (heading || '')
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function countWords(text: string): number {
  const cleaned = (text || '').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

function stripLeadingDuplicateHeading(body: string, expectedHeading: string): string {
  const lines = body.trim().split('\n');
  if (lines.length === 0) return '';
  const first = lines[0].trim();
  const slugExpected = normalizeHeadingSlug(expectedHeading);
  if (/^#{1,4}\s+/.test(first) && normalizeHeadingSlug(first) === slugExpected) {
    return lines.slice(1).join('\n').trim();
  }
  return body.trim();
}

export function verifySectionCompleteness(opts: {
  content: string;
  truncated?: boolean;
  minWords?: number;
}): { complete: boolean; issues: string[]; wordCount: number } {
  const text = (opts.content || '').trim();
  const minWords = opts.minWords ?? 40;
  const wordCount = countWords(text);
  const issues: string[] = [];

  if (!text) {
    issues.push('Section body is empty.');
    return { complete: false, issues, wordCount: 0 };
  }
  if (opts.truncated) {
    issues.push('Upstream provider hit maxOutputTokens stop limit before completing this section.');
  }
  if (wordCount < minWords) {
    issues.push(`Section word count (${wordCount}) is below expected minimum (${minWords} words).`);
  }

  // Check balanced markdown code fences
  const fenceMatches = text.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    issues.push('Unclosed markdown code fence detected.');
  }

  // Check dangling incomplete ending (mid-sentence cutoff)
  const lastNonEmpty = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || '';
  const endsCleanly = /[.!?:"')\]`]$/.test(lastNonEmpty);
  const danglingTail = /\b(and|or|but|because|with|for|the|to|of|in|as|which|that)[,:]?$/i.test(lastNonEmpty);
  if (!endsCleanly || danglingTail) {
    issues.push('Trailing sentence appears cut off mid-thought without terminal punctuation.');
  }

  return {
    complete: issues.length === 0,
    issues,
    wordCount,
  };
}

export function initializeManifestFromHeadings(headings: string[]): LongFormDocumentManifest {
  const duplicateHeadingsDetected: string[] = [];
  const seen = new Set<string>();
  const cleanSections: SectionCompletionManifestItem[] = [];

  for (const rawHeading of headings) {
    const heading = rawHeading.replace(/^#+\s*/, '').trim();
    if (!heading) continue;
    const slug = normalizeHeadingSlug(heading);
    if (seen.has(slug)) {
      duplicateHeadingsDetected.push(heading);
      continue;
    }
    seen.add(slug);
    cleanSections.push({
      index: cleanSections.length,
      expectedHeading: heading,
      normalizedSlug: slug,
      generationStatus: 'pending',
      completionStatus: 'incomplete',
      savedContent: '',
      wordCount: 0,
    });
  }

  return {
    status: 'incomplete',
    totalExpectedSections: cleanSections.length,
    completedSections: 0,
    duplicateHeadingsDetected,
    consistencyIssues:
      duplicateHeadingsDetected.length > 0
        ? [`Removed duplicate outline heading(s): ${duplicateHeadingsDetected.join(', ')}`]
        : [],
    sections: cleanSections,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function assembleMarkdownFromManifest(manifest: LongFormDocumentManifest): string {
  const seenSlugs = new Set<string>();
  const parts: string[] = [];
  for (const sec of manifest.sections) {
    if (!sec.savedContent.trim()) continue;
    if (seenSlugs.has(sec.normalizedSlug)) continue; // Anti-duplication safety on assembly
    seenSlugs.add(sec.normalizedSlug);
    parts.push(`## ${sec.expectedHeading}\n\n${sec.savedContent.trim()}`);
  }
  return parts.join('\n\n').trim();
}

export function auditLongFormManifestConsistency(manifest: LongFormDocumentManifest): LongFormDocumentManifest {
  const seen = new Set<string>();
  const duplicates: string[] = [...manifest.duplicateHeadingsDetected];
  const consistencyIssues: string[] = [];
  let activeDuplicatesCount = 0;
  let verifiedCount = 0;

  const updatedSections = manifest.sections.map((sec) => {
    if (seen.has(sec.normalizedSlug)) {
      activeDuplicatesCount++;
      if (!duplicates.includes(sec.expectedHeading)) {
        duplicates.push(sec.expectedHeading);
      }
      consistencyIssues.push(`Duplicate heading detected: "${sec.expectedHeading}"`);
    }
    seen.add(sec.normalizedSlug);

    if (sec.completionStatus === 'verified') {
      const recheck = verifySectionCompleteness({ content: sec.savedContent, minWords: 30 });
      if (!recheck.complete) {
        consistencyIssues.push(`Section "${sec.expectedHeading}": ${recheck.issues.join(' ')}`);
        return {
          ...sec,
          completionStatus: 'incomplete' as const,
        };
      }
      verifiedCount++;
    } else {
      consistencyIssues.push(`Section "${sec.expectedHeading}" is ${sec.completionStatus}.`);
    }
    return sec;
  });

  const allComplete =
    updatedSections.length > 0 && verifiedCount === updatedSections.length && activeDuplicatesCount === 0;

  return {
    ...manifest,
    status: allComplete ? 'verified' : 'incomplete',
    totalExpectedSections: updatedSections.length,
    completedSections: verifiedCount,
    duplicateHeadingsDetected: duplicates,
    consistencyIssues,
    sections: updatedSections,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export interface GenerateSectionsOptions {
  workspaceId: BusinessWorkspaceId;
  taskType: Extract<AiTaskType, 'long-form-article' | 'sales-proposal-longform'>;
  manifest: LongFormDocumentManifest;
  documentTitle: string;
  contextSummary: string;
  targetWordsPerSection?: number;
  stream?: boolean;
  maxOutputTokensPerSection?: number;
  mockAdapterOverride?: Partial<Record<AiProviderId, AiProviderAdapter>>;
  onSectionStart?: (index: number, heading: string) => void;
  onSectionChunk?: (index: number, heading: string, chunk: string, providerId: AiProviderId, model: string) => void;
  onSectionDone?: (item: SectionCompletionManifestItem, manifest: LongFormDocumentManifest) => void;
  onFallback?: (from: AiProviderId, to: AiProviderId, reason: string) => void;
}

/**
 * Generates or resumes a multi-section long-form document from the first incomplete section
 * without repeating or overwriting already verified sections.
 */
export async function executeSectionManifestGeneration(
  opts: GenerateSectionsOptions
): Promise<{
  manifest: LongFormDocumentManifest;
  markdown: string;
  lastProviderId?: AiProviderId;
  lastModel?: string;
  wasFallback: boolean;
}> {
  let manifest: LongFormDocumentManifest = {
    ...opts.manifest,
    sections: opts.manifest.sections.map((s) => ({ ...s })),
    duplicateHeadingsDetected: [...opts.manifest.duplicateHeadingsDetected],
    consistencyIssues: [...opts.manifest.consistencyIssues],
  };

  let lastProviderId: AiProviderId | undefined;
  let lastModel: string | undefined;
  let wasFallback = false;

  const targetWords = Math.max(120, Math.min(600, opts.targetWordsPerSection || 240));

  for (let i = 0; i < manifest.sections.length; i++) {
    const sec = manifest.sections[i];
    if (sec.completionStatus === 'verified' && sec.savedContent.trim()) {
      // Already completed & verified — preserve untouched!
      continue;
    }

    opts.onSectionStart?.(i, sec.expectedHeading);
    sec.generationStatus = 'streaming';

    const priorCompleted = manifest.sections
      .slice(0, i)
      .filter((prev) => prev.savedContent.trim().length > 0)
      .map((prev) => `- ${prev.expectedHeading}: ${prev.savedContent.trim().slice(0, 180)}...`)
      .join('\n');

    const upcomingHeadings = manifest.sections
      .slice(i + 1)
      .map((nxt) => nxt.expectedHeading)
      .join(' | ');

    const sectionPrompt = `Write ONLY the body paragraphs for ONE section of "${opts.documentTitle}".

CURRENT SECTION TO WRITE: "${sec.expectedHeading}"
TARGET LENGTH: ~${targetWords} words (complete sentences and clean ending).

CONTEXT & VERIFIED FACTS:
${opts.contextSummary}

${priorCompleted ? `ALREADY COMPLETED SECTIONS (DO NOT REPEAT OR SUMMARIZE THESE HEADINGS):\n${priorCompleted}` : 'This is the opening section.'}
${upcomingHeadings ? `UPCOMING SECTIONS (leave those topics for later sections): ${upcomingHeadings}` : 'This is the final section — conclude cleanly.'}

STRICT RULES:
1. Do NOT output the "## ${sec.expectedHeading}" heading itself or any other section heading from above — output only clean markdown body content for this single section.
2. End on a complete, grammatically finished sentence.
3. Never invent citations, client testimonials, case study metrics, or fixed prices not provided in Context.`;

    try {
      const res = await executeAiTask({
        workspaceId: opts.workspaceId,
        taskType: opts.taskType,
        prompt: sectionPrompt,
        maxOutputTokens: opts.maxOutputTokensPerSection || 1600,
        stream: opts.stream !== false,
        mockAdapterOverride: opts.mockAdapterOverride,
        onStreamChunk: (chunk, pid, mdl) => {
          opts.onSectionChunk?.(i, sec.expectedHeading, chunk, pid, mdl);
        },
        onFallbackSwitch: (from, to, reason) => {
          wasFallback = true;
          opts.onFallback?.(from, to, reason);
        },
      });

      lastProviderId = res.providerId;
      lastModel = res.model;
      if (res.wasFallback) wasFallback = true;

      const cleanedBody = stripLeadingDuplicateHeading(res.text, sec.expectedHeading);

      // Guard against model accidentally duplicating an earlier completed heading inside the body
      const earlierHeadings = manifest.sections
        .slice(0, i)
        .map((p) => p.expectedHeading.toLowerCase());
      const embeddedDup = earlierHeadings.find((eh) =>
        cleanedBody.toLowerCase().includes(`## ${eh}`)
      );
      if (embeddedDup) {
        manifest.duplicateHeadingsDetected.push(embeddedDup);
      }

      const check = verifySectionCompleteness({
        content: cleanedBody,
        truncated: res.truncated,
        minWords: 35,
      });

      sec.savedContent = cleanedBody;
      sec.wordCount = check.wordCount;
      sec.providerId = res.providerId;
      sec.model = res.model;
      sec.tokenCount = res.usage.totalTokens;
      sec.generationStatus = 'generated';
      sec.completionStatus = check.complete && !embeddedDup ? 'verified' : 'incomplete';
      sec.completedAt = check.complete ? new Date().toISOString() : undefined;
      sec.error = check.issues.length > 0 ? check.issues.join(' ') : undefined;

      manifest = auditLongFormManifestConsistency(manifest);
      opts.onSectionDone?.({ ...sec }, manifest);
    } catch (err) {
      sec.generationStatus = 'failed';
      sec.completionStatus = 'incomplete';
      sec.error = err instanceof Error ? err.message : String(err);
      manifest = auditLongFormManifestConsistency(manifest);
      opts.onSectionDone?.({ ...sec }, manifest);
      // Stop on hard failure while preserving every completed section!
      break;
    }
  }

  manifest = auditLongFormManifestConsistency(manifest);
  return {
    manifest,
    markdown: assembleMarkdownFromManifest(manifest),
    lastProviderId,
    lastModel,
    wasFallback,
  };
}
