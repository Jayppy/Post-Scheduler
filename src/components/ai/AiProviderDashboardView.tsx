import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sliders,
  Zap,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { useFirebase } from '../../context/FirebaseContext';
import { aiProvidersClient } from '../../services/aiProvidersClient';
import { syncAiWorkspaceConfigToFirestore } from '../../services/firebaseClient';
import type {
  AiProviderId,
  AiProvidersDashboardSnapshot,
  BusinessWorkspaceId,
  WorkspaceAiProfileConfig,
} from '../../types/aiProviders';

const AVAILABILITY_STYLES: Record<string, string> = {
  available: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  cooldown: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  disabled: 'border-zinc-700 bg-zinc-800/70 text-zinc-400',
  unconfigured: 'border-zinc-700 bg-zinc-900 text-zinc-400',
  'budget-exhausted': 'border-red-500/40 bg-red-500/10 text-red-300',
  'auth-error': 'border-red-500/50 bg-red-500/15 text-red-300',
};

const WORKSPACE_TABS: Array<{ id: BusinessWorkspaceId; label: string; subtitle: string }> = [
  {
    id: 'ws-behind-the-release',
    label: 'Behind The Release',
    subtitle: 'Creative Studio, Social Copy & Marketing Content Studio',
  },
  {
    id: 'ws-74-studio-sales',
    label: '74 STUDIO Sales Intelligence',
    subtitle: 'Lead Research, Buyer Intent, Proposals & Follow-Ups',
  },
];

