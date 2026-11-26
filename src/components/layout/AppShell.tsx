import React, { useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Briefcase,
  Calendar,
  Clapperboard,
  Cpu,
  Film,
  FolderKanban,
  Globe2,
  History,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  Library,
  Link2,
  ListChecks,
  Megaphone,
  Menu,
  MessageSquare,
  MessageSquarePlus,
  Palette,
  PenSquare,
  Plus,
  Settings,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import {
  CreativeStudioSubView,
  MainNavSection,
  MarketingSubView,
  SalesSubView,
} from '../../types/studio';
import { OfflineIndicator, PWAInstallButton } from '../pwa/PWAInstallButton';

interface AppShellProps {
  children: React.ReactNode;
  onOpenWorkspaceSettings: () => void;
}

const HUB_NAV: Array<{
  id: MainNavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'hub-overview', label: 'Hub Overview', icon: LayoutDashboard },
  { id: 'ai-assistant', label: 'AI Content Assistant', icon: Sparkles },
  { id: 'media-library', label: 'Media Library', icon: ImageIcon },
  { id: 'post-composer', label: 'Post Composer', icon: PenSquare },
  { id: 'content-calendar', label: 'Content Calendar', icon: Calendar },
  { id: 'publishing-queue', label: 'Publishing Queue', icon: ListChecks },
  { id: 'campaign-manager', label: 'Campaign Manager', icon: Megaphone },
  { id: 'connected-accounts', label: 'Connected Accounts', icon: Link2 },
];

const STUDIO_SUB_NAV: Array<{
  id: CreativeStudioSubView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Creative Studio Overview', icon: Wand2 },
  { id: 'carousel-creator', label: 'Carousel Creator', icon: Layers },
  { id: 'reels-studio', label: 'Reels & Shorts Studio', icon: Clapperboard },
  { id: 'video-studio', label: 'Video Studio', icon: Film },
  { id: 'design-themes', label: 'Design Themes', icon: Palette },
  { id: 'creative-projects', label: 'Creative Projects', icon: FolderKanban },
  { id: 'export-history', label: 'Export History', icon: History },
];

const MARKETING_SUB_NAV: Array<{
  id: MarketingSubView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Marketing Dashboard', icon: BarChart3 },
  { id: 'research', label: 'Research Intelligence', icon: Globe2 },
  { id: 'generate', label: 'Generate Content', icon: Sparkles },
  { id: 'editor', label: 'Cross-Platform Editor', icon: PenSquare },
  { id: 'library', label: 'Content Library', icon: Library },
  { id: 'knowledge-base', label: '74 STUDIO Profile', icon: BookOpen },
];

const SALES_SUB_NAV: Array<{
  id: SalesSubView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'chat', label: 'Artist Chat Assistant', icon: MessageSquare },
  { id: 'knowledge-base', label: '74 STUDIO Profile & Pricing KB', icon: BookOpen },
  { id: 'settings', label: 'Promo & Settings', icon: Settings },
];

