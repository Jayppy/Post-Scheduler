import React, { useState } from 'react';
import {
  Calendar,
  ChevronDown,
  Clapperboard,
  FolderKanban,
  History,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Menu,
  Palette,
  PenSquare,
  Plus,
  Settings,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { CreativeStudioSubView, MainNavSection } from '../../types/studio';

interface AppShellProps {
  children: React.ReactNode;
  onOpenWorkspaceSettings: () => void;
}

const HUB_NAV: Array<{ id: MainNavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'hub-overview', label: 'Hub Overview', icon: LayoutDashboard },
  { id: 'ai-assistant', label: 'Gemini AI Assistant', icon: Sparkles },
  { id: 'media-library', label: 'Media Library', icon: ImageIcon },
  { id: 'post-composer', label: 'Post Composer', icon: PenSquare },
  { id: 'content-calendar', label: 'Content Calendar', icon: Calendar },
  { id: 'publishing-queue', label: 'Publishing Queue', icon: ListChecks },
  { id: 'campaign-manager', label: 'Campaign Manager', icon: Megaphone },
];

const STUDIO_SUB_NAV: Array<{
  id: CreativeStudioSubView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Creative Studio Overview', icon: Wand2 },
  { id: 'carousel-creator', label: 'Carousel Creator', icon: Layers },
  { id: 'reels-studio', label: 'Reels & Shorts Studio', icon: Clapperboard },
  { id: 'design-themes', label: 'Design Themes', icon: Palette },
  { id: 'creative-projects', label: 'Creative Projects', icon: FolderKanban },
  { id: 'export-history', label: 'Export History', icon: History },
];

