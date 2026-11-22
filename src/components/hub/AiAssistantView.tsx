import React, { useState } from 'react';
import { Copy, Loader2, PenSquare, Sparkles } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { aiClient, AiApiError } from '../../services/aiClient';

export const AiAssistantView: React.FC = () => {
  const { activeWorkspace, openPostComposerWithDraft, notify } = useStudio();

  const [prompt, setPrompt] = useState('');
  const [platform, setPlatform] = useState('Instagram Carousel');
  const [format, setFormat] = useState('Caption + Opening Hooks + Hashtags');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<{
    headline: string;
    caption: string;
    hooks: string[];
    hashtags: string[];
    cta?: string;
  } | null>(null);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setIsLoading(true);
    try {
      const res = await aiClient.generateSocialCopy({
        prompt,
        format,
        platform,
        workspaceName: activeWorkspace.name,
        brandVoice: activeWorkspace.brandVoice,
      });
      setResult(res);
    } catch (err) {
      notify(
        'warning',
        'Gemini assistant unavailable',
        err instanceof AiApiError ? err.message : 'Unable to generate copy.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800/80 pb-5">
        <div className="text-xs text-zinc-400 mb-1">
          <span>{activeWorkspace.name}</span>
          <span className="mx-2 text-zinc-600">·</span>
          <span>Gemini AI Content Assistant</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Brand Copy & Hook Generator</h1>
        <p className="text-xs text-zinc-400 mt-1">
          Generates captions, hooks, and release copy anchored to {activeWorkspace.name}&apos;s brand voice.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleGenerate}
          className="lg:col-span-5 p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
            >
              <option>Instagram Carousel</option>
              <option>Instagram Reels</option>
              <option>YouTube Shorts</option>
              <option>Press / Campaign Note</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Output Focus</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
            >
              <option>Caption + Opening Hooks + Hashtags</option>
              <option>Single Release Announcement</option>
              <option>Educational Breakdown Thread</option>
              <option>Agency Case Study Summary</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Brief / Topic</label>
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the release, artist milestone, or industry insight..."
              className="w-full px-3 py-2.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>Generate Copy</span>
          </button>
        </form>

        <div className="lg:col-span-7 p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
          {result ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-mono text-zinc-400">GENERATED CONCEPT</div>
                  <h2 className="text-lg font-bold text-zinc-100 mt-0.5">{result.headline}</h2>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    openPostComposerWithDraft({
                      title: result.headline,
                      platform:
                        platform === 'YouTube Shorts'
                          ? 'youtube-shorts'
                          : platform === 'Instagram Reels'
                            ? 'instagram-reel'
                            : 'instagram-carousel',
                      caption: `${result.caption}${result.cta ? `\n\n${result.cta}` : ''}`,
                      hashtags: result.hashtags,
                      mediaAssetIds: [],
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold shrink-0"
                >
                  <PenSquare className="w-3.5 h-3.5" />
                  <span>Send to Post Composer</span>
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-zinc-300">Caption</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(result.caption);
                      notify('info', 'Caption copied');
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </button>
                </div>
                <p className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                  {result.caption}
                </p>
              </div>

              <div>
                <div className="text-xs font-semibold text-zinc-300 mb-2">Alternative Opening Hooks</div>
                <div className="space-y-1.5">
                  {result.hooks.map((h, i) => (
                    <div
                      key={i}
                      className="p-2.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-300"
                    >
                      {i + 1}. {h}
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-xs text-zinc-400 font-mono">{result.hashtags.join(' ')}</div>
            </>
          ) : (
            <div className="py-16 text-center text-xs text-zinc-500">
              Submit a brief on the left to generate workspace-aligned social copy.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