export const AppShell: React.FC<AppShellProps> = ({ children, onOpenWorkspaceSettings }) => {
  const {
    activeWorkspace,
    activeBusinessWorkspace,
    switchBusinessWorkspace,
    navSection,
    setNavSection,
    studioSubView,
    setStudioSubView,
    marketingSubView,
    setMarketingSubView,
    salesSubView,
    setSalesSubView,
    setActiveProjectId,
    toasts,
    dismissToast,
  } = useStudio();

  const [mobileOpen, setMobileOpen] = useState(false);

  const handleSelectStudioSub = (sub: CreativeStudioSubView) => {
    if (sub === 'carousel-creator') {
      setActiveProjectId(null);
    }
    switchBusinessWorkspace('behind-the-release');
    setNavSection('creative-studio');
    setStudioSubView(sub);
    setMobileOpen(false);
  };

  const handleSelectMarketingSub = (sub: MarketingSubView) => {
    switchBusinessWorkspace('behind-the-release');
    setNavSection('marketing-studio');
    setMarketingSubView(sub);
    setMobileOpen(false);
  };

  const handleSelectSalesSub = (sub: SalesSubView) => {
    switchBusinessWorkspace('74-studio-sales');
    setNavSection('sales-intelligence');
    setSalesSubView(sub);
    setMobileOpen(false);
  };

  const handleSelectHubNav = (sec: MainNavSection) => {
    if (sec !== 'ai-providers' && sec !== 'sales-intelligence') {
      switchBusinessWorkspace('behind-the-release');
    }
    setNavSection(sec);
    setMobileOpen(false);
  };

  const isSalesWorkspace = activeBusinessWorkspace === '74-studio-sales';
  const isMarketingActive = navSection === 'marketing-studio';
  const isAiProvidersActive = navSection === 'ai-providers';
  const isSalesActive = navSection === 'sales-intelligence';

  const activeTitle = isAiProvidersActive
    ? 'AI Provider Manager & Free-Tier Quotas'
    : isSalesActive
      ? SALES_SUB_NAV.find((s) => s.id === salesSubView)?.label || 'Sales Overview'
      : navSection === 'marketing-studio'
        ? MARKETING_SUB_NAV.find((m) => m.id === marketingSubView)?.label || 'Marketing Dashboard'
        : navSection === 'creative-studio'
          ? STUDIO_SUB_NAV.find((s) => s.id === studioSubView)?.label || 'Carousel Visual Editor'
          : HUB_NAV.find((h) => h.id === navSection)?.label || 'Hub Overview';

  const SidebarContent = (
    <div
      className={`flex h-full flex-col border-r transition-colors ${
        isSalesWorkspace
          ? 'bg-[#0b1017] border-sky-900/40'
          : 'bg-[#0d0d10] border-zinc-800/80'
      }`}
    >
      {/* Brand Header */}
      <div className="px-5 py-4 border-b border-zinc-800/80">
        <div className="flex items-center justify-between">
          <span className="font-display text-sm font-bold tracking-[0.12em] text-zinc-100 uppercase">
            {isSalesWorkspace ? '74 STUDIO' : 'BEHIND THE RELEASE'}
          </span>
          <span
            className={`font-mono text-[10px] ${
              isSalesWorkspace ? 'text-sky-400' : 'text-zinc-500'
            }`}
          >
            {isSalesWorkspace ? 'SALES INTEL' : 'STUDIO OS'}
          </span>
        </div>
      </div>

      {/* Explicit Multi-Workspace Switcher */}
      <div className="px-3.5 py-3 border-b border-zinc-800/80 space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-1">
          Business Workspace
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          <button
            type="button"
            onClick={() => {
              switchBusinessWorkspace('behind-the-release');
              setMobileOpen(false);
            }}
            className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
              !isSalesWorkspace
                ? 'bg-[#17171d] border-emerald-500/40 text-zinc-100'
                : 'bg-[#0d1118] border-zinc-800/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold truncate">{activeWorkspace.name}</span>
              {!isSalesWorkspace && (
                <span className="text-[10px] font-mono text-emerald-400 shrink-0">Active</span>
              )}
            </div>
            <div className="text-[10px] text-zinc-500 truncate">
              Social Hub · Creative &amp; Marketing
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              switchBusinessWorkspace('74-studio-sales');
              setMobileOpen(false);
            }}
            className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
              isSalesWorkspace
                ? 'bg-[#101a29] border-sky-500/50 text-zinc-100'
                : 'bg-[#111115] border-zinc-800/80 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold truncate flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>74 STUDIO Sales</span>
              </span>
              {isSalesWorkspace && (
                <span className="text-[10px] font-mono text-sky-400 shrink-0">Active</span>
              )}
            </div>
            <div className="text-[10px] text-zinc-500 truncate">
              Artist Chat · Pricing KB · 10% Offer
            </div>
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {isSalesWorkspace ? (
          /* Workspace B Navigation (Strictly No Social Publishing / IG / YT Controls) */
          <div>
            <div className="px-2 mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider text-sky-300 uppercase">
                Sales Intelligence
              </span>
              <span className="text-[10px] font-mono text-sky-500">WS-B</span>
            </div>
            <div className="space-y-0.5">
              {SALES_SUB_NAV.map((item) => {
                const Icon = item.icon;
                const isActive = navSection === 'sales-intelligence' && salesSubView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectSalesSub(item.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-sky-500 text-slate-950 font-semibold'
                        : 'text-zinc-300 hover:bg-sky-500/10 hover:text-zinc-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* 74 STUDIO Marketing Content Studio inside Workspace A */}
            <div>
              <div className="px-2 mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wider text-zinc-200 uppercase">
                  Marketing Content Studio
                </span>
                <span className="text-[10px] font-mono text-zinc-500">74 STUDIO</span>
              </div>
              <div className="space-y-0.5">
                {MARKETING_SUB_NAV.map((item) => {
                  const Icon = item.icon;
                  const isActive = navSection === 'marketing-studio' && marketingSubView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectMarketingSub(item.id)}
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

            {/* Behind The Release Social Hub */}
            <div>
              <div className="px-2 mb-2">
                <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Social Hub · Behind the Release
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

            {/* AI Creative Studio (Behind the Release) */}
            <div>
              <div className="px-2 mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
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
                          ? 'bg-zinc-800 text-zinc-100 font-semibold'
                          : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Shared Infrastructure: AI Provider Manager */}
        <div className="pt-2 border-t border-zinc-800/70">
          <div className="px-2 mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
              Shared AI Infrastructure
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleSelectHubNav('ai-providers')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              isAiProvidersActive
                ? 'bg-zinc-100 text-zinc-950 font-semibold'
                : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100'
            }`}
          >
            <Cpu className="w-4 h-4 shrink-0" />
            <span className="truncate">AI Provider Manager</span>
          </button>
        </div>
      </nav>

      {/* Behind The Release Identity Footer (Only shown in Workspace A) */}
      {!isSalesWorkspace && (
        <div className="p-3 border-t border-zinc-800/80">
          <button
            type="button"
            onClick={onOpenWorkspaceSettings}
            className="w-full flex items-center justify-between px-3 py-2 rounded-md border border-zinc-800 bg-[#121216] hover:border-zinc-700 text-xs text-zinc-300 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Settings className="w-3.5 h-3.5 text-zinc-400" />
              <span>Behind the Release Identity</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[272px] shrink-0 sticky top-0 h-screen">
        {SidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/75"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-[280px] h-full">{SidebarContent}</div>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Single-Row Top Bar Contract */}
        <header
          className={`sticky top-0 z-20 h-14 px-4 lg:px-8 backdrop-blur border-b flex items-center justify-between gap-8 ${
            isSalesWorkspace
              ? 'bg-[#090e15]/95 border-sky-900/40'
              : 'bg-[#09090b]/95 border-zinc-800/80'
          }`}
        >
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
              <span
                className={`font-medium whitespace-nowrap ${
                  isSalesWorkspace ? 'text-sky-300' : 'text-zinc-200'
                }`}
              >
                {isAiProvidersActive
                  ? 'Shared AI Infrastructure'
                  : isSalesWorkspace
                    ? '74 STUDIO Sales Intelligence'
                    : isMarketingActive
                      ? '74 STUDIO Marketing Intelligence'
                      : activeWorkspace.name}
              </span>
              <span aria-hidden="true">/</span>
              <span className="text-zinc-400 truncate">{activeTitle}</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs font-medium text-zinc-400 shrink-0">
            {isSalesWorkspace ? (
              <>
                <button
                  type="button"
                  onClick={() => handleSelectSalesSub('chat')}
                  className="hover:text-sky-300 transition-colors whitespace-nowrap"
                >
                  Artist Chat
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectSalesSub('knowledge-base')}
                  className="hover:text-sky-300 transition-colors whitespace-nowrap"
                >
                  Pricing KB
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectSalesSub('settings')}
                  className="hover:text-sky-300 transition-colors whitespace-nowrap"
                >
                  Settings
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectHubNav('ai-providers')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  AI Providers
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => handleSelectHubNav('hub-overview')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  Behind the Release
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectStudioSub('video-studio')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  Video Studio
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectHubNav('connected-accounts')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  Accounts
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectMarketingSub('dashboard')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  Marketing Studio
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectHubNav('ai-providers')}
                  className="hover:text-zinc-100 transition-colors whitespace-nowrap"
                >
                  AI Providers
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            {isSalesWorkspace ? (
              <button
                type="button"
                onClick={() => handleSelectSalesSub('chat')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
                <span>Artist Assistant</span>
              </button>
            ) : isMarketingActive ? (
              <button
                type="button"
                onClick={() => handleSelectMarketingSub('generate')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Generate Campaign</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSelectStudioSub('video-studio')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Video</span>
              </button>
            )}
          </div>
        </header>

        <OfflineIndicator />

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
