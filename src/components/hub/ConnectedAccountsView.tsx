import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Instagram,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Unlink,
  XCircle,
  Youtube,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import {
  integrationsClient,
  IntegrationsStatusResponse,
  PublishHistoryEntry,
  ScheduledJobSummary,
} from '../../services/integrationsClient';
import {
  DEFAULT_PUBLISHING_TIMEZONE,
  formatReadableDateTime,
  getPlatformLabel,
  getStatusLabel,
} from '../../utils/publishing';
import {
  isNotFoundError,
  mergeServerAndCloudHistory,
  mergeServerAndCloudJobs,
  rehydrateBackendJob,
} from '../../utils/jobRecovery';
import { SendConfirmationModal, SendModalInput } from './SendConfirmationModal';

export const ConnectedAccountsView: React.FC = () => {
  const { activeWorkspace, workspaceMedia, setNavSection, notify } = useStudio();
  const {
    user,
    authReady,
    isSigningIn,
    authError,
    signIn,
    signOut,
    cloudJobs,
    cloudHistory,
    syncFromServerSnapshot,
    subscribeWorkspace,
  } = useFirebase();

  const [status, setStatus] = useState<IntegrationsStatusResponse | null>(null);
  const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
  const [history, setHistory] = useState<PublishHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<'youtube' | 'instagram' | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [sendModalState, setSendModalState] = useState<{
    item: SendModalInput;
    defaultTargets?: Array<'instagram' | 'youtube'>;
  } | null>(null);

  const loadData = useCallback(
    async (verify = false) => {
      if (verify) setVerifying(true);
      else setLoading(true);
      try {
        const [s, j, h] = await Promise.all([
          integrationsClient.getStatus(activeWorkspace.id, verify),
          integrationsClient.listScheduledJobs(activeWorkspace.id),
          integrationsClient.listPublishHistory(activeWorkspace.id),
        ]);
        setStatus(s);
        setJobs(j);
        setHistory(h);
        if (user && user.emailVerified) {
          await syncFromServerSnapshot(activeWorkspace.id, s, j, h).catch(() => {});
        }
        if (verify) {
          notify('info', 'Authorization health verified', `Checked tokens for ${activeWorkspace.name}.`);
        }
      } catch (err) {
        notify('error', 'Could not load connection status', err instanceof Error ? err.message : '');
      } finally {
        setLoading(false);
        setVerifying(false);
      }
    },
    [activeWorkspace.id, activeWorkspace.name, notify, syncFromServerSnapshot, user]
  );

  useEffect(() => {
    loadData(false);
  }, [loadData]);

  useEffect(() => {
    return subscribeWorkspace(activeWorkspace.id);
  }, [activeWorkspace.id, subscribeWorkspace]);

  // Listen for OAuth popup completion
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setConnectingPlatform(null);
        notify(
          'success',
          `${event.data.platform === 'youtube' ? 'YouTube' : 'Instagram'} connected`,
          `${event.data.accountName} linked exclusively to ${activeWorkspace.name}.`
        );
        loadData(false);
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setConnectingPlatform(null);
        notify('error', 'Account connection failed', event.data.error || 'Authorization cancelled.');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeWorkspace.name, loadData, notify]);

  const handleConnect = async (platform: 'youtube' | 'instagram') => {
    setConnectingPlatform(platform);
    try {
      const authUrl = await integrationsClient.getOAuthUrl(activeWorkspace.id, platform);
      const popup = window.open(authUrl, `${platform}_oauth_${activeWorkspace.id}`, 'width=640,height=760');
      if (!popup) {
        setConnectingPlatform(null);
        notify('warning', 'Popup blocked', 'Allow popups in your browser to complete OAuth sign-in.');
      }
    } catch (err) {
      setConnectingPlatform(null);
      notify(
        'warning',
        `${platform === 'youtube' ? 'YouTube' : 'Instagram'} configuration required`,
        err instanceof Error ? err.message : ''
      );
    }
  };

  const handleDisconnect = async (platform: 'youtube' | 'instagram') => {
    try {
      await integrationsClient.disconnect(activeWorkspace.id, platform);
      notify('info', `${platform === 'youtube' ? 'YouTube' : 'Instagram'} disconnected from ${activeWorkspace.name}`);
      loadData(false);
    } catch (err) {
      notify('error', 'Disconnect failed', err instanceof Error ? err.message : '');
    }
  };

  const openJobSendModal = (job: ScheduledJobSummary) => {
    const remainingTargets = job.destinations
      ?.filter((d) => d.status !== 'published' && d.status !== 'cancelled')
      .map((d) => d.platform);
    setSendModalState({
      item: {
        id: job.id,
        postId: job.postId,
        title: job.title,
        platform: job.platform,
        platforms: job.platforms,
        destinations: job.destinations,
        caption: job.caption,
        hashtags: job.hashtags,
        youtubePrivacyStatus: job.youtubePrivacyStatus,
        scheduledIso: job.scheduledIso,
        timezone: job.timezone,
        mediaAssetIds: job.mediaAssetIds,
        mediaCount: job.mediaCount,
        mediaPreviews: job.mediaPreviews,
        status: job.status,
      },
      defaultTargets: remainingTargets,
    });
  };

  const mergedJobs = useMemo(
    () => mergeServerAndCloudJobs(jobs, cloudJobs),
    [jobs, cloudJobs]
  );

  const mergedHistory = useMemo(
    () => mergeServerAndCloudHistory(history, cloudHistory),
    [history, cloudHistory]
  );

  const handleCancelJob = async (job: ScheduledJobSummary) => {
    setBusyJobId(job.id);
    try {
      try {
        await integrationsClient.cancelScheduledJob(job.id);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        await rehydrateBackendJob(
          {
            workspaceId: activeWorkspace.id,
            postId: job.postId,
            jobId: job.id,
            title: job.title,
            platform: job.platform,
            platforms: job.platforms,
            destinations: job.destinations,
            caption: job.caption,
            hashtags: job.hashtags,
            youtubePrivacyStatus: job.youtubePrivacyStatus,
            scheduledIso: job.scheduledIso,
            timezone: job.timezone,
            campaignId: job.campaignId,
            mediaAssetIds: job.mediaAssetIds,
            mediaCount: job.mediaCount,
            status: 'cancelled',
            attempts: job.attempts,
            publishedAt: job.publishedAt,
            platformPostId: job.platformPostId,
            resultUrl: job.resultUrl,
            error: job.error,
          },
          workspaceMedia
        );
      }
      notify('info', 'Scheduled job cancelled');
      await loadData(false);
    } catch (err) {
      notify('error', 'Cancel failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyJobId(null);
    }
  };

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    notify('info', `${label} copied`);
  };

  const ytCallback =
    status?.youtube.callbackUrl || `${window.location.origin}/api/auth/youtube/callback`;
  const igCallback =
    status?.instagram.callbackUrl || `${window.location.origin}/api/auth/instagram/callback`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Connected Accounts</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">
            Instagram Unified Login &amp; YouTube Connections
          </h1>
          <p className="text-xs text-zinc-400 mt-1 max-w-2xl">
            Manage persistent social publishing accounts for{' '}
            <span className="text-zinc-200 font-semibold">{activeWorkspace.name}</span>. OAuth tokens are encrypted server-side and renewed automatically.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => loadData(true)}
            disabled={verifying}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:border-zinc-600"
            title="Verify stored OAuth token health with Meta and Google"
          >
            <ShieldCheck className={`w-3.5 h-3.5 ${verifying ? 'animate-pulse' : ''}`} />
            <span>{verifying ? 'Verifying...' : 'Verify Auth'}</span>
          </button>
          <button
            type="button"
            onClick={() => loadData(false)}
            className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100"
            title="Refresh status"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Firebase Firestore Cloud Sync Bar */}
      <div className="p-4 rounded-xl bg-[#111114] border border-zinc-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-[#09090b] border border-zinc-800 text-zinc-200">
            <Cloud className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-zinc-100 flex items-center gap-2">
              <span>Cloud Firestore Sync (Connections, Jobs &amp; Audit History)</span>
              {user && (
                <span className="text-[11px] font-mono text-emerald-400">
                  · Synced ({cloudJobs.length} jobs / {cloudHistory.length} logs)
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {user
                ? `Signed in as ${user.email || user.displayName}. OAuth secrets stay encrypted server-side while status, schedule jobs, and error logs sync to Firestore.`
                : 'Sign in with Google to mirror workspace account status, scheduled jobs, and publishing audit history to Cloud Firestore.'}
            </p>
            {authError && <p className="text-[11px] text-red-400 mt-1">{authError}</p>}
          </div>
        </div>

        <div className="shrink-0">
          {!authReady ? (
            <span className="text-xs text-zinc-500">Checking auth...</span>
          ) : user ? (
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-300"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={signIn}
              disabled={isSigningIn}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-60"
            >
              {isSigningIn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
              <span>Sign In with Google for Firestore Sync</span>
            </button>
          )}
        </div>
      </div>

      {/* Platform Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* YouTube Card */}
        <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-zinc-100">
                <Youtube className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-zinc-100">YouTube (Shorts & Video)</h2>
                <p className="text-xs text-zinc-400">
                  Google OAuth 2.0 + YouTube Data API v3 Resumable Upload
                </p>
              </div>
            </div>

            {status?.youtube.connected ? (
              status.youtube.needsReconnect || status.youtube.lastError ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Needs Reconnect</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {status.youtube.hasRefreshToken ? 'Authorized · Persistent' : 'Authorized'}
                  </span>
                </span>
              )
            ) : (
              <span className="text-xs text-zinc-500">Not connected</span>
            )}
          </div>

          {status?.youtube.connected ? (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Connected Channel ({activeWorkspace.name})</span>
                <span className="font-mono text-[10px] text-zinc-500">
                  {status.youtube.hasRefreshToken ? 'Offline Refresh Stored' : 'No Refresh Token'}
                </span>
              </div>
              <div className="text-sm font-semibold text-zinc-100">
                {status.youtube.accountName}
                {status.youtube.accountHandle ? ` (${status.youtube.accountHandle})` : ''}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">
                Channel ID: {status.youtube.accountId}
                {status.youtube.expiresAt
                  ? ` · Access token auto-renews (current exp ${new Date(
                      status.youtube.expiresAt
                    ).toLocaleTimeString()})`
                  : ''}
              </div>
              {status.youtube.lastError && (
                <div className="mt-2 p-2.5 rounded border border-red-500/40 bg-red-950/20 text-xs text-red-200">
                  {status.youtube.lastError}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2 text-xs text-zinc-400">
              {!status?.youtube.configured && (
                <div className="flex items-start gap-2 text-amber-300 pb-1">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Missing Secrets:{' '}
                    <span className="font-mono text-amber-200">
                      {(status?.youtube.missingVars || ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']).join(', ')}
                    </span>{' '}
                    in AI Studio <strong className="text-amber-100">Settings &gt; Secrets</strong>.
                  </span>
                </div>
              )}
              <div>Authorized Redirect URI for Google Cloud Console:</div>
              <div className="flex items-center justify-between gap-2 p-2 rounded bg-[#141418] border border-zinc-800 font-mono text-[11px] text-zinc-200">
                <span className="truncate">{ytCallback}</span>
                <button
                  type="button"
                  onClick={() => copyText(ytCallback, 'YouTube Redirect URI')}
                  className="text-zinc-400 hover:text-zinc-100 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {status?.youtube.connected ? (
              <>
                <button
                  type="button"
                  onClick={() => handleConnect('youtube')}
                  disabled={connectingPlatform === 'youtube'}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs font-medium text-zinc-200"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reconnect</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDisconnect('youtube')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-zinc-800 hover:border-red-500/60 text-xs font-medium text-zinc-300"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  <span>Disconnect YouTube</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={connectingPlatform === 'youtube'}
                onClick={() => handleConnect('youtube')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-60 text-xs font-semibold"
              >
                {connectingPlatform === 'youtube' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                <span>Connect YouTube for {activeWorkspace.name}</span>
              </button>
            )}
          </div>
        </div>

        {/* Instagram Unified Login Card */}
        <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-zinc-100">
                <Instagram className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-zinc-100">
                  Instagram (Carousels, Reels & Feed)
                </h2>
                <p className="text-xs text-zinc-400">
                  Meta Unified Login (Facebook Login for Business · Graph API v21.0)
                </p>
              </div>
            </div>

            {status?.instagram.connected ? (
              status.instagram.lastError ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Needs Reconnect</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Authorized</span>
                </span>
              )
            ) : (
              <span className="text-xs text-zinc-500">Not connected</span>
            )}
          </div>

          {status?.instagram.connected ? (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Connected Account ({activeWorkspace.name})</span>
                {status.instagram.tokenType && (
                  <span className="font-mono text-[10px] text-zinc-500">
                    Token: {status.instagram.tokenType}
                  </span>
                )}
              </div>
              <div className="text-sm font-semibold text-zinc-100">
                {status.instagram.accountHandle ? `@${status.instagram.accountHandle}` : status.instagram.accountName}
                {status.instagram.accountHandle && status.instagram.accountName !== `@${status.instagram.accountHandle}`
                  ? ` · ${status.instagram.accountName}`
                  : ''}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">
                IG Account ID: {status.instagram.accountId}
              </div>
              {status.instagram.lastError && (
                <div className="mt-2 p-2.5 rounded border border-red-500/40 bg-red-950/20 text-xs text-red-200">
                  {status.instagram.lastError}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-2 text-xs text-zinc-400">
              {!status?.instagram.configured && (
                <div className="flex items-start gap-2 text-amber-300 pb-1">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Missing Unified Login Secrets:{' '}
                    <span className="font-mono text-amber-200">
                      {(status?.instagram.missingVars || ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID']).join(', ')}
                    </span>{' '}
                    in AI Studio <strong className="text-amber-100">Settings &gt; Secrets</strong>.
                  </span>
                </div>
              )}
              <div>
                Uses Meta Unified Login (`config_id`). Set this exact Valid OAuth Redirect URI in your Meta Business Login configuration:
              </div>
              <div className="flex items-center justify-between gap-2 p-2 rounded bg-[#141418] border border-zinc-800 font-mono text-[11px] text-zinc-200">
                <span className="truncate">{igCallback}</span>
                <button
                  type="button"
                  onClick={() => copyText(igCallback, 'Instagram Redirect URI')}
                  className="text-zinc-400 hover:text-zinc-100 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {status?.instagram.connected ? (
              <>
                <button
                  type="button"
                  onClick={() => handleConnect('instagram')}
                  disabled={connectingPlatform === 'instagram'}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs font-medium text-zinc-200"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reconnect</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDisconnect('instagram')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-zinc-800 hover:border-red-500/60 text-xs font-medium text-zinc-300"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  <span>Disconnect Instagram</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={connectingPlatform === 'instagram'}
                onClick={() => handleConnect('instagram')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-60 text-xs font-semibold"
              >
                {connectingPlatform === 'instagram' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                <span>Connect Instagram for {activeWorkspace.name}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Manual Schedule & Send Workspace Queue */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">
              Manual Schedule &amp; Send Queue ({activeWorkspace.name})
            </h3>
            <p className="text-xs text-zinc-400">
              Server-side queue for {activeWorkspace.name} only (never auto-publishes). Supports manual Send Now, partial Retry, and Cancel.
            </p>
          </div>
          <span className="font-mono text-xs text-zinc-400 tabular-nums">{mergedJobs.length} job(s)</span>
        </div>

        {mergedJobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">
            No scheduled posts for {activeWorkspace.name} yet. Schedule or draft a post in Post Composer.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/70">
            {mergedJobs.map((job) => (
              <div key={job.id} className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100 truncate">{job.title}</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5 font-mono tabular-nums">
                    {(job.platforms || [job.platform]).map((p) => getPlatformLabel(p)).join(' + ')} ·{' '}
                    {formatReadableDateTime(job.scheduledIso, job.timezone || DEFAULT_PUBLISHING_TIMEZONE)} ·{' '}
                    {job.mediaCount} file(s) · attempts: {job.attempts}
                  </div>
                  {job.error && <div className="text-[11px] text-red-400 mt-1">{job.error}</div>}
                </div>

                <div className="flex items-center gap-2.5">
                  <span
                    className={`text-xs font-medium ${
                      job.status === 'published'
                        ? 'text-emerald-400'
                        : job.status === 'ready-to-send' || job.status === 'partially-published'
                          ? 'text-amber-300'
                          : job.status === 'failed'
                            ? 'text-red-400'
                            : job.status === 'cancelled'
                              ? 'text-zinc-500'
                              : 'text-zinc-300'
                    }`}
                  >
                    {getStatusLabel(job.status)}
                  </span>

                  {job.status !== 'published' &&
                    job.status !== 'publishing' &&
                    job.status !== 'cancelled' && (
                      <button
                        type="button"
                        disabled={busyJobId === job.id}
                        onClick={() => openJobSendModal(job)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-100 text-zinc-950 text-[11px] font-semibold"
                      >
                        {job.status === 'failed' || job.status === 'partially-published' ? (
                          <RotateCcw className="w-3 h-3" />
                        ) : (
                          <Send className="w-3 h-3" />
                        )}
                        <span>
                          {job.status === 'failed' || job.status === 'partially-published'
                            ? 'Retry'
                            : 'Send Now'}
                        </span>
                      </button>
                    )}

                  {(job.status === 'scheduled' || job.status === 'ready-to-send') && (
                    <button
                      type="button"
                      disabled={busyJobId === job.id}
                      onClick={() => handleCancelJob(job)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-red-500/60"
                    >
                      <XCircle className="w-3 h-3" />
                      <span>Cancel</span>
                    </button>
                  )}

                  {job.resultUrl && (
                    <a
                      href={job.resultUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-zinc-200 hover:text-white underline"
                    >
                      <span>View Live</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Publishing History */}
      {mergedHistory.length > 0 && (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
            Recent Server Publishing Audit Log ({mergedHistory.length})
          </div>
          <div className="divide-y divide-zinc-800/70">
            {mergedHistory.slice(0, 10).map((entry) => (
              <div key={entry.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-zinc-100 truncate">{entry.title}</div>
                  <div className="text-[11px] font-mono text-zinc-500">
                    {entry.platform} · {entry.mode} · {new Date(entry.timestamp).toLocaleString()}
                  </div>
                  {entry.error && <div className="text-[11px] text-red-400 mt-0.5">{entry.error}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <span className={entry.status === 'published' ? 'text-emerald-400' : 'text-red-400'}>
                    {entry.status}
                  </span>
                  {entry.resultUrl && (
                    <a
                      href={entry.resultUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-200 underline inline-flex items-center gap-1"
                    >
                      <span>Live Link</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <SendConfirmationModal
        open={Boolean(sendModalState)}
        onClose={() => setSendModalState(null)}
        item={sendModalState?.item || null}
        defaultTargets={sendModalState?.defaultTargets}
        workspace={activeWorkspace}
        connStatus={status}
        mediaAssets={workspaceMedia}
        onOpenConnectedAccounts={() => setNavSection('connected-accounts')}
        onCompleted={async (res) => {
          await loadData(false);
          if (!res.partialError) {
            notify('success', 'Published', res.job?.resultUrl || 'Post delivered.');
          } else {
            notify('warning', 'Partial or Failed Send', res.partialError);
          }
        }}
      />
    </div>
  );
};
