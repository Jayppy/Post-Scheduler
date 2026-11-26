import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  Database,
  Edit3,
  ExternalLink,
  ImagePlus,
  Loader2,
  Menu,
  MessageSquarePlus,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { salesClient } from '../../services/salesClient';
import { getOperatorAuthHeaders } from '../../services/authHeaders';
import type {
  SalesChatMessage,
  SalesConversation,
  SalesKbCustomEntry,
  SalesKnowledgeBase,
  SalesStudioSettings,
} from '../../types/sales';

interface PersistenceDiagnostics {
  supabaseConfigured?: boolean;
  supabaseTablesReachable?: boolean;
  reachableTables?: string[];
  missingTables?: string[];
  supabase?: {
    configured: boolean;
    urlPresent?: boolean;
    anonKeyPresent?: boolean;
    serviceRolePresent?: boolean;
  };
  localFiles?: Array<{ file: string; exists: boolean; recordCountHint: number }>;
  supabaseCounts?: Record<string, number>;
  error?: string;
}

export const SalesIntelligenceView: React.FC = () => {
  const {
    salesSubView,
    setSalesSubView,
    salesConversationId,
    setSalesConversationId,
    notify,
  } = useStudio();

  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<SalesConversation[]>([]);
  const [knowledgeBase, setKnowledgeBase] = useState<SalesKnowledgeBase | null>(null);
  const [settings, setSettings] = useState<SalesStudioSettings | null>(null);

  // Chat workspace state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteConv, setConfirmDeleteConv] = useState<SalesConversation | null>(null);

  // Composer state
  const [artistInput, setArtistInput] = useState('');
  const [showBriefOptions, setShowBriefOptions] = useState(false);
  const [artistNote, setArtistNote] = useState('');
  const [customGuidance, setCustomGuidance] = useState('');
  const [attachmentName, setAttachmentName] = useState('');
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Message editing & copying
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editMsgDraft, setEditMsgDraft] = useState('');
  const [regeneratingMsgId, setRegeneratingMsgId] = useState<string | null>(null);

  // KB state
  const [kbSearch, setKbSearch] = useState('');
  const [savingKb, setSavingKb] = useState(false);
  const [newEntryTitle, setNewEntryTitle] = useState('');
  const [newEntryCat, setNewEntryCat] = useState<SalesKbCustomEntry['category']>('faq');
  const [newEntryContent, setNewEntryContent] = useState('');

  // Settings & Persistence state
  const [savingSettings, setSavingSettings] = useState(false);
  const [persistenceDiag, setPersistenceDiag] = useState<PersistenceDiagnostics | null>(null);
  const [runningMigration, setRunningMigration] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    try {
      const [convList, kb, cfg] = await Promise.all([
        salesClient.listConversations(),
        salesClient.getKnowledgeBase(),
        salesClient.getSettings(),
      ]);
      setConversations(convList);
      setKnowledgeBase(kb);
      setSettings(cfg);

      if (convList.length > 0) {
        const hasValidRouteConv =
          salesConversationId && convList.some((c) => c.id === salesConversationId);
        if (!hasValidRouteConv) {
          setSalesConversationId(convList[0].id);
        }
      }
    } catch (err) {
      notify(
        'error',
        'Could not load 74 STUDIO Artist Assistant',
        err instanceof Error ? err.message : ''
      );
    } finally {
      setLoading(false);
    }
  }, [notify, salesConversationId, setSalesConversationId]);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  const loadPersistenceDiagnostics = useCallback(async () => {
    try {
      const headers = await getOperatorAuthHeaders();
      const res = await fetch('/api/system/persistence-status', { headers });
      if (res.ok) {
        const data = (await res.json()) as PersistenceDiagnostics;
        setPersistenceDiag(data);
      }
    } catch {
      // ignore background diagnostics fetch failures
    }
  }, []);

  useEffect(() => {
    if (salesSubView === 'settings') {
      loadPersistenceDiagnostics();
    }
  }, [salesSubView, loadPersistenceDiagnostics]);

  const activeConversation = useMemo(
    () =>
      conversations.find((c) => c.id === salesConversationId) || conversations[0] || null,
    [conversations, salesConversationId]
  );

  const filteredConversations = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.artistName || '').toLowerCase().includes(q) ||
        (c.lastMessagePreview || '').toLowerCase().includes(q)
    );
  }, [conversations, chatSearch]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.id, activeConversation?.messages.length]);

  const handleNewChat = async () => {
    try {
      const conv = await salesClient.createConversation('New Artist Conversation');
      setConversations((prev) => [conv, ...prev]);
      setSalesConversationId(conv.id);
      setSalesSubView('chat');
      setSidebarOpen(false);
      setSendError(null);
    } catch (err) {
      notify('error', 'Could not create conversation', err instanceof Error ? err.message : '');
    }
  };

  const handleSelectConversation = (convId: string) => {
    setSalesConversationId(convId);
    setSalesSubView('chat');
    setSidebarOpen(false);
    setSendError(null);
  };

  const handleStartRename = (conv: SalesConversation) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      const updated = await salesClient.renameConversation(id, trimmed);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      setRenamingId(null);
    } catch (err) {
      notify('error', 'Rename failed', err instanceof Error ? err.message : '');
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteConv) return;
    const targetId = confirmDeleteConv.id;
    try {
      await salesClient.deleteConversation(targetId);
      const remaining = conversations.filter((c) => c.id !== targetId);
      setConversations(remaining);
      if (salesConversationId === targetId) {
        setSalesConversationId(remaining[0]?.id || null);
      }
      setConfirmDeleteConv(null);
      notify('info', 'Conversation deleted');
    } catch (err) {
      notify('error', 'Delete failed', err instanceof Error ? err.message : '');
    }
  };

  const handleAttachmentPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentName(file.name);
    if (file.type.startsWith('image/') && file.size <= 3 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setAttachmentPreviewUrl(reader.result);
        }
      };
      reader.readAsDataURL(file);
    } else {
      setAttachmentPreviewUrl('');
    }
    e.target.value = '';
  };

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const messageText = artistInput.trim();
    if (!messageText || sending) return;

    setSending(true);
    setSendError(null);
    try {
      let targetConvId = activeConversation?.id;
      if (!targetConvId) {
        const created = await salesClient.createConversation(messageText.slice(0, 48));
        setConversations((prev) => [created, ...prev]);
        setSalesConversationId(created.id);
        targetConvId = created.id;
      }

      const result = await salesClient.sendArtistMessage(targetConvId, {
        artistMessage: messageText,
        artistNote: artistNote.trim() || undefined,
        attachmentName: attachmentName || undefined,
        attachmentPreviewUrl: attachmentPreviewUrl || undefined,
        customGuidance: customGuidance.trim() || undefined,
      });

      setConversations((prev) => {
        const updatedList = prev.map((c) =>
          c.id === result.conversation.id ? result.conversation : c
        );
        return updatedList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      setSalesConversationId(result.conversation.id);
      setArtistInput('');
      setArtistNote('');
      setCustomGuidance('');
      setAttachmentName('');
      setAttachmentPreviewUrl('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate reply.';
      setSendError(msg);
      notify('error', 'Reply generation failed', msg);
    } finally {
      setSending(false);
    }
  };

  const handleRegenerate = async (assistantMessageId: string) => {
    if (!activeConversation || regeneratingMsgId) return;
    setRegeneratingMsgId(assistantMessageId);
    setSendError(null);
    try {
      const result = await salesClient.sendArtistMessage(activeConversation.id, {
        regenerateForMessageId: assistantMessageId,
        customGuidance: customGuidance.trim() || undefined,
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === result.conversation.id ? result.conversation : c))
      );
    } catch (err) {
      notify('error', 'Regenerate failed', err instanceof Error ? err.message : '');
    } finally {
      setRegeneratingMsgId(null);
    }
  };

  const handleSaveEditedReply = async (msg: SalesChatMessage) => {
    if (!activeConversation) return;
    const trimmed = editMsgDraft.trim();
    if (!trimmed) return;
    try {
      const result = await salesClient.editMessage(activeConversation.id, msg.id, trimmed);
      setConversations((prev) =>
        prev.map((c) => (c.id === result.conversation.id ? result.conversation : c))
      );
      setEditingMsgId(null);
      notify('success', 'Reply updated (strict lowercase preserved)');
    } catch (err) {
      notify('error', 'Failed to save edit', err instanceof Error ? err.message : '');
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      notify('warning', 'Clipboard access unavailable');
    }
  };

  const handleSaveKb = async () => {
    if (!knowledgeBase) return;
    setSavingKb(true);
    try {
      const saved = await salesClient.saveKnowledgeBase(knowledgeBase);
      setKnowledgeBase(saved);
      notify('success', '74 STUDIO Knowledge Base saved');
    } catch (err) {
      notify('error', 'Failed to save knowledge base', err instanceof Error ? err.message : '');
    } finally {
      setSavingKb(false);
    }
  };

  const handleAddKbEntry = () => {
    if (!knowledgeBase || !newEntryTitle.trim() || !newEntryContent.trim()) return;
    const entry: SalesKbCustomEntry = {
      id: `kb-${Date.now().toString(36)}`,
      title: newEntryTitle.trim(),
      category: newEntryCat,
      content: newEntryContent.trim(),
      updatedAt: new Date().toISOString(),
    };
    setKnowledgeBase({
      ...knowledgeBase,
      customEntries: [entry, ...(knowledgeBase.customEntries || [])],
    });
    setNewEntryTitle('');
    setNewEntryContent('');
  };

  const handleDeleteKbEntry = (entryId: string) => {
    if (!knowledgeBase) return;
    setKnowledgeBase({
      ...knowledgeBase,
      customEntries: (knowledgeBase.customEntries || []).filter((e) => e.id !== entryId),
    });
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const saved = await salesClient.saveSettings(settings);
      setSettings(saved);
      notify('success', '74 STUDIO Promo & Assistant Settings saved');
    } catch (err) {
      notify('error', 'Failed to save settings', err instanceof Error ? err.message : '');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRunMigration = async (dryRun: boolean) => {
    setRunningMigration(true);
    setMigrationMessage(null);
    try {
      const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/json' });
      const res = await fetch('/api/system/migrate-to-supabase', {
        method: 'POST',
        headers,
        body: JSON.stringify({ dryRun }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMigrationMessage(data.error || 'Migration failed');
        notify('warning', 'Migration status', data.error || 'Supabase keys not configured.');
      } else {
        const counts = data.report?.counts || data.counts || {};
        setMigrationMessage(
          dryRun
            ? `Dry run passed: ${JSON.stringify(counts)}`
            : `Migration complete: ${JSON.stringify(counts)}`
        );
        notify('success', dryRun ? 'Dry-run complete' : 'Migrated to Supabase');
        loadPersistenceDiagnostics();
      }
    } catch (err) {
      setMigrationMessage(err instanceof Error ? err.message : 'Migration request failed');
    } finally {
      setRunningMigration(false);
    }
  };

  const filteredServices = useMemo(() => {
    if (!knowledgeBase) return [];
    const q = kbSearch.trim().toLowerCase();
    if (!q) return knowledgeBase.services;
    return knowledgeBase.services.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.deliverables.some((d) => d.toLowerCase().includes(q)) ||
        (s.tiers || []).some((t) => t.tierName.toLowerCase().includes(q) || t.priceLabel.toLowerCase().includes(q))
    );
  }, [knowledgeBase, kbSearch]);

  if (loading && !settings) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-400 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
        <span>Loading 74 STUDIO Artist Assistant…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Workspace Tabs + Promo Status Summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-sky-900/35">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0d1420] border border-sky-900/40">
          <button
            type="button"
            onClick={() => setSalesSubView('chat')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              salesSubView === 'chat'
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-zinc-300 hover:text-zinc-100'
            }`}
          >
            Artist Chat Assistant
          </button>
          <button
            type="button"
            onClick={() => setSalesSubView('knowledge-base')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              salesSubView === 'knowledge-base'
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-zinc-300 hover:text-zinc-100'
            }`}
          >
            Knowledge Base &amp; Pricing
          </button>
          <button
            type="button"
            onClick={() => setSalesSubView('settings')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              salesSubView === 'settings'
                ? 'bg-sky-500 text-slate-950 font-semibold'
                : 'text-zinc-300 hover:text-zinc-100'
            }`}
          >
            Promo &amp; Settings
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span>
            Replies: <strong className="text-sky-300 font-medium">strict lowercase</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Offer:{' '}
            <strong className={settings?.promoEnabled ? 'text-emerald-400 font-medium' : 'text-zinc-400 font-medium'}>
              {settings?.promoEnabled ? `${settings.promoPercentage}% off active` : 'Standard pricing'}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <a
            href={knowledgeBase?.contactPageUrl || 'https://74-studio.com/contact'}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 whitespace-nowrap"
          >
            <span>74-studio.com/contact</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* VIEW 1: CHAT-FIRST ARTIST ASSISTANT */}
      {salesSubView === 'chat' && (
        <div className="relative flex h-[calc(100vh-11.5rem)] min-h-[540px] rounded-xl border border-sky-900/40 bg-[#0b1017] overflow-hidden">
          {/* Mobile sidebar overlay */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/70 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          {/* Left Conversation Sidebar */}
          <aside
            className={`fixed inset-y-0 left-0 z-40 w-[280px] bg-[#0a0f16] border-r border-sky-900/40 flex flex-col transition-transform lg:static lg:translate-x-0 ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="p-3 border-b border-sky-900/30 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  <MessageSquarePlus className="w-3.5 h-3.5" />
                  <span>New Chat</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  className="lg:hidden p-2 text-zinc-400 hover:text-zinc-200"
                  aria-label="Close chats"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)}
                  placeholder="Search artist chats…"
                  className="w-full pl-8 pr-3 py-1.5 rounded-md bg-[#0f1722] border border-sky-900/40 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredConversations.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-zinc-500">
                  No conversations match your filter.
                </div>
              ) : (
                filteredConversations.map((conv) => {
                  const isActive = activeConversation?.id === conv.id;
                  const isRenaming = renamingId === conv.id;
                  return (
                    <div
                      key={conv.id}
                      className={`group rounded-lg px-2.5 py-2 transition-colors ${
                        isActive
                          ? 'bg-[#122032] border border-sky-500/40'
                          : 'border border-transparent hover:bg-[#101824]'
                      }`}
                    >
                      {isRenaming ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveRename(conv.id);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            autoFocus
                            className="flex-1 min-w-0 bg-[#090e15] border border-sky-500/60 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveRename(conv.id)}
                            className="p-1 text-sky-400 hover:text-sky-300"
                            aria-label="Save title"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSelectConversation(conv.id)}
                            className="flex-1 min-w-0 text-left"
                          >
                            <div
                              className={`text-xs font-medium truncate ${
                                isActive ? 'text-sky-100' : 'text-zinc-200'
                              }`}
                            >
                              {conv.title}
                            </div>
                            <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                              {conv.lastMessagePreview || 'Empty artist thread'}
                            </div>
                          </button>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                            <button
                              type="button"
                              onClick={() => handleStartRename(conv)}
                              className="p-1 text-zinc-500 hover:text-zinc-200"
                              aria-label="Rename conversation"
                              title="Rename"
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteConv(conv)}
                              className="p-1 text-zinc-500 hover:text-red-400"
                              aria-label="Delete conversation"
                              title="Delete"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          {/* Main Chat Thread Area */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Chat Header */}
            <div className="px-4 py-3 border-b border-sky-900/30 bg-[#0d141e] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="lg:hidden p-1.5 rounded-md border border-sky-900/50 text-zinc-300 hover:text-white"
                  aria-label="Open chat list"
                >
                  <Menu className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-100 truncate">
                    {activeConversation?.title || '74 STUDIO Artist Assistant'}
                  </h2>
                  <p className="text-[11px] text-zinc-400 truncate">
                    Paste what the artist said · Get a natural lowercase Discord-ready reply using verified pricing
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleNewChat}
                className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-sky-500 text-slate-950 text-xs font-semibold shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New</span>
              </button>
            </div>

            {/* Thread Messages */}
            <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-5">
              {!activeConversation || activeConversation.messages.length === 0 ? (
                <div className="max-w-xl mx-auto py-12 text-center space-y-3">
                  <h3 className="text-base font-semibold text-zinc-100">
                    74 STUDIO Artist Reply Assistant
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Paste any Discord DM, inquiry, or objection from a recording artist, producer, or label below. Replies stay in strict lowercase, match the artist’s awareness stage silently, apply the active{' '}
                    {settings?.promoEnabled ? `${settings.promoPercentage}% promo` : 'current pricing'}, and route ready buyers to{' '}
                    <span className="text-sky-400">https://74-studio.com/contact</span>.
                  </p>
                  <div className="pt-2 flex flex-wrap justify-center gap-2">
                    {[
                      'hey bro i need mixing for my new single, how much do you charge?',
                      'yo do you guys do cover art without ai? how does it work?',
                      'looking for full promo for my next drop, what are your rates?',
                    ].map((sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => setArtistInput(sample)}
                        className="text-left px-3 py-2 rounded-lg border border-sky-900/40 bg-[#101824] hover:border-sky-500/50 text-xs text-zinc-300 transition-colors"
                      >
                        “{sample}”
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                activeConversation.messages.map((msg) => {
                  const isArtist = msg.role === 'artist';
                  const isEditing = editingMsgId === msg.id;
                  const isRegen = regeneratingMsgId === msg.id;

                  return (
                    <div
                      key={msg.id}
                      className={`max-w-3xl mx-auto flex flex-col ${
                        isArtist ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1 text-[11px] text-zinc-500">
                        <span>{isArtist ? 'Artist message' : '74 STUDIO reply'}</span>
                        {!isArtist && msg.providerId && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{msg.providerId}</span>
                          </>
                        )}
                        {msg.edited && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>edited</span>
                          </>
                        )}
                      </div>

                      <div
                        className={`w-full sm:w-auto max-w-[88%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                          isArtist
                            ? 'bg-[#132236] border border-sky-800/50 text-zinc-100'
                            : 'bg-[#12161f] border border-zinc-800 text-zinc-100'
                        }`}
                      >
                        {isEditing ? (
                          <div className="space-y-2.5 min-w-[260px] sm:min-w-[420px]">
                            <textarea
                              value={editMsgDraft}
                              onChange={(e) => setEditMsgDraft(e.target.value)}
                              rows={3}
                              className="w-full rounded-lg bg-[#090e15] border border-sky-500/50 p-2.5 text-sm text-zinc-100 focus:outline-none"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditingMsgId(null)}
                                className="px-3 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveEditedReply(msg)}
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-sky-500 text-slate-950 text-xs font-semibold"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>Save lowercase</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                            {msg.artistNote && (
                              <div className="mt-2 pt-2 border-t border-sky-900/40 text-xs text-sky-300/90">
                                Note: {msg.artistNote}
                              </div>
                            )}
                            {msg.attachmentName && (
                              <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                                <Paperclip className="w-3.5 h-3.5 text-sky-400" />
                                <span>{msg.attachmentName}</span>
                              </div>
                            )}
                            {msg.attachmentPreviewUrl && (
                              <img
                                src={msg.attachmentPreviewUrl}
                                alt={msg.attachmentName || 'Attachment'}
                                className="mt-2 max-h-40 rounded-lg border border-zinc-800 object-cover"
                              />
                            )}
                          </>
                        )}
                      </div>

                      {!isArtist && !isEditing && (
                        <div className="mt-1.5 flex items-center gap-3 text-xs text-zinc-400">
                          <button
                            type="button"
                            onClick={() => handleCopy(msg.id, msg.content)}
                            className="inline-flex items-center gap-1 hover:text-sky-300 transition-colors"
                          >
                            {copiedId === msg.id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy reply</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMsgId(msg.id);
                              setEditMsgDraft(msg.content);
                            }}
                            className="inline-flex items-center gap-1 hover:text-sky-300 transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            disabled={isRegen}
                            onClick={() => handleRegenerate(msg.id)}
                            className="inline-flex items-center gap-1 hover:text-sky-300 transition-colors disabled:opacity-50"
                          >
                            {isRegen ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3.5 h-3.5" />
                            )}
                            <span>Regenerate</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Bottom Composer */}
            <form
              onSubmit={handleSend}
              className="border-t border-sky-900/35 bg-[#0d141e] px-4 md:px-8 py-3.5"
            >
              <div className="max-w-3xl mx-auto space-y-2.5">
                {sendError && (
                  <div className="px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 flex items-center justify-between gap-2">
                    <span>{sendError}</span>
                    <button
                      type="button"
                      onClick={() => handleSend()}
                      className="underline font-medium shrink-0"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {showBriefOptions && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 p-3 rounded-lg bg-[#090e15] border border-sky-900/40">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Optional context / brief note
                      </label>
                      <input
                        type="text"
                        value={artistNote}
                        onChange={(e) => setArtistNote(e.target.value)}
                        placeholder="e.g. artist dropped a 3-track ep last month, budget conscious"
                        className="w-full px-2.5 py-1.5 rounded bg-[#0e1622] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Optional reply guidance
                      </label>
                      <input
                        type="text"
                        value={customGuidance}
                        onChange={(e) => setCustomGuidance(e.target.value)}
                        placeholder="e.g. mention bundle custom quote gently"
                        className="w-full px-2.5 py-1.5 rounded bg-[#0e1622] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>
                )}

                {attachmentName && (
                  <div className="flex items-center justify-between px-3 py-1.5 rounded-md bg-[#111b29] border border-sky-800/40 text-xs text-sky-200">
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <Paperclip className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">{attachmentName}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentName('');
                        setAttachmentPreviewUrl('');
                      }}
                      className="text-zinc-400 hover:text-zinc-200 ml-2"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept="image/*,.txt,.pdf,.doc,.docx"
                    onChange={handleAttachmentPick}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => attachmentInputRef.current?.click()}
                    title="Attach screenshot or brief"
                    className="p-2.5 rounded-lg border border-sky-900/40 bg-[#090e15] text-zinc-400 hover:text-sky-300 transition-colors shrink-0"
                  >
                    <ImagePlus className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBriefOptions((v) => !v)}
                    className={`px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      showBriefOptions || artistNote || customGuidance
                        ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                        : 'border-sky-900/40 bg-[#090e15] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Brief
                  </button>
                  <textarea
                    value={artistInput}
                    onChange={(e) => setArtistInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    rows={2}
                    placeholder="Paste the artist's message or question here… (Enter to generate reply, Shift+Enter for newline)"
                    className="flex-1 min-w-0 px-3.5 py-2 rounded-lg bg-[#090e15] border border-sky-900/50 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-sky-500 resize-none"
                  />
                  <button
                    type="submit"
                    disabled={sending || !artistInput.trim()}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-sky-500 text-slate-950 hover:bg-sky-400 disabled:opacity-45 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    {sending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    <span>{sending ? 'Drafting…' : 'Draft Reply'}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VIEW 2: KNOWLEDGE BASE & PRICING CATALOG */}
      {salesSubView === 'knowledge-base' && knowledgeBase && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">
                74 STUDIO Service Catalog &amp; Grounding Rules
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Authoritative pricing and deliverable tiers referenced by every artist reply. All rates are starting prices unless fixed.
              </p>
            </div>
            <button
              type="button"
              disabled={savingKb}
              onClick={handleSaveKb}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              {savingKb ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span>Save Knowledge Base</span>
            </button>
          </div>

          {/* Search catalog */}
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={kbSearch}
              onChange={(e) => setKbSearch(e.target.value)}
              placeholder="Search services, pricing tiers, or deliverables…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#0d141e] border border-sky-900/40 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
            />
          </div>

          {/* Service Offers Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredServices.map((svc) => (
              <div
                key={svc.id}
                className="rounded-xl border border-sky-900/40 bg-[#0d141e] p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">{svc.name}</h3>
                    <p className="text-xs text-zinc-400 mt-1">{svc.summary}</p>
                  </div>
                </div>
                {svc.tiers && svc.tiers.length > 0 && (
                  <div className="divide-y divide-sky-900/30 border-t border-b border-sky-900/30">
                    {svc.tiers.map((tier) => (
                      <div
                        key={tier.id}
                        className="py-2 flex items-center justify-between gap-4 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="text-zinc-200 font-medium">{tier.tierName}</span>
                          {tier.durationOrScope && (
                            <span className="text-zinc-500 ml-2">· {tier.durationOrScope}</span>
                          )}
                        </div>
                        <span className="font-mono tabular-nums text-sky-300 font-semibold shrink-0">
                          {tier.priceLabel}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[11px] text-zinc-400 space-y-1">
                  <div>
                    <span className="text-zinc-500">Deliverables:</span> {svc.deliverables.join(' · ')}
                  </div>
                  <div>
                    <span className="text-zinc-500">Differentiator:</span> {svc.differentiator}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Core Grounding Policy Fields */}
          <div className="rounded-xl border border-sky-900/40 bg-[#0d141e] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-sky-400" />
              <span>Editable Messaging &amp; Pricing Policies</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Contact Link</label>
                <input
                  type="text"
                  value={knowledgeBase.contactPageUrl}
                  onChange={(e) =>
                    setKnowledgeBase({ ...knowledgeBase, contactPageUrl: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Pricing Policy</label>
                <input
                  type="text"
                  value={knowledgeBase.pricingPolicy}
                  onChange={(e) =>
                    setKnowledgeBase({ ...knowledgeBase, pricingPolicy: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1.5">Brand Voice &amp; Reply Notes</label>
                <textarea
                  rows={2}
                  value={knowledgeBase.brandVoice}
                  onChange={(e) =>
                    setKnowledgeBase({ ...knowledgeBase, brandVoice: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1.5">Approved Messaging Notes</label>
                <textarea
                  rows={2}
                  value={knowledgeBase.approvedMessagingNotes}
                  onChange={(e) =>
                    setKnowledgeBase({ ...knowledgeBase, approvedMessagingNotes: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
          </div>

          {/* Custom KB Entries CRUD */}
          <div className="rounded-xl border border-sky-900/40 bg-[#0d141e] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-100">
              Custom Studio FAQs &amp; Objection Notes
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
              <input
                type="text"
                value={newEntryTitle}
                onChange={(e) => setNewEntryTitle(e.target.value)}
                placeholder="Note title…"
                className="px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
              />
              <select
                value={newEntryCat}
                onChange={(e) => setNewEntryCat(e.target.value as SalesKbCustomEntry['category'])}
                className="px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
              >
                <option value="faq">FAQ</option>
                <option value="pricing">Pricing</option>
                <option value="service">Service</option>
                <option value="objection">Objection</option>
                <option value="policy">Policy</option>
              </select>
              <input
                type="text"
                value={newEntryContent}
                onChange={(e) => setNewEntryContent(e.target.value)}
                placeholder="Approved factual detail…"
                className="px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={handleAddKbEntry}
                disabled={!newEntryTitle.trim() || !newEntryContent.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 hover:bg-sky-500/30 text-xs font-medium disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add KB Entry</span>
              </button>
            </div>

            {(knowledgeBase.customEntries || []).length > 0 && (
              <div className="divide-y divide-sky-900/30 border-t border-sky-900/30">
                {(knowledgeBase.customEntries || []).map((entry) => (
                  <div key={entry.id} className="py-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-100">
                        {entry.title}{' '}
                        <span className="text-zinc-500 font-normal">· {entry.category}</span>
                      </div>
                      <div className="text-xs text-zinc-400 mt-0.5">{entry.content}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteKbEntry(entry.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400 shrink-0"
                      aria-label="Delete custom entry"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: SETTINGS, PROMO RULE & SUPABASE MIGRATION */}
      {salesSubView === 'settings' && settings && (
        <div className="max-w-3xl space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Settings className="w-4 h-4 text-sky-400" />
                <span>74 STUDIO Promo &amp; Reply Settings</span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Configure active store-wide discount rules, reply formatting, and persistence sync.
              </p>
            </div>
            <button
              type="button"
              disabled={savingSettings}
              onClick={handleSaveSettings}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500 text-slate-950 hover:bg-sky-400 text-xs font-semibold"
            >
              {savingSettings ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>Save Settings</span>
            </button>
          </div>

          <div className="rounded-xl border border-sky-900/40 bg-[#0d141e] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-zinc-100">
                  Active Store-Wide Promotional Offer
                </div>
                <div className="text-xs text-zinc-400 mt-0.5">
                  Applies to all services including custom quotes · No coupon code required · No fake urgency
                </div>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-zinc-200">
                <input
                  type="checkbox"
                  checked={settings.promoEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, promoEnabled: e.target.checked })
                  }
                  className="rounded border-zinc-700 bg-zinc-900 text-sky-500 focus:ring-sky-500"
                />
                <span>{settings.promoEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Discount Percentage (%)</label>
                <input
                  type="number"
                  min={0}
                  max={80}
                  value={settings.promoPercentage}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      promoPercentage: Math.max(0, Math.min(80, Number(e.target.value) || 0)),
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100 font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Promo Label</label>
                <input
                  type="text"
                  value={settings.promoLabel}
                  onChange={(e) => setSettings({ ...settings, promoLabel: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1">Promo Scope Rule</label>
                <input
                  type="text"
                  value={settings.promoScope}
                  onChange={(e) => setSettings({ ...settings, promoScope: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1">Default Length &amp; Cadence</label>
                <input
                  type="text"
                  value={settings.defaultLengthGuidance}
                  onChange={(e) =>
                    setSettings({ ...settings, defaultLengthGuidance: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-zinc-400 mb-1">Additional Tone Notes</label>
                <textarea
                  rows={2}
                  value={settings.extraToneNotes}
                  onChange={(e) =>
                    setSettings({ ...settings, extraToneNotes: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#090e15] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-sky-900/30 flex items-center justify-between text-xs">
              <span className="text-zinc-300">
                Strict lowercase formatting on all AI replies sent to artists
              </span>
              <span className="font-mono text-sky-400">Always enforced</span>
            </div>
          </div>

          {/* Supabase Persistence & Legacy Migration Card */}
          <div className="rounded-xl border border-sky-900/40 bg-[#0d141e] p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-sky-400" />
                <h3 className="text-sm font-semibold text-zinc-100">
                  Supabase Authoritative Persistence &amp; Legacy Archive
                </h3>
              </div>
              <button
                type="button"
                onClick={loadPersistenceDiagnostics}
                className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Refresh</span>
              </button>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Legacy CRM leads, outputs, and activities remain permanently archived on disk and map into{' '}
              <code className="text-zinc-300">sales_legacy_*</code> Supabase tables without deletion.
            </p>
            {persistenceDiag && (
              <div className="text-xs space-y-1.5 text-zinc-300 bg-[#090e15] border border-zinc-800 rounded-lg p-3">
                <div>
                  Supabase Admin Connection:{' '}
                  <strong
                    className={
                      (persistenceDiag?.supabase?.configured ?? persistenceDiag?.supabaseConfigured)
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }
                  >
                    {(persistenceDiag?.supabase?.configured ?? persistenceDiag?.supabaseConfigured)
                      ? 'Configured'
                      : 'Pending Secrets (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)'}
                  </strong>
                </div>
                {Array.isArray(persistenceDiag?.localFiles) && persistenceDiag.localFiles.length > 0 && (
                  <div className="text-[11px] text-zinc-400 font-mono tabular-nums">
                    Local snapshots:{' '}
                    {persistenceDiag.localFiles
                      .map((f) => `${f.file}: ${f.exists ? `${f.recordCountHint} items` : 'none'}`)
                      .join(' · ')}
                  </div>
                )}
                {Array.isArray(persistenceDiag?.reachableTables) && (
                  <div className="text-[11px] text-zinc-400 font-mono">
                    Tables reachable: {persistenceDiag.reachableTables.length}
                    {persistenceDiag?.missingTables && persistenceDiag.missingTables.length > 0
                      ? ` (${persistenceDiag.missingTables.length} pending SQL schema)`
                      : ' (all verified)'}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={runningMigration}
                onClick={() => handleRunMigration(true)}
                className="px-3 py-1.5 rounded-md border border-sky-900/50 text-xs text-zinc-200 hover:border-sky-500/50"
              >
                Preview Dry-Run Migration
              </button>
              <button
                type="button"
                disabled={
                  runningMigration ||
                  !(persistenceDiag?.supabase?.configured ?? persistenceDiag?.supabaseConfigured)
                }
                onClick={() => handleRunMigration(false)}
                className="px-3 py-1.5 rounded-md bg-sky-500 text-slate-950 text-xs font-semibold disabled:opacity-40"
              >
                {runningMigration ? 'Migrating…' : 'Sync Legacy Data to Supabase'}
              </button>
            </div>
            {migrationMessage && (
              <div className="text-xs text-sky-300 font-mono break-all">{migrationMessage}</div>
            )}
          </div>
        </div>
      )}

      {/* Delete Conversation Confirmation Modal */}
      {confirmDeleteConv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#0f1621] p-5 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-zinc-100">Delete conversation?</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              This removes “{confirmDeleteConv.title}” from your active chat list. Archived legacy CRM data is untouched.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteConv(null)}
                className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-500"
              >
                Delete Chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
