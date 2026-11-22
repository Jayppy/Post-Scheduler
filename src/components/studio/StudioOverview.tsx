import React from 'react';
import {
  ArrowUpRight,
  Clapperboard,
  FolderKanban,
  History,
  Layers,
  Palette,
  Plus,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';

export const StudioOverview: React.FC = () => {
  const {
    activeWorkspace,
    workspaceProjects,
    workspaceThemes,
    workspaceExports,
    workspaceMedia,
    setStudioSubView,
    setActiveProjectId,
    openProjectInEditor,
  } = useStudio();

  const carouselCount = workspaceProjects.filter((p) => p.type === 'carousel').length;
  const reelCount = workspaceProjects.filter((p) => p.type === 'reel').length;

  return (
    <div className="space-y-8">
      {/* Studio Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="text-xs text-zinc-400 mb-1.5">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>{activeWorkspace.tagline}</span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-zinc-100">
            AI Creative Studio
          </h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">
            Produce editorial carousels and short-form vertical Reels & Shorts tailored to{' '}
            <span className="text-zinc-200">{activeWorkspace.name}</span>—with browser-native rendering and direct Social Hub publishing.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              setStudioSubView('carousel-creator');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Carousel</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              setStudioSubView('reels-studio');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-zinc-700 bg-[#141418] text-zinc-100 hover:border-zinc-500 text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <Clapperboard className="w-3.5 h-3.5" />
            <span>New Reel / Short</span>
          </button>
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800/80">
          <div className="text-xs text-zinc-400">Carousel Projects</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {carouselCount}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800/80">
          <div className="text-xs text-zinc-400">Reels & Shorts</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {reelCount}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800/80">
          <div className="text-xs text-zinc-400">Design Themes</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {workspaceThemes.length}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800/80">
          <div className="text-xs text-zinc-400">Exports & Media</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {workspaceExports.length} <span className="text-xs font-normal text-zinc-500">/ {workspaceMedia.length} assets</span>
          </div>
        </div>
      </div>

      {/* Primary Production Suite Launchers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col justify-between gap-6">
          <div>
            <div className="flex items-center justify-between">
              <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200">
                <Layers className="w-5 h-5" />
              </div>
              <span className="text-xs font-mono text-zinc-500">1080×1350 · 1080×1080 · 1080×1920</span>
            </div>
            <h2 className="text-lg font-semibold text-zinc-100 mt-4">AI Carousel Creator</h2>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
              Build Content-First carousels from pasted notes, TXT, PDF, or DOCX files—or generate complete Topic-First narratives with Gemini. Edit every text frame live and export crisp PNGs or ordered ZIPs.
            </p>
          </div>
          <div className="flex items-center justify-between pt-4 border-t border-zinc-800/80">
            <span className="text-xs text-zinc-400">7 Music & Editorial Themes</span>
            <button
              type="button"
              onClick={() => {
                setActiveProjectId(null);
                setStudioSubView('carousel-creator');
              }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-100 hover:text-white"
            >
              <span>Launch Carousel Studio</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col justify-between gap-6">
          <div>
            <div className="flex items-center justify-between">
              <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200">
                <Clapperboard className="w-5 h-5" />
              </div>
              <span className="text-xs font-mono text-zinc-500">9:16 · 1080×1920 · 30 FPS · ≤60s</span>
            </div>
            <h2 className="text-lg font-semibold text-zinc-100 mt-4">AI Reels & Shorts Studio</h2>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
              Hybrid AI editing pipeline: upload video clips, imagery, and audio tracks; approve a Gemini storyboard grounded in your real media; edit on a multi-track timeline with subtitles and motion graphics; export MP4 in-browser.
            </p>
          </div>
          <div className="flex items-center justify-between pt-4 border-t border-zinc-800/80">
            <span className="text-xs text-zinc-400">Instagram Reels & YouTube Shorts Profiles</span>
            <button
              type="button"
              onClick={() => {
                setActiveProjectId(null);
                setStudioSubView('reels-studio');
              }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-100 hover:text-white"
            >
              <span>Launch Reels Studio</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Recent Workspace Projects & Quick Links */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderKanban className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Recent Creative Projects</h3>
            </div>
            <button
              type="button"
              onClick={() => setStudioSubView('creative-projects')}
              className="text-xs text-zinc-400 hover:text-zinc-100"
            >
              View All
            </button>
          </div>

          {workspaceProjects.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-xs text-zinc-400">
                No creative projects saved in {activeWorkspace.name} yet.
              </p>
              <button
                type="button"
                onClick={() => setStudioSubView('carousel-creator')}
                className="mt-3 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
              >
                Create First Carousel
              </button>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/70">
              {workspaceProjects.slice(0, 5).map((proj) => (
                <div
                  key={proj.id}
                  className="px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-zinc-900/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-100 truncate">{proj.title}</div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 flex items-center gap-2">
                      <span className="capitalize">{proj.type}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{proj.status.replace('-', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(proj.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openProjectInEditor(proj)}
                    className="px-3 py-1.5 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-200 whitespace-nowrap"
                  >
                    Open Editor
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl bg-[#111114] border border-zinc-800 p-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Studio Utilities</h3>
            <p className="text-xs text-zinc-400 mt-1">
              Manage visual systems and inspect exported files for {activeWorkspace.name}.
            </p>
          </div>
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => setStudioSubView('design-themes')}
              className="w-full p-3 rounded-lg border border-zinc-800 bg-[#0d0d10] hover:border-zinc-700 flex items-center justify-between text-left transition-colors"
            >
              <span className="flex items-center gap-2.5">
                <Palette className="w-4 h-4 text-zinc-300" />
                <span>
                  <span className="block text-xs font-semibold text-zinc-100">Design Themes Library</span>
                  <span className="block text-[11px] text-zinc-400">7 presets + custom brand themes</span>
                </span>
              </span>
              <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
            </button>

            <button
              type="button"
              onClick={() => setStudioSubView('export-history')}
              className="w-full p-3 rounded-lg border border-zinc-800 bg-[#0d0d10] hover:border-zinc-700 flex items-center justify-between text-left transition-colors"
            >
              <span className="flex items-center gap-2.5">
                <History className="w-4 h-4 text-zinc-300" />
                <span>
                  <span className="block text-xs font-semibold text-zinc-100">Export History</span>
                  <span className="block text-[11px] text-zinc-400">
                    {workspaceExports.length} recorded exports
                  </span>
                </span>
              </span>
              <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
            </button>
          </div>

          <div className="pt-3 border-t border-zinc-800/80">
            <div className="text-[11px] font-medium text-zinc-400 mb-1">Active Brand Voice</div>
            <p className="text-xs text-zinc-300 leading-relaxed">{activeWorkspace.brandVoice}</p>
          </div>
        </div>
      </div>
    </div>
  );
};
