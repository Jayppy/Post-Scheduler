import React, { useState } from 'react';
import { StudioProvider, useStudio } from './context/StudioContext';
import { AppShell } from './components/layout/AppShell';
import { WorkspaceSettingsModal } from './components/hub/WorkspaceSettingsModal';
import { HubOverview } from './components/hub/HubOverview';
import { AiAssistantView } from './components/hub/AiAssistantView';
import { MediaLibraryView } from './components/hub/MediaLibraryView';
import { PostComposerView } from './components/hub/PostComposerView';
import { ContentCalendarView } from './components/hub/ContentCalendarView';
import { PublishingQueueView } from './components/hub/PublishingQueueView';
import { CampaignManagerView } from './components/hub/CampaignManagerView';
import { ConnectedAccountsView } from './components/hub/ConnectedAccountsView';
import { StudioOverview } from './components/studio/StudioOverview';
import { CarouselCreatorView } from './components/studio/CarouselCreatorView';
import { CarouselEditorView } from './components/studio/CarouselEditorView';
import { ReelsStudioView } from './components/studio/ReelsStudioView';
import { DesignThemesView } from './components/studio/DesignThemesView';
import { CreativeProjectsView } from './components/studio/CreativeProjectsView';
import { ExportHistoryView } from './components/studio/ExportHistoryView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FirebaseProvider } from './context/FirebaseContext';
import { MarketingStudioView } from './components/marketing/MarketingStudioView';
import { AiProviderDashboardView } from './components/ai/AiProviderDashboardView';
import { SalesIntelligenceView } from './components/sales/SalesIntelligenceView';
import { VideoStudioView } from './components/videoStudio/VideoStudioView';

const ActiveViewRouter: React.FC = () => {
  const { navSection, studioSubView } = useStudio();

  if (navSection === 'sales-intelligence') {
    return <SalesIntelligenceView />;
  }

  if (navSection === 'ai-providers') {
    return <AiProviderDashboardView />;
  }

  if (navSection === 'marketing-studio') {
    return <MarketingStudioView />;
  }

  if (navSection === 'creative-studio') {
    switch (studioSubView) {
      case 'carousel-creator':
        return <CarouselCreatorView />;
      case 'carousel-editor':
        return <CarouselEditorView />;
      case 'reels-studio':
        return <ReelsStudioView />;
      case 'video-studio':
        return <VideoStudioView />;
      case 'design-themes':
        return <DesignThemesView />;
      case 'creative-projects':
        return <CreativeProjectsView />;
      case 'export-history':
        return <ExportHistoryView />;
      case 'overview':
      default:
        return <StudioOverview />;
    }
  }

  switch (navSection) {
    case 'ai-assistant':
      return <AiAssistantView />;
    case 'media-library':
      return <MediaLibraryView />;
    case 'post-composer':
      return <PostComposerView />;
    case 'content-calendar':
      return <ContentCalendarView />;
    case 'publishing-queue':
      return <PublishingQueueView />;
    case 'campaign-manager':
      return <CampaignManagerView />;
    case 'connected-accounts':
      return <ConnectedAccountsView />;
    case 'hub-overview':
    default:
      return <HubOverview />;
  }
};

export default function App() {
  const [wsModalOpen, setWsModalOpen] = useState(false);

  return (
    <ErrorBoundary>
      <FirebaseProvider>
        <StudioProvider>
          <AppShell onOpenWorkspaceSettings={() => setWsModalOpen(true)}>
            <ActiveViewRouter />
          </AppShell>
          <WorkspaceSettingsModal open={wsModalOpen} onClose={() => setWsModalOpen(false)} />
        </StudioProvider>
      </FirebaseProvider>
    </ErrorBoundary>
  );
}
