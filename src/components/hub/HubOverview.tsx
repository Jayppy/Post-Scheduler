import React from 'react';
import {
  ArrowUpRight,
  Calendar,
  Clapperboard,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Megaphone,
  PenSquare,
  Sparkles,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';

export const HubOverview: React.FC = () => {
  const {
    activeWorkspace,
    workspacePosts,
    workspaceCampaigns,
    workspaceProjects,
    workspaceMedia,
    setNavSection,
    setStudioSubView,
  } = useStudio();

  const scheduledCount = workspacePosts.filter((p) => p.status === 'scheduled').length;
  const queuedCount = workspacePosts.filter((p) => p.status === 'queued').length;
  const activeCampaigns = workspaceCampaigns.filter((c) => c.status === 'active');

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="text-xs text-zinc-400 mb-1.5">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Social Hub Overview</span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-zinc-100">
            {activeWorkspace.name} Command Hub
          </h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">{activeWorkspace.aestheticStyle}</p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setNavSection('creative-studio');
              setStudioSubView('overview');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Open Creative Studio</span>
          </button>
          <button
            type="button"
            onClick={() => setNavSection('post-composer')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-zinc-700 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
          >
            <PenSquare className="w-3.5 h-3.5" />
            <span>Compose Post</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400">Scheduled Posts</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {scheduledCount}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400">Publishing Queue</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {queuedCount}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400">Media Library Assets</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {workspaceMedia.length}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-[#111114] border border-zinc-800">
          <div className="text-xs text-zinc-400">Creative Studio Projects</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-zinc-100 mt-1">
            {workspaceProjects.length}
          </div>
        </div>
      </div>

      {/* Hub Modules Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => {
            setNavSection('creative-studio');
            setStudioSubView('carousel-creator');
          }}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Layers className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>AI Carousel Creator</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Turn documents or topics into crisp 1080×1350 carousels ready for Instagram.
          </p>
        </button>

        <button
          type="button"
          onClick={() => {
            setNavSection('creative-studio');
            setStudioSubView('reels-studio');
          }}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Clapperboard className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>AI Reels & Shorts Studio</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Storyboard, edit vertical timelines, burn subtitles, and export MP4s in-browser.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setNavSection('ai-assistant')}
          className="p-5 rounded-xl bg-[#111114] border border-zinc-800 hover:border-zinc-600 text-left space-y-2 transition-colors"
        >
          <Sparkles className="w-4 h-4 text-zinc-200" />
          <div className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
            <span>Gemini AI Content Assistant</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-400">
            Draft brand-aligned hooks, captions, and release copy in {activeWorkspace.name} voice.
          </p>
        </button>
      </div>

      {/* Upcoming Pipeline & Campaigns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-100">Upcoming Schedule & Queue</h2>
            </div>
            <button
              type="button"
              onClick={() => setNavSection('content-calendar')}
              className="text-xs text-zinc-400 hover:text-zinc-100"
            >
              Open Calendar
            </button>
          </div>
          <div className="divide-y divide-zinc-800/70">
            {workspacePosts.slice(0, 5).map((post) => (
              <div key={post.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100 truncate">{post.title}</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    <span>{post.platform}</span>
                    <span className="mx-1.5">·</span>
                    <span className="capitalize">{post.status}</span>
                    {post.scheduledDate && (
                      <>
                        <span className="mx-1.5">·</span>
                        <span className="font-mono tabular-nums">
                          {post.scheduledDate} {post.scheduledTime || ''}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                  {post.mediaAssetIds.length} asset(s)
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-100">Active Campaigns</h2>
            </div>
            <button
              type="button"
              onClick={() => setNavSection('campaign-manager')}
              className="text-xs text-zinc-400 hover:text-zinc-100"
            >
              Manage Campaigns
            </button>
          </div>
          <div className="divide-y divide-zinc-800/70">
            {activeCampaigns.map((camp) => (
              <div key={camp.id} className="p-5 space-y-1.5">
                <div className="text-xs font-semibold text-zinc-100">{camp.name}</div>
                <p className="text-xs text-zinc-400 leading-relaxed">{camp.objective}</p>
                <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                  {camp.startDate} → {camp.endDate}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Footer Utility Links */}
      <div className="flex flex-wrap gap-3 pt-2">
        <button
          type="button"
          onClick={() => setNavSection('media-library')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
        >
          <ImageIcon className="w-3.5 h-3.5" />
          <span>Browse Media Library</span>
        </button>
        <button
          type="button"
          onClick={() => setNavSection('publishing-queue')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
        >
          <ListChecks className="w-3.5 h-3.5" />
          <span>View Publishing Queue</span>
        </button>
      </div>
    </div>
  );
};
