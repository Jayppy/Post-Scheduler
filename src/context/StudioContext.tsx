import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActiveBusinessWorkspace,
  Campaign,
  CreativeProject,
  CreativeStudioSubView,
  DesignTheme,
  EditingPreset,
  ExportRecord,
  MainNavSection,
  MarketingSubView,
  MediaAsset,
  SalesSubView,
  SocialPlatform,
  SocialPost,
  Workspace,
  YouTubePrivacyStatus,
} from '../types/studio';
import { BEHIND_THE_RELEASE_WORKSPACE_ID } from '../data/presets';
import { createId, studioStorage } from '../services/storage';
import { deleteMediaBlob, putMediaBlob } from '../services/idb';
import { integrationsClient } from '../services/integrationsClient';
import { prepareMediaItemsForPublish } from '../services/mediaPayload';
import { useFirebase } from './FirebaseContext';
import { deleteScheduledJobFromFirestore } from '../services/firebaseClient';
import { DEFAULT_PUBLISHING_TIMEZONE, zonedDateTimeToUtcIso } from '../utils/publishing';
import { parseAppPath, serializeAppPath } from '../utils/router';

export interface ToastMessage {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
}

export interface ComposerDraftInput {
  editingPostId?: string;
  editingJobId?: string;
  title: string;
  platform: SocialPlatform | 'both-video';
  caption: string;
  hashtags: string[];
  mediaAssetIds: string[];
  scheduledDate?: string;
  scheduledTime?: string;
  timezone?: string;
  youtubePrivacyStatus?: YouTubePrivacyStatus;
  sourceProjectId?: string;
}

export interface CalendarScheduleInput {
  title: string;
  platform: SocialPlatform;
  caption: string;
  hashtags: string[];
  mediaAssetIds: string[];
  scheduledDate: string;
  scheduledTime: string;
  timezone?: string;
  sourceProjectId?: string;
}