export const AppShell: React.FC<AppShellProps> = ({ children, onOpenWorkspaceSettings }) => {
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    navSection,
    setNavSection,
    studioSubView,
    setStudioSubView,
    setActiveProjectId,
    toasts,
    dismissToast,
  } = useStudio();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);

  const handleSelectStudioSub = (sub: CreativeStudioSubView) => {
    if (sub === 'carousel-creator') {
      setActiveProjectId(null);
    }
    setNavSection('creative-studio');
    setStudioSubView(sub);
    setMobileOpen(false);
  };

  const handleSelectHubNav = (sec: MainNavSection) => {
    setNavSection(sec);
    setMobileOpen(false);
  };

  const activeTitle =
    navSection === 'creative-studio'
      ? STUDIO_SUB_NAV.find((s) => s.id === studioSubView)?.label || 'Carousel Visual Editor'
      : HUB_NAV.find((h) => h.id === navSection)?.label || 'Hub Overview';

  const SidebarContent = (
    <div className="flex h-full flex-col bg-[#0d0d10] border-r border-zinc-800/80">
      {/* Brand Header */}
      <div className="px-5 py-5 border-b border-zinc-800/80">
        <div className="flex items-center justify-between">
          <span className="font-display text-sm font-bold tracking-[0.14em] text-zinc-100 uppercase">
            74 STUDIO
          </span>
          <span className="font-mono text-[11px] text-zinc-500">SOCIAL HUB</span>
        </div>
      </div>

      {/* Prominent Brand Workspace Switcher */}
      <div className="px-4 py-4 border-b border-zinc-800/80 relative">
        <div className="text-[11px] font-medium text-zinc-500 mb-2">Active Brand Workspace</div>
        <button
          type="button"
          onClick={() => setWsDropdownOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-[#141418] border border-zinc-800 hover:border-zinc-700 transition-colors text-left"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-100 truncate">{activeWorkspace.name}</div>
            <div className="text-[11px] text-zinc-400 truncate">{activeWorkspace.tagline}</div>
          </div>
          <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
        </button>

        {wsDropdownOpen && (
          <div className="absolute left-4 right-4 top-[88px] z-30 rounded-lg bg-[#16161b] border border-zinc-700/80 shadow-2xl py-1">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => {
                  setActiveWorkspaceId(ws.id);
                  setWsDropdownOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-xs transition-colors flex items-center justify-between ${
                  ws.id === activeWorkspace.id
                    ? 'bg-zinc-800 text-zinc-100 font-semibold'
                    : 'text-zinc-300 hover:bg-zinc-800/60'
                }`}
              >
                <span className="truncate">{ws.name}</span>
                {ws.id === activeWorkspace.id && <span className="text-[10px] font-mono text-zinc-400">Active</span>}
              </button>
            ))}
            <div className="border-t border-zinc-800 mt-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setWsDropdownOpen(false);
                  onOpenWorkspaceSettings();
                }}
                className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800/60 flex items-center gap-2"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Manage Brand Identity</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* AI Creative Studio Primary Group */}
        <div>
          <div className="px-2 mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
              AI Creative Studio
            </span>
          </div>
          <div className="space-y-0.5">
            {STUDIO_SUB_NAV.map((item) => {
              const Icon = item.icon;
              const isActive =
                navSection === 'creative-studio' &&
                (studioSubView === item.id ||
                  (item.id === 'carousel-creator' && studioSubView === 'carousel-editor'));
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectStudioSub(item.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-zinc-100 text-zinc-950 font-semibold'
                      : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Social Hub Core Group */}
        <div>
          <div className="px-2 mb-2">
            <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
              Social Hub
            </span>
          </div>
          <div className="space-y-0.5">
            {HUB_NAV.map((item) => {
              const Icon = item.icon;
              const isActive = navSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectHubNav(item.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-zinc-800 text-zinc-100 font-semibold'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Workspace Settings Action */}
      <div className="p-3 border-t border-zinc-800/80">
        <button
          type="button"
          onClick={onOpenWorkspaceSettings}
          className="w-full flex items-center justify-between px-3 py-2 rounded-md border border-zinc-800 bg-[#121216] hover:border-zinc-700 text-xs text-zinc-300 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Settings className="w-3.5 h-3.5 text-zinc-400" />
            <span>Brand Identity Settings</span>
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[264px] shrink-0 sticky top-0 h-screen">
        {SidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/75"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-[272px] h-full">{SidebarContent}</div>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Single-Row Top Bar Contract */}
        <header className="sticky top-0 z-20 h-14 px-4 lg:px-8 bg-[#09090b]/95 backdrop-blur border-b border-zinc-800/80 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-2 text-zinc-400 hover:text-zinc-100"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-zinc-400 truncate">
              <span className="font-medium text-zinc-200 whitespace-nowrap">{activeWorkspace.name}</span>
              <span aria-hidden="true">/</span>
              <span className="text-zinc-400 truncate">{activeTitle}</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs font-medium text-zinc-400 shrink-0">
            <button
              type="button"
              onClick={() => handleSelectStudioSub('carousel-creator')}
              className="hover:text-zinc-100 transition-colors whitespace-nowrap"
            >
              Carousels
            </button>
            <button
              type="button"
              onClick={() => handleSelectStudioSub('reels-studio')}
              className="hover:text-zinc-100 transition-colors whitespace-nowrap"
            >
              Reels & Shorts
            </button>
            <button
              type="button"
              onClick={() => handleSelectHubNav('media-library')}
              className="hover:text-zinc-100 transition-colors whitespace-nowrap"
            >
              Media Library
            </button>
            <button
              type="button"
              onClick={() => handleSelectHubNav('content-calendar')}
              className="hover:text-zinc-100 transition-colors whitespace-nowrap"
            >
              Calendar
            </button>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => handleSelectStudioSub('carousel-creator')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Production</span>
            </button>
          </div>
        </header>

        {/* Active View Content */}
        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm w-full pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`pointer-events-auto p-3.5 rounded-lg border shadow-xl flex items-start justify-between gap-3 bg-[#141418] ${
                toast.tone === 'error'
                  ? 'border-red-500/50'
                  : toast.tone === 'warning'
                    ? 'border-amber-500/50'
                    : toast.tone === 'success'
                      ? 'border-emerald-500/50'
                      : 'border-zinc-700'
              }`}
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold text-zinc-100">{toast.title}</div>
                {toast.detail && (
                  <div className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">{toast.detail}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="text-zinc-500 hover:text-zinc-200 p-0.5"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