export const AiProviderDashboardView: React.FC = () => {
  const { notify } = useStudio();
  const { user } = useFirebase();

  const [snapshot, setSnapshot] = useState<AiProvidersDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedWs, setSelectedWs] = useState<BusinessWorkspaceId>('ws-behind-the-release');
  const [draftConfig, setDraftConfig] = useState<WorkspaceAiProfileConfig | null>(null);
  const [savingWs, setSavingWs] = useState(false);
  const [probingProvider, setProbingProvider] = useState<AiProviderId | null>(null);
  const [verifyingCatalog, setVerifyingCatalog] = useState<AiProviderId | null>(null);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const data = await aiProvidersClient.getDashboard();
      setSnapshot(data);
      setDraftConfig(data.workspaceConfigs[selectedWs]);
    } catch (err) {
      notify(
        'error',
        'AI Provider Console failed to load',
        err instanceof Error ? err.message : 'Unable to reach AI provider manager API.'
      );
    } finally {
      setLoading(false);
    }
  }, [notify, selectedWs]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (snapshot) {
      setDraftConfig(snapshot.workspaceConfigs[selectedWs]);
    }
  }, [selectedWs, snapshot]);

  const handleTestProvider = async (providerId: AiProviderId) => {
    setProbingProvider(providerId);
    try {
      const res = await aiProvidersClient.testConnection(selectedWs, providerId);
      setSnapshot(res.snapshot);
      notify(
        res.result.ok ? 'success' : 'warning',
        `${providerId.toUpperCase()} Probe ${res.result.ok ? 'Passed' : 'Attention'}`,
        `${res.result.detail}${res.result.latencyMs ? ` (${res.result.latencyMs}ms)` : ''}`
      );
    } catch (err) {
      notify('error', 'Health probe failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setProbingProvider(null);
    }
  };

  const handleVerifyCatalog = async (providerId: AiProviderId) => {
    setVerifyingCatalog(providerId);
    try {
      const res = await aiProvidersClient.verifyCatalog(providerId);
      setSnapshot(res.snapshot);
      notify(
        res.error ? 'warning' : 'success',
        `${providerId.toUpperCase()} Free Catalog Check`,
        res.error || `Verified ${res.verifiedCount} zero-cost / free-tier model(s) via ${res.source}.`
      );
    } catch (err) {
      notify('error', 'Catalog verification failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setVerifyingCatalog(null);
    }
  };

  const handleToggleGlobalDisable = async (providerId: AiProviderId, currentlyDisabled: boolean) => {
    try {
      const res = await aiProvidersClient.updateGlobalPolicy(providerId, {
        disabledManually: !currentlyDisabled,
      });
      setSnapshot(res.snapshot);
      notify(
        'info',
        `${providerId.toUpperCase()} ${!currentlyDisabled ? 'Manually Disabled' : 'Re-enabled'}`,
        !currentlyDisabled
          ? 'Traffic will bypass this provider until re-enabled.'
          : 'Provider is eligible for routing again.'
      );
    } catch (err) {
      notify('error', 'Policy update failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleClearCooldown = async (providerId: AiProviderId) => {
    try {
      const res = await aiProvidersClient.updateGlobalPolicy(providerId, { clearCooldown: true });
      setSnapshot(res.snapshot);
      notify('success', `${providerId.toUpperCase()} cooldown cleared`);
    } catch (err) {
      notify('error', 'Cooldown clear failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleUpdateGlobalBudgets = async (
    providerId: AiProviderId,
    dailyRequestBudget: number,
    dailyTokenBudget: number
  ) => {
    try {
      const res = await aiProvidersClient.updateGlobalPolicy(providerId, {
        dailyRequestBudget,
        dailyTokenBudget,
      });
      setSnapshot(res.snapshot);
      notify('success', `Updated ${providerId.toUpperCase()} daily free-tier caps`);
    } catch (err) {
      notify('error', 'Budget update failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const moveProviderOrder = (index: number, direction: -1 | 1) => {
    if (!draftConfig) return;
    const nextIdx = index + direction;
    if (nextIdx < 0 || nextIdx >= draftConfig.providerOrder.length) return;
    const copy = [...draftConfig.providerOrder];
    const [moved] = copy.splice(index, 1);
    copy.splice(nextIdx, 0, moved);
    setDraftConfig({ ...draftConfig, providerOrder: copy });
  };

  const handleSaveWorkspaceProfile = async () => {
    if (!draftConfig) return;
    setSavingWs(true);
    try {
      const res = await aiProvidersClient.updateWorkspaceConfig(selectedWs, draftConfig);
      setSnapshot(res.snapshot);
      setDraftConfig(res.workspaceConfig);
      if (user && user.emailVerified) {
        await syncAiWorkspaceConfigToFirestore(user, res.workspaceConfig).catch(() => {});
      }
      notify(
        'success',
        `Saved ${res.workspaceConfig.workspaceLabel} AI Profile`,
        'Provider fallback chain, free-tier budgets, and model selections updated.'
      );
    } catch (err) {
      notify('error', 'Failed to save workspace profile', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSavingWs(false);
    }
  };

  const handleResetWorkspaceUsage = async () => {
    try {
      const nextSnap = await aiProvidersClient.resetWorkspaceUsage(selectedWs);
      setSnapshot(nextSnap);
      notify('info', `Reset today's usage counters for ${selectedWs}`);
    } catch (err) {
      notify('error', 'Reset failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  if (loading && !snapshot) {
    return (
      <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 text-xs text-zinc-400">
        Loading Shared AI Provider Manager Console...
      </div>
    );
  }

  if (!snapshot || !draftConfig) {
    return (
      <div className="p-8 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
        <div className="text-sm font-semibold text-zinc-200">Unable to load AI Provider Manager</div>
        <button
          type="button"
          onClick={() => void loadSnapshot()}
          className="px-3 py-2 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  const wsUsage = snapshot.workspaceUsage[selectedWs];

  return (
    <div className="space-y-6">
      {/* Header & Cost-Protection Policy Banner */}
      <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-sky-400">
            <Cpu className="w-4 h-4" />
            <span>Shared Multi-Provider AI Orchestrator</span>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mt-1">
            AI Provider Manager &amp; Free-Tier Quota Console
          </h1>
          <p className="text-xs text-zinc-400 mt-1 max-w-2xl">
            Manage server-side API keys, health probes, automatic 429/503/timeout fallback chains, and isolated daily/monthly budgets across Behind The Release and 74 STUDIO Sales Intelligence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-mono text-emerald-300">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Paid Models Blocked</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-sky-500/30 bg-sky-500/10 text-[11px] font-mono text-sky-300">
            <Zap className="w-3.5 h-3.5" />
            <span>Cloudflare: Lightweight Only</span>
          </span>
          <button
            type="button"
            onClick={() => void loadSnapshot()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Global Provider Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {snapshot.providers.map((p) => (
          <div key={p.providerId} className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-100">{p.name}</h2>
                  <span
                    className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase ${
                      AVAILABILITY_STYLES[p.availability] || AVAILABILITY_STYLES.unconfigured
                    }`}
                  >
                    {p.availability}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 mt-0.5">{p.roleLabel}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleTestProvider(p.providerId)}
                  disabled={probingProvider === p.providerId}
                  className="px-2.5 py-1.5 rounded bg-zinc-100 text-zinc-950 hover:bg-white text-[11px] font-semibold disabled:opacity-50"
                >
                  {probingProvider === p.providerId ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggleGlobalDisable(p.providerId, p.disabledManually)}
                  className={`px-2.5 py-1.5 rounded border text-[11px] font-medium ${
                    p.disabledManually
                      ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                      : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {p.disabledManually ? 'Enable' : 'Disable'}
                </button>
              </div>
            </div>

            {!p.configured && p.missingEnvVars.length > 0 && (
              <div className="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-[11px] text-amber-300 flex items-center justify-between gap-2">
                <span>
                  Missing Settings &gt; Secrets: <span className="font-mono">{p.missingEnvVars.join(', ')}</span>
                </span>
              </div>
            )}

            {p.cooldownUntil && (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 flex items-center justify-between gap-2">
                <span>
                  Cooldown until {new Date(p.cooldownUntil).toLocaleTimeString()} ({p.lastCooldownReason})
                </span>
                <button
                  type="button"
                  onClick={() => void handleClearCooldown(p.providerId)}
                  className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-100 text-[10px] font-semibold"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Today & Monthly Usage Bars */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-400">Daily Requests</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {p.todayGlobalUsage.requests} / {p.dailyRequestBudget}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full ${
                      p.budgetPctRequests >= 80 ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${Math.min(100, p.budgetPctRequests)}%` }}
                  />
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#09090b] border border-zinc-800/80 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-400">Daily Tokens</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {p.todayGlobalUsage.totalTokens.toLocaleString()} / {p.dailyTokenBudget.toLocaleString()}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full ${
                      p.budgetPctTokens >= 80 ? 'bg-amber-400' : 'bg-sky-400'
                    }`}
                    style={{ width: `${Math.min(100, p.budgetPctTokens)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Monthly Summary + Catalog Check + Global Budget Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-zinc-400 border-t border-zinc-800/70">
              <div className="font-mono tabular-nums">
                Month ({snapshot.monthKey}): {p.monthlyGlobalUsage.requests} req ·{' '}
                {p.monthlyGlobalUsage.totalTokens.toLocaleString()} tok ·{' '}
                {p.monthlyGlobalUsage.fallbacksTriggered} fallbacks
                {typeof p.lastLatencyMs === 'number' ? ` · ${p.lastLatencyMs}ms` : ''}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleVerifyCatalog(p.providerId)}
                  disabled={verifyingCatalog === p.providerId}
                  className="text-sky-400 hover:text-sky-300 underline font-medium"
                >
                  {verifyingCatalog === p.providerId ? 'Checking...' : 'Verify Catalog'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handleUpdateGlobalBudgets(
                      p.providerId,
                      p.dailyRequestBudget + 100,
                      p.dailyTokenBudget + 250000
                    )
                  }
                  className="text-zinc-400 hover:text-zinc-200"
                  title="Increase provider daily budget cap"
                >
                  +Cap
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Per-Workspace Profile Configurator */}
      <div className="p-6 rounded-xl bg-[#111114] border border-zinc-800 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-sky-400" />
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Isolated Per-Workspace Provider Profile &amp; Budget Allocation
              </h2>
              <p className="text-[11px] text-zinc-400">
                High volume in one workspace cannot exhaust the other workspace&apos;s daily request or token allocation.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {WORKSPACE_TABS.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => setSelectedWs(ws.id)}
                className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                  selectedWs === ws.id
                    ? 'bg-zinc-100 text-zinc-950'
                    : 'bg-[#09090b] border border-zinc-800 text-zinc-300 hover:border-zinc-700'
                }`}
              >
                {ws.label}
              </button>
            ))}
          </div>
        </div>

        {/* Workspace Usage Summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/80">
            <div className="text-[11px] text-zinc-400">Workspace Daily Requests</div>
            <div className="font-mono text-base font-semibold tabular-nums text-zinc-100 mt-1">
              {wsUsage.todayUsage.requests} / {wsUsage.dailyRequestBudget} ({wsUsage.requestPct}%)
            </div>
            {wsUsage.warningTriggered && (
              <div className="text-[11px] text-amber-400 flex items-center gap-1 mt-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Above {wsUsage.warningThresholdPct}% warning threshold</span>
              </div>
            )}
          </div>
          <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/80">
            <div className="text-[11px] text-zinc-400">Workspace Daily Tokens</div>
            <div className="font-mono text-base font-semibold tabular-nums text-zinc-100 mt-1">
              {wsUsage.todayUsage.totalTokens.toLocaleString()} / {wsUsage.dailyTokenBudget.toLocaleString()} (
              {wsUsage.tokenPct}%)
            </div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#09090b] border border-zinc-800/80 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-zinc-400">Monthly Total ({snapshot.monthKey})</div>
              <div className="font-mono text-sm font-semibold tabular-nums text-zinc-200 mt-1">
                {wsUsage.monthlyUsage.requests} req · {wsUsage.monthlyUsage.totalTokens.toLocaleString()} tok
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleResetWorkspaceUsage()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Today</span>
            </button>
          </div>
        </div>

        {/* Fallback Chain Ordering + Verified Free-Tier Model Selector */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Fallback Priority Chain &amp; Free-Tier Models
            </h3>
            <div className="space-y-2.5">
              {draftConfig.providerOrder.map((pid, idx) => {
                const providerInfo = snapshot.providers.find((p) => p.providerId === pid);
                const models = providerInfo?.validatedModels || [];
                return (
                  <div
                    key={pid}
                    className="p-3 rounded-lg bg-[#09090b] border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xs text-zinc-500 w-5">#{idx + 1}</span>
                      <label className="flex items-center gap-2 text-xs font-medium text-zinc-100 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(draftConfig.enabledProviders[pid])}
                          onChange={(e) =>
                            setDraftConfig({
                              ...draftConfig,
                              enabledProviders: {
                                ...draftConfig.enabledProviders,
                                [pid]: e.target.checked,
                              },
                            })
                          }
                          className="rounded border-zinc-700"
                        />
                        <span>{providerInfo?.name || pid}</span>
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={draftConfig.selectedModels[pid]}
                        onChange={(e) =>
                          setDraftConfig({
                            ...draftConfig,
                            selectedModels: { ...draftConfig.selectedModels, [pid]: e.target.value },
                          })
                        }
                        className="px-2.5 py-1.5 rounded bg-[#141418] border border-zinc-800 text-[11px] font-mono text-zinc-200 max-w-[220px]"
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} {m.lightweightOnly ? '(Lightweight)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => moveProviderOrder(idx, -1)}
                        disabled={idx === 0}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                        title="Move higher priority"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveProviderOrder(idx, 1)}
                        disabled={idx === draftConfig.providerOrder.length - 1}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                        title="Move lower priority"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Workspace Quotas & Execution Parameters */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Workspace Budgets, Limits &amp; Streaming
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Daily Request Budget</label>
                <input
                  type="number"
                  min={1}
                  max={50000}
                  value={draftConfig.dailyRequestBudget}
                  onChange={(e) =>
                    setDraftConfig({
                      ...draftConfig,
                      dailyRequestBudget: Math.max(1, Number(e.target.value) || 100),
                    })
                  }
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 font-mono text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Daily Token Budget</label>
                <input
                  type="number"
                  min={1000}
                  max={50000000}
                  step={10000}
                  value={draftConfig.dailyTokenBudget}
                  onChange={(e) =>
                    setDraftConfig({
                      ...draftConfig,
                      dailyTokenBudget: Math.max(1000, Number(e.target.value) || 100000),
                    })
                  }
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 font-mono text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Max Output Tokens</label>
                <input
                  type="number"
                  min={256}
                  max={16384}
                  step={256}
                  value={draftConfig.maxOutputTokens}
                  onChange={(e) =>
                    setDraftConfig({
                      ...draftConfig,
                      maxOutputTokens: Math.max(256, Math.min(16384, Number(e.target.value) || 2048)),
                    })
                  }
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 font-mono text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Request Timeout (ms)</label>
                <input
                  type="number"
                  min={3000}
                  max={120000}
                  step={1000}
                  value={draftConfig.requestTimeoutMs}
                  onChange={(e) =>
                    setDraftConfig({
                      ...draftConfig,
                      requestTimeoutMs: Math.max(3000, Math.min(120000, Number(e.target.value) || 35000)),
                    })
                  }
                  className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 font-mono text-zinc-100"
                />
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg bg-[#09090b] border border-zinc-800">
              <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draftConfig.streamingEnabled}
                  onChange={(e) => setDraftConfig({ ...draftConfig, streamingEnabled: e.target.checked })}
                />
                <span>Enable SSE Long-Form Streaming &amp; Section Manifest Tracking</span>
              </label>
              <span className="font-mono text-[11px] text-zinc-400">
                Warn @ {draftConfig.warningThresholdPct}%
              </span>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={savingWs}
                onClick={() => void handleSaveWorkspaceProfile()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingWs ? 'Saving Profile...' : 'Save Workspace AI Profile'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Fallbacks & Sanitized Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200 uppercase tracking-wider">
            <Activity className="w-4 h-4 text-sky-400" />
            <span>Recent Provider Fallbacks ({snapshot.recentFallbacks.length})</span>
          </div>
          {snapshot.recentFallbacks.length === 0 ? (
            <div className="text-xs text-zinc-500 py-4">
              No automatic provider switches recorded yet. Primary provider handling all requests.
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {snapshot.recentFallbacks.map((fb) => (
                <div key={fb.id} className="p-2.5 rounded bg-[#09090b] border border-zinc-800/80 text-[11px]">
                  <div className="flex items-center justify-between font-mono text-zinc-300">
                    <span>
                      {fb.fromProvider} → {fb.toProvider} ({fb.taskType})
                    </span>
                    <span className="text-zinc-500">{new Date(fb.occurredAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-zinc-400 mt-0.5">{fb.reason}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200 uppercase tracking-wider">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Sanitized Provider Error Log ({snapshot.recentErrors.length})</span>
          </div>
          {snapshot.recentErrors.length === 0 ? (
            <div className="text-xs text-zinc-500 py-4">
              Zero sanitized provider errors logged.
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {snapshot.recentErrors.map((err) => (
                <div key={err.id} className="p-2.5 rounded bg-[#09090b] border border-zinc-800/80 text-[11px]">
                  <div className="flex items-center justify-between font-mono text-red-300">
                    <span>
                      {err.providerId} [{err.errorClass}] · {err.workspaceId}
                    </span>
                    <span className="text-zinc-500">{new Date(err.occurredAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-zinc-400 mt-0.5">{err.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