interface StudioContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace;
  setActiveWorkspaceId: (id: string) => void;
  updateWorkspace: (ws: Workspace) => void;
  createWorkspace: (ws: Omit<Workspace, 'id' | 'createdAt'>) => Workspace;

  activeBusinessWorkspace: ActiveBusinessWorkspace;
  switchBusinessWorkspace: (ws: ActiveBusinessWorkspace) => void;

  navSection: MainNavSection;
  setNavSection: (section: MainNavSection) => void;
  studioSubView: CreativeStudioSubView;
  setStudioSubView: (sub: CreativeStudioSubView) => void;
  marketingSubView: MarketingSubView;
  setMarketingSubView: (sub: MarketingSubView) => void;
  salesSubView: SalesSubView;
  setSalesSubView: (sub: SalesSubView) => void;
  salesConversationId: string | null;
  setSalesConversationId: (id: string | null) => void;
  activeVideoProjectId: string | null;
  setActiveVideoProjectId: (id: string | null) => void;

  themes: DesignTheme[];
  workspaceThemes: DesignTheme[];
  saveTheme: (theme: DesignTheme) => void;
  deleteTheme: (id: string) => void;

  editingPresets: EditingPreset[];
  saveEditingPreset: (preset: EditingPreset) => void;

  projects: CreativeProject[];
  workspaceProjects: CreativeProject[];
  activeProjectId: string | null;
  activeProject: CreativeProject | null;
  setActiveProjectId: (id: string | null) => void;
  saveProject: (project: CreativeProject) => void;
  duplicateProject: (id: string) => CreativeProject | null;
  renameProject: (id: string, title: string) => void;
  deleteProject: (id: string) => Promise<void>;
  openProjectInEditor: (project: CreativeProject) => void;

  mediaLibrary: MediaAsset[];
  workspaceMedia: MediaAsset[];
  addMediaAsset: (asset: MediaAsset, blob?: Blob) => Promise<MediaAsset>;
  deleteMediaAsset: (id: string) => Promise<void>;
  saveExportToMediaLibrary: (
    exportRecord: ExportRecord,
    blobs: Array<{ filename: string; blob: Blob; slideNumber?: number }>,
    targetWorkspaceId: string,
    allowDuplicateCopy?: boolean
  ) => Promise<{ savedAssets: MediaAsset[]; skippedDuplicate: boolean }>;

  exports: ExportRecord[];
  workspaceExports: ExportRecord[];
  addExportRecord: (record: ExportRecord) => void;

  posts: SocialPost[];
  workspacePosts: SocialPost[];
  savePost: (post: SocialPost) => void;
  deletePost: (id: string) => void;

  campaigns: Campaign[];
  workspaceCampaigns: Campaign[];
  saveCampaign: (campaign: Campaign) => void;
  deleteCampaign: (id: string) => void;

  composerDraft: ComposerDraftInput | null;
  setComposerDraft: (draft: ComposerDraftInput | null) => void;
  openPostComposerWithDraft: (draft: ComposerDraftInput) => void;
  schedulePostToCalendar: (input: CalendarScheduleInput) => void;

  toasts: ToastMessage[];
  notify: (tone: ToastMessage['tone'], title: string, detail?: string) => void;
  dismissToast: (id: string) => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export const StudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, syncFromServerSnapshot } = useFirebase();
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => studioStorage.loadWorkspaces());
  const [activeWorkspaceId, setActiveWsId] = useState<string>(() => studioStorage.loadActiveWorkspaceId());
  const initialRoute = useMemo(
    () =>
      typeof window !== 'undefined'
        ? parseAppPath(window.location.pathname)
        : parseAppPath('/'),
    []
  );
  const [activeBusinessWorkspace, setActiveBusinessWorkspace] = useState<ActiveBusinessWorkspace>(
    initialRoute.businessWorkspace
  );
  const [navSection, setNavSection] = useState<MainNavSection>(initialRoute.navSection);
  const [studioSubView, setStudioSubView] = useState<CreativeStudioSubView>(
    initialRoute.studioSubView
  );
  const [marketingSubView, setMarketingSubView] = useState<MarketingSubView>(
    initialRoute.marketingSubView
  );
  const [salesSubView, setSalesSubView] = useState<SalesSubView>(initialRoute.salesSubView);
  const [salesConversationId, setSalesConversationId] = useState<string | null>(
    initialRoute.salesConversationId || null
  );
  const [activeVideoProjectId, setActiveVideoProjectId] = useState<string | null>(
    initialRoute.videoProjectId || null
  );

  const [themes, setThemes] = useState<DesignTheme[]>(() => studioStorage.loadThemes());
  const [editingPresets, setEditingPresets] = useState<EditingPreset[]>(() =>
    studioStorage.loadEditingPresets()
  );
  const [projects, setProjects] = useState<CreativeProject[]>(() => studioStorage.loadProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [mediaLibrary, setMediaLibrary] = useState<MediaAsset[]>(() => studioStorage.loadMediaLibrary());
  const [exports, setExports] = useState<ExportRecord[]>(() => studioStorage.loadExports());
  const [posts, setPosts] = useState<SocialPost[]>(() => studioStorage.loadPosts());
  const [campaigns, setCampaigns] = useState<Campaign[]>(() => studioStorage.loadCampaigns());
  const [composerDraft, setComposerDraft] = useState<ComposerDraftInput | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0],
    [workspaces, activeWorkspaceId]
  );

  useEffect(() => {
    studioStorage.saveWorkspaces(workspaces);
  }, [workspaces]);

  useEffect(() => {
    studioStorage.saveActiveWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    studioStorage.saveThemes(themes);
  }, [themes]);

  useEffect(() => {
    studioStorage.saveEditingPresets(editingPresets);
  }, [editingPresets]);

  useEffect(() => {
    studioStorage.saveProjects(projects);
  }, [projects]);

  useEffect(() => {
    studioStorage.saveMediaLibrary(mediaLibrary);
  }, [mediaLibrary]);

  useEffect(() => {
    studioStorage.saveExports(exports);
  }, [exports]);

  useEffect(() => {
    studioStorage.savePosts(posts);
  }, [posts]);

  useEffect(() => {
    studioStorage.saveCampaigns(campaigns);
  }, [campaigns]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (tone: ToastMessage['tone'], title: string, detail?: string) => {
      const id = createId('toast');
      setToasts((prev) => [...prev.slice(-3), { id, tone, title, detail }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    []
  );

  const setActiveWorkspaceId = useCallback(
    (_id: string) => {
      setActiveWsId(BEHIND_THE_RELEASE_WORKSPACE_ID);
      setActiveProjectId(null);
      setComposerDraft(null);
    },
    []
  );

  const switchBusinessWorkspace = useCallback((ws: ActiveBusinessWorkspace) => {
    setActiveBusinessWorkspace(ws);
    if (ws === '74-studio-sales') {
      setNavSection('sales-intelligence');
      setSalesSubView('chat');
    } else {
      setNavSection((prev) => (prev === 'sales-intelligence' ? 'hub-overview' : prev));
    }
  }, []);

  // Bidirectional URL <-> navigation state sync via History API (clean paths, no secrets or messages)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePopState = () => {
      const parsed = parseAppPath(window.location.pathname);
      setActiveBusinessWorkspace(parsed.businessWorkspace);
      setNavSection(parsed.navSection);
      setStudioSubView(parsed.studioSubView);
      setMarketingSubView(parsed.marketingSubView);
      setSalesSubView(parsed.salesSubView);
      setSalesConversationId(parsed.salesConversationId || null);
      setActiveVideoProjectId(parsed.videoProjectId || null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const targetPath = serializeAppPath({
      businessWorkspace: activeBusinessWorkspace,
      navSection,
      studioSubView,
      marketingSubView,
      salesSubView,
      salesConversationId,
      videoProjectId: activeVideoProjectId,
    });
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
    const normalizedTarget = targetPath.replace(/\/+$/, '') || '/';
    if (currentPath !== normalizedTarget && !currentPath.startsWith('/api/')) {
      window.history.pushState(null, '', targetPath);
    }
  }, [
    activeBusinessWorkspace,
    navSection,
    studioSubView,
    marketingSubView,
    salesSubView,
    salesConversationId,
    activeVideoProjectId,
  ]);

  const updateWorkspace = useCallback((ws: Workspace) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === BEHIND_THE_RELEASE_WORKSPACE_ID ? { ...ws, id: BEHIND_THE_RELEASE_WORKSPACE_ID } : w))
    );
  }, []);

  const createWorkspace = useCallback(
    (_ws: Omit<Workspace, 'id' | 'createdAt'>) => {
      return activeWorkspace;
    },
    [activeWorkspace]
  );

  const workspaceThemes = useMemo(
    () => themes.filter((t) => t.workspaceId === 'global' || t.workspaceId === activeWorkspace.id),
    [themes, activeWorkspace.id]
  );

  const saveTheme = useCallback((theme: DesignTheme) => {
    setThemes((prev) => {
      const exists = prev.some((t) => t.id === theme.id);
      return exists ? prev.map((t) => (t.id === theme.id ? theme : t)) : [...prev, theme];
    });
  }, []);

  const deleteTheme = useCallback((id: string) => {
    setThemes((prev) => prev.filter((t) => t.id !== id || !t.isCustom));
  }, []);

  const saveEditingPreset = useCallback((preset: EditingPreset) => {
    setEditingPresets((prev) => {
      const exists = prev.some((p) => p.id === preset.id);
      return exists ? prev.map((p) => (p.id === preset.id ? preset : p)) : [...prev, preset];
    });
  }, []);

  const workspaceProjects = useMemo(
    () =>
      projects
        .filter((p) => p.workspaceId === activeWorkspace.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects, activeWorkspace.id]
  );

  const activeProject = useMemo(
    () => workspaceProjects.find((p) => p.id === activeProjectId) || null,
    [workspaceProjects, activeProjectId]
  );

  const saveProject = useCallback((project: CreativeProject) => {
    const stamped = { ...project, updatedAt: new Date().toISOString() };
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === stamped.id);
      return exists ? prev.map((p) => (p.id === stamped.id ? stamped : p)) : [stamped, ...prev];
    });
  }, []);

  const duplicateProject = useCallback(
    (id: string) => {
      const found = projects.find((p) => p.id === id);
      if (!found) return null;
      const now = new Date().toISOString();
      const copy: CreativeProject = {
        ...JSON.parse(JSON.stringify(found)),
        id: createId('proj'),
        title: `${found.title} (Copy)`,
        createdAt: now,
        updatedAt: now,
      };
      setProjects((prev) => [copy, ...prev]);
      return copy;
    },
    [projects]
  );

  const renameProject = useCallback((id: string, title: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, title: title.trim() || p.title, updatedAt: new Date().toISOString() } : p))
    );
  }, []);

  const deleteProject = useCallback(
    async (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (activeProjectId === id) setActiveProjectId(null);
    },
    [activeProjectId]
  );

  const openProjectInEditor = useCallback((project: CreativeProject) => {
    setActiveWsId(BEHIND_THE_RELEASE_WORKSPACE_ID);
    setActiveProjectId(project.id);
    setNavSection('creative-studio');
    setStudioSubView(project.type === 'carousel' ? 'carousel-editor' : 'reels-studio');
  }, []);

  const workspaceMedia = useMemo(
    () =>
      mediaLibrary
        .filter((m) => m.workspaceId === activeWorkspace.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [mediaLibrary, activeWorkspace.id]
  );

  const addMediaAsset = useCallback(async (asset: MediaAsset, blob?: Blob) => {
    if (blob) {
      await putMediaBlob(asset.blobKey, blob);
    }
    setMediaLibrary((prev) => [asset, ...prev]);
    return asset;
  }, []);

  const deleteMediaAsset = useCallback(async (id: string) => {
    setMediaLibrary((prev) => {
      const target = prev.find((m) => m.id === id);
      if (target?.blobKey) {
        deleteMediaBlob(target.blobKey).catch(() => {});
      }
      return prev.filter((m) => m.id !== id);
    });
  }, []);

  const saveExportToMediaLibrary = useCallback(
    async (
      exportRecord: ExportRecord,
      blobs: Array<{ filename: string; blob: Blob; slideNumber?: number }>,
      targetWorkspaceId: string,
      allowDuplicateCopy = false
    ) => {
      if (targetWorkspaceId !== exportRecord.workspaceId) {
        throw new Error(
          'Cross-workspace media export is blocked to keep brand assets isolated. Switch workspaces or confirm explicit workspace ownership.'
        );
      }

      const existingSameHash = mediaLibrary.filter(
        (m) => m.workspaceId === targetWorkspaceId && m.sourceExportHash === exportRecord.exportHash
      );

      if (existingSameHash.length > 0 && !allowDuplicateCopy) {
        return { savedAssets: existingSameHash, skippedDuplicate: true };
      }

      const savedAssets: MediaAsset[] = [];
      for (let i = 0; i < blobs.length; i++) {
        const item = blobs[i];
        const blobKey = createId('blob');
        await putMediaBlob(blobKey, item.blob);

        const asset: MediaAsset = {
          id: createId('media'),
          workspaceId: targetWorkspaceId,
          name: `${exportRecord.projectName} — ${item.filename}`,
          mediaType: exportRecord.exportType === 'reel-mp4' ? 'reel-export' : 'carousel-slide',
          mimeType: item.blob.type || (exportRecord.exportType === 'reel-mp4' ? 'video/mp4' : 'image/png'),
          blobKey,
          dimensions: exportRecord.dimensions,
          duration: exportRecord.duration,
          fps: exportRecord.fps,
          projectName: exportRecord.projectName,
          themeName: exportRecord.themeName,
          slideNumber: item.slideNumber ?? i + 1,
          sourceExportHash: allowDuplicateCopy ? `${exportRecord.exportHash}-copy-${Date.now()}` : exportRecord.exportHash,
          createdAt: new Date().toISOString(),
        };
        savedAssets.push(asset);
      }

      setMediaLibrary((prev) => [...savedAssets, ...prev]);
      setExports((prev) =>
        prev.map((ex) => (ex.id === exportRecord.id ? { ...ex, savedToMediaLibrary: true } : ex))
      );

      return { savedAssets, skippedDuplicate: false };
    },
    [mediaLibrary]
  );

  const workspaceExports = useMemo(
    () =>
      exports
        .filter((e) => e.workspaceId === activeWorkspace.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [exports, activeWorkspace.id]
  );

  const addExportRecord = useCallback((record: ExportRecord) => {
    setExports((prev) => [record, ...prev]);
  }, []);

  const workspacePosts = useMemo(
    () =>
      posts
        .filter((p) => p.workspaceId === activeWorkspace.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [posts, activeWorkspace.id]
  );

  const savePost = useCallback((post: SocialPost) => {
    const stamped = { ...post, updatedAt: new Date().toISOString() };
    setPosts((prev) => {
      const exists = prev.some((p) => p.id === stamped.id);
      return exists ? prev.map((p) => (p.id === stamped.id ? stamped : p)) : [stamped, ...prev];
    });
  }, []);

  const deletePost = useCallback(
    (id: string) => {
      const target = posts.find((p) => p.id === id);
      const jobIdToDelete = target?.backendJobId || `job-${id}`;
      integrationsClient.deleteScheduledJob(jobIdToDelete).catch(() => {});
      if (user) {
        deleteScheduledJobFromFirestore(user, jobIdToDelete).catch(() => {});
      }
      setPosts((prev) => prev.filter((p) => p.id !== id));
    },
    [posts, user]
  );

  const workspaceCampaigns = useMemo(
    () => campaigns.filter((c) => c.workspaceId === activeWorkspace.id),
    [campaigns, activeWorkspace.id]
  );

  const saveCampaign = useCallback((campaign: Campaign) => {
    setCampaigns((prev) => {
      const exists = prev.some((c) => c.id === campaign.id);
      return exists ? prev.map((c) => (c.id === campaign.id ? campaign : c)) : [campaign, ...prev];
    });
  }, []);

  const deleteCampaign = useCallback((id: string) => {
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const openPostComposerWithDraft = useCallback((draft: ComposerDraftInput) => {
    setComposerDraft(draft);
    setNavSection('post-composer');
  }, []);

  const schedulePostToCalendar = useCallback(
    (input: CalendarScheduleInput) => {
      const now = new Date().toISOString();
      const postId = createId('post');
      const tz = input.timezone || DEFAULT_PUBLISHING_TIMEZONE;
      const timeVal = input.scheduledTime || '18:00';
      const scheduledIso = zonedDateTimeToUtcIso(input.scheduledDate, timeVal, tz);
      const platforms: Array<'instagram' | 'youtube'> = [
        input.platform === 'youtube-shorts' ? 'youtube' : 'instagram',
      ];

      const post: SocialPost = {
        id: postId,
        workspaceId: activeWorkspace.id,
        title: input.title,
        platform: input.platform,
        platforms,
        caption: input.caption,
        hashtags: input.hashtags,
        mediaAssetIds: input.mediaAssetIds,
        status: 'scheduled',
        scheduledDate: input.scheduledDate,
        scheduledTime: timeVal,
        timezone: tz,
        scheduledIso,
        sourceProjectId: input.sourceProjectId,
        createdAt: now,
        updatedAt: now,
      };
      setPosts((prev) => [post, ...prev]);
      setNavSection('content-calendar');

      // Persist in authoritative backend Schedule & Send queue (never auto-publishes)
      (async () => {
        try {
          const wsMedia = mediaLibrary.filter((m) => m.workspaceId === activeWorkspace.id);
          const mediaItems =
            input.mediaAssetIds.length > 0
              ? await prepareMediaItemsForPublish(input.mediaAssetIds, wsMedia, input.platform).catch(
                  () => []
                )
              : [];

          const job = await integrationsClient.syncScheduledJob({
            workspaceId: activeWorkspace.id,
            postId,
            title: input.title,
            platform: input.platform,
            platforms,
            caption: input.caption,
            hashtags: input.hashtags,
            scheduledIso,
            timezone: tz,
            mediaAssetIds: input.mediaAssetIds,
            status: 'scheduled',
            mediaItems,
          });
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId
                ? {
                    ...p,
                    status: job.status === 'ready-to-send' ? 'ready-to-send' : 'scheduled',
                    backendJobId: job.id,
                    backendStatus: job.status,
                  }
                : p
            )
          );
          if (user && user.emailVerified) {
            const [s, j, h] = await Promise.all([
              integrationsClient.getStatus(activeWorkspace.id, false),
              integrationsClient.listScheduledJobs(activeWorkspace.id),
              integrationsClient.listPublishHistory(activeWorkspace.id),
            ]);
            await syncFromServerSnapshot(activeWorkspace.id, s, j, h).catch(() => {});
          }
          notify(
            'success',
            'Scheduled for Manual Send',
            `${input.title} queued for ${input.scheduledDate} ${timeVal} (${tz}). Click Send Now when due.`
          );
        } catch (err) {
          notify(
            'warning',
            'Saved to Calendar (Backend sync pending)',
            err instanceof Error ? err.message : ''
          );
        }
      })();
    },
    [activeWorkspace.id, mediaLibrary, notify, syncFromServerSnapshot, user]
  );

  return (
    <StudioContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        setActiveWorkspaceId,
        updateWorkspace,
        createWorkspace,
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
        salesConversationId,
        setSalesConversationId,
        activeVideoProjectId,
        setActiveVideoProjectId,
        themes,
        workspaceThemes,
        saveTheme,
        deleteTheme,
        editingPresets,
        saveEditingPreset,
        projects,
        workspaceProjects,
        activeProjectId,
        activeProject,
        setActiveProjectId,
        saveProject,
        duplicateProject,
        renameProject,
        deleteProject,
        openProjectInEditor,
        mediaLibrary,
        workspaceMedia,
        addMediaAsset,
        deleteMediaAsset,
        saveExportToMediaLibrary,
        exports,
        workspaceExports,
        addExportRecord,
        posts,
        workspacePosts,
        savePost,
        deletePost,
        campaigns,
        workspaceCampaigns,
        saveCampaign,
        deleteCampaign,
        composerDraft,
        setComposerDraft,
        openPostComposerWithDraft,
        schedulePostToCalendar,
        toasts,
        notify,
        dismissToast,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
};

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used inside StudioProvider');
  return ctx;
}
