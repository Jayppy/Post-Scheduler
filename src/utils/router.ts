import type {
  ActiveBusinessWorkspace,
  CreativeStudioSubView,
  MainNavSection,
  MarketingSubView,
  SalesSubView,
} from '../types/studio';

export interface ParsedAppRoute {
  businessWorkspace: ActiveBusinessWorkspace;
  navSection: MainNavSection;
  studioSubView: CreativeStudioSubView;
  marketingSubView: MarketingSubView;
  salesSubView: SalesSubView;
  salesConversationId?: string;
  videoProjectId?: string;
}

export const DEFAULT_APP_ROUTE: ParsedAppRoute = {
  businessWorkspace: 'behind-the-release',
  navSection: 'hub-overview',
  studioSubView: 'overview',
  marketingSubView: 'dashboard',
  salesSubView: 'chat',
};

const VALID_CREATIVE_SUBVIEWS = new Set<CreativeStudioSubView>([
  'overview',
  'carousel-creator',
  'carousel-editor',
  'reels-studio',
  'video-studio',
  'design-themes',
  'creative-projects',
  'export-history',
]);

const VALID_MARKETING_SUBVIEWS = new Set<MarketingSubView>([
  'dashboard',
  'research',
  'generate',
  'editor',
  'library',
  'knowledge-base',
]);

export function parseAppPath(pathname: string): ParsedAppRoute {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';
  const segments = clean.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'behind-the-release')) {
    return { ...DEFAULT_APP_ROUTE };
  }

  if (segments[0] === 'ai-providers') {
    return {
      ...DEFAULT_APP_ROUTE,
      navSection: 'ai-providers',
    };
  }

  if (segments[0] === '74-studio-sales' || segments[0] === 'sales-intelligence') {
    const subRaw = segments[1] || 'chat';
    if (subRaw === 'knowledge-base') {
      return {
        ...DEFAULT_APP_ROUTE,
        businessWorkspace: '74-studio-sales',
        navSection: 'sales-intelligence',
        salesSubView: 'knowledge-base',
      };
    }
    if (subRaw === 'settings') {
      return {
        ...DEFAULT_APP_ROUTE,
        businessWorkspace: '74-studio-sales',
        navSection: 'sales-intelligence',
        salesSubView: 'settings',
      };
    }
    // Gracefully map legacy slugs ('dashboard', 'leads', 'intelligence', 'responses', 'campaigns', 'activity') to chat
    const convId =
      subRaw === 'chat' && segments[2]
        ? segments[2]
        : subRaw !== 'chat' &&
            !['dashboard', 'leads', 'intelligence', 'responses', 'campaigns', 'activity'].includes(subRaw)
          ? subRaw
          : undefined;
    return {
      ...DEFAULT_APP_ROUTE,
      businessWorkspace: '74-studio-sales',
      navSection: 'sales-intelligence',
      salesSubView: 'chat',
      salesConversationId: convId,
    };
  }

  // Behind The Release paths (with or without /behind-the-release prefix)
  const btrSegs = segments[0] === 'behind-the-release' ? segments.slice(1) : segments;
  const head = btrSegs[0] || 'hub';

  if (head === 'studio' || head === 'creative-studio') {
    const rawSub = btrSegs[1] || 'overview';
    const subMap: Record<string, CreativeStudioSubView> = {
      overview: 'overview',
      carousels: 'carousel-creator',
      'carousel-creator': 'carousel-creator',
      'carousel-editor': 'carousel-editor',
      reels: 'reels-studio',
      'reels-studio': 'reels-studio',
      'video-studio': 'video-studio',
      themes: 'design-themes',
      'design-themes': 'design-themes',
      projects: 'creative-projects',
      'creative-projects': 'creative-projects',
      exports: 'export-history',
      'export-history': 'export-history',
    };
    const resolvedSub = subMap[rawSub] || (VALID_CREATIVE_SUBVIEWS.has(rawSub as CreativeStudioSubView) ? (rawSub as CreativeStudioSubView) : 'overview');
    const videoProjectId = resolvedSub === 'video-studio' && btrSegs[2] ? btrSegs[2] : undefined;
    return {
      ...DEFAULT_APP_ROUTE,
      navSection: 'creative-studio',
      studioSubView: resolvedSub,
      videoProjectId,
    };
  }

  if (head === 'marketing' || head === 'marketing-studio') {
    const rawSub = (btrSegs[1] || 'dashboard') as MarketingSubView;
    return {
      ...DEFAULT_APP_ROUTE,
      navSection: 'marketing-studio',
      marketingSubView: VALID_MARKETING_SUBVIEWS.has(rawSub) ? rawSub : 'dashboard',
    };
  }

  const hubAliasMap: Record<string, MainNavSection> = {
    hub: 'hub-overview',
    'hub-overview': 'hub-overview',
    assistant: 'ai-assistant',
    'ai-assistant': 'ai-assistant',
    media: 'media-library',
    'media-library': 'media-library',
    composer: 'post-composer',
    'post-composer': 'post-composer',
    calendar: 'content-calendar',
    'content-calendar': 'content-calendar',
    queue: 'publishing-queue',
    'publishing-queue': 'publishing-queue',
    campaigns: 'campaign-manager',
    'campaign-manager': 'campaign-manager',
    accounts: 'connected-accounts',
    'connected-accounts': 'connected-accounts',
  };

  if (hubAliasMap[head]) {
    return {
      ...DEFAULT_APP_ROUTE,
      navSection: hubAliasMap[head],
    };
  }

  return { ...DEFAULT_APP_ROUTE };
}

