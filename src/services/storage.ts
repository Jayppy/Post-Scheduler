import {
  BEHIND_THE_RELEASE_WORKSPACE_ID,
  INITIAL_CAMPAIGNS,
  INITIAL_DESIGN_THEMES,
  INITIAL_EDITING_PRESETS,
  INITIAL_POSTS,
  INITIAL_WORKSPACES,
} from '../data/presets';
import {
  Campaign,
  CreativeProject,
  DesignTheme,
  EditingPreset,
  ExportRecord,
  MediaAsset,
  SocialPost,
  Workspace,
} from '../types/studio';

const KEYS = {
  workspaces: 's74_workspaces_v1',
  workspacesBackup: 's74_workspaces_backup_v1',
  activeWorkspaceId: 's74_active_workspace_v1',
  themes: 's74_design_themes_v1',
  editingPresets: 's74_editing_presets_v1',
  projects: 's74_creative_projects_v1',
  mediaLibrary: 's74_media_library_v1',
  exports: 's74_export_history_v1',
  posts: 's74_social_posts_v1',
  postsBackup: 's74_social_posts_backup_v1',
  campaigns: 's74_campaigns_v1',
  campaignsBackup: 's74_campaigns_backup_v1',
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('Failed to persist state to localStorage:', err);
  }
}

export const studioStorage = {
  loadWorkspaces(): Workspace[] {
    const stored = readJson<Workspace[]>(KEYS.workspaces, []);
    const hasLegacyOther = stored.some((w) => w.id !== BEHIND_THE_RELEASE_WORKSPACE_ID);
    if (hasLegacyOther && !localStorage.getItem(KEYS.workspacesBackup)) {
      writeJson(KEYS.workspacesBackup, stored);
    }

    const existingBtr = stored.find((w) => w.id === BEHIND_THE_RELEASE_WORKSPACE_ID);
    const singleWorkspaceList = [existingBtr || INITIAL_WORKSPACES[0]];
    if (stored.length !== 1 || hasLegacyOther || !existingBtr) {
      writeJson(KEYS.workspaces, singleWorkspaceList);
    }
    return singleWorkspaceList;
  },
  saveWorkspaces(workspaces: Workspace[]): void {
    const onlyBtr = workspaces.filter((w) => w.id === BEHIND_THE_RELEASE_WORKSPACE_ID);
    writeJson(KEYS.workspaces, onlyBtr.length > 0 ? onlyBtr : INITIAL_WORKSPACES);
  },

  loadActiveWorkspaceId(): string {
    localStorage.setItem(KEYS.activeWorkspaceId, BEHIND_THE_RELEASE_WORKSPACE_ID);
    return BEHIND_THE_RELEASE_WORKSPACE_ID;
  },
  saveActiveWorkspaceId(_id: string): void {
    localStorage.setItem(KEYS.activeWorkspaceId, BEHIND_THE_RELEASE_WORKSPACE_ID);
  },

  loadThemes(): DesignTheme[] {
    const stored = readJson<DesignTheme[]>(KEYS.themes, []);
    if (stored.length === 0) {
      writeJson(KEYS.themes, INITIAL_DESIGN_THEMES);
      return INITIAL_DESIGN_THEMES;
    }
    return stored;
  },
  saveThemes(themes: DesignTheme[]): void {
    writeJson(KEYS.themes, themes);
  },

  loadEditingPresets(): EditingPreset[] {
    const stored = readJson<EditingPreset[]>(KEYS.editingPresets, []);
    if (stored.length === 0) {
      writeJson(KEYS.editingPresets, INITIAL_EDITING_PRESETS);
      return INITIAL_EDITING_PRESETS;
    }
    return stored;
  },
  saveEditingPresets(presets: EditingPreset[]): void {
    writeJson(KEYS.editingPresets, presets);
  },

  loadProjects(): CreativeProject[] {
    return readJson<CreativeProject[]>(KEYS.projects, []);
  },
  saveProjects(projects: CreativeProject[]): void {
    writeJson(KEYS.projects, projects);
  },

  loadMediaLibrary(): MediaAsset[] {
    return readJson<MediaAsset[]>(KEYS.mediaLibrary, []);
  },
  saveMediaLibrary(assets: MediaAsset[]): void {
    writeJson(KEYS.mediaLibrary, assets);
  },

  loadExports(): ExportRecord[] {
    return readJson<ExportRecord[]>(KEYS.exports, []);
  },
  saveExports(records: ExportRecord[]): void {
    writeJson(KEYS.exports, records);
  },

  loadPosts(): SocialPost[] {
    const stored = readJson<SocialPost[]>(KEYS.posts, []);
    if (stored.length === 0) {
      writeJson(KEYS.posts, INITIAL_POSTS);
      return INITIAL_POSTS;
    }
    const legacyPosts = stored.filter((p) => p.workspaceId === 'ws-74-studio');
    if (legacyPosts.length > 0) {
      if (!localStorage.getItem(KEYS.postsBackup)) {
        writeJson(KEYS.postsBackup, legacyPosts);
      }
      const cleaned = stored.filter((p) => p.workspaceId !== 'ws-74-studio');
      writeJson(KEYS.posts, cleaned.length > 0 ? cleaned : INITIAL_POSTS);
      return cleaned.length > 0 ? cleaned : INITIAL_POSTS;
    }
    return stored;
  },
  savePosts(posts: SocialPost[]): void {
    writeJson(KEYS.posts, posts.filter((p) => p.workspaceId !== 'ws-74-studio'));
  },

  loadCampaigns(): Campaign[] {
    const stored = readJson<Campaign[]>(KEYS.campaigns, []);
    if (stored.length === 0) {
      writeJson(KEYS.campaigns, INITIAL_CAMPAIGNS);
      return INITIAL_CAMPAIGNS;
    }
    const legacyCampaigns = stored.filter((c) => c.workspaceId === 'ws-74-studio');
    if (legacyCampaigns.length > 0) {
      if (!localStorage.getItem(KEYS.campaignsBackup)) {
        writeJson(KEYS.campaignsBackup, legacyCampaigns);
      }
      const cleaned = stored.filter((c) => c.workspaceId !== 'ws-74-studio');
      writeJson(KEYS.campaigns, cleaned.length > 0 ? cleaned : INITIAL_CAMPAIGNS);
      return cleaned.length > 0 ? cleaned : INITIAL_CAMPAIGNS;
    }
    return stored;
  },
  saveCampaigns(campaigns: Campaign[]): void {
    writeJson(KEYS.campaigns, campaigns.filter((c) => c.workspaceId !== 'ws-74-studio'));
  },
};

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
