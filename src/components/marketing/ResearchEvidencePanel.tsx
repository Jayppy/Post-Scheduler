import React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
import type { EvidenceClaimRef } from '../../types/marketing';

interface ResearchEvidencePanelProps {
  claims: EvidenceClaimRef[];
}

export const ResearchEvidencePanel: React.FC<ResearchEvidencePanelProps> = ({ claims }) => {
  return (
    <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-zinc-300" />
            <span>Research &amp; Sources Verification Panel</span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Every factual claim is traced to an explicit source or marked honestly as an unverified hypothesis.
          </p>
        </div>
        <span className="font-mono text-xs text-zinc-400 tabular-nums">{claims.length} claim(s)</span>
      </div>

      {claims.length === 0 ? (
        <div className="p-6 text-xs text-zinc-500">
          Generate a marketing concept to inspect mapped source evidence and claim verification.
        </div>
      ) : (
        <div className="divide-y divide-zinc-800/70">
          {claims.map((claim) => (
            <div key={claim.id} className="p-5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {claim.isUnverifiedHypothesis ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>Unverified Hypothesis</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Source Verified</span>
                    </span>
                  )}
                  <span className="text-zinc-600">·</span>
                  <span className="text-[11px] font-mono text-zinc-400 uppercase">
                    {claim.primaryOrSecondary}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    Confidence: {claim.confidence}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    Class: {claim.dataClassification}
                  </span>
                </div>
                {claim.sourceUrl && (
                  <a
                    href={claim.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-zinc-200 underline hover:text-white"
                  >
                    <span>Source Link</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>

              <p className="text-xs font-medium text-zinc-100 leading-relaxed">{claim.claim}</p>

              <div className="text-[11px] text-zinc-400 space-y-1">
                <div>
                  <span className="text-zinc-500">Source:</span>{' '}
                  <span className="text-zinc-200">{claim.sourceName}</span>
                  <span className="mx-2 text-zinc-600">·</span>
                  <span className="text-zinc-500">Published:</span>{' '}
                  <span className="font-mono">{claim.publicationDate}</span>
                  <span className="mx-2 text-zinc-600">·</span>
                  <span className="text-zinc-500">Accessed:</span>{' '}
                  <span className="font-mono">{claim.accessedAt}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Relevant Finding:</span> {claim.relevantFinding}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