export function serializeAppPath(state: {
  businessWorkspace: ActiveBusinessWorkspace;
  navSection: MainNavSection;
  studioSubView: CreativeStudioSubView;
  marketingSubView: MarketingSubView;
  salesSubView: SalesSubView;
  salesConversationId?: string | null;
  videoProjectId?: string | null;
}): string {
  if (state.navSection === 'ai-providers') {
    return '/ai-providers';
  }

  if (state.businessWorkspace === '74-studio-sales' || state.navSection === 'sales-intelligence') {
    if (state.salesSubView === 'knowledge-base') return '/74-studio-sales/knowledge-base';
    if (state.salesSubView === 'settings') return '/74-studio-sales/settings';
    if (state.salesConversationId) {
      return `/74-studio-sales/chat/${encodeURIComponent(state.salesConversationId)}`;
    }
    return '/74-studio-sales/chat';
  }

  if (state.navSection === 'creative-studio') {
    const slugMap: Record<CreativeStudioSubView, string> = {
      overview: 'overview',
      'carousel-creator': 'carousels',
      'carousel-editor': 'carousel-editor',
      'reels-studio': 'reels',
      'video-studio': 'video-studio',
      'design-themes': 'themes',
      'creative-projects': 'projects',
      'export-history': 'exports',
    };
    const slug = slugMap[state.studioSubView] || 'overview';
    if (state.studioSubView === 'video-studio' && state.videoProjectId) {
      return `/behind-the-release/studio/video-studio/${encodeURIComponent(state.videoProjectId)}`;
    }
    return `/behind-the-release/studio/${slug}`;
  }

  if (state.navSection === 'marketing-studio') {
    return `/behind-the-release/marketing/${state.marketingSubView || 'dashboard'}`;
  }

  const hubSlugMap: Partial<Record<MainNavSection, string>> = {
    'hub-overview': '/behind-the-release',
    'ai-assistant': '/behind-the-release/assistant',
    'media-library': '/behind-the-release/media',
    'post-composer': '/behind-the-release/composer',
    'content-calendar': '/behind-the-release/calendar',
    'publishing-queue': '/behind-the-release/queue',
    'campaign-manager': '/behind-the-release/campaigns',
    'connected-accounts': '/behind-the-release/accounts',
  };

  return hubSlugMap[state.navSection] || '/behind-the-release';
}
