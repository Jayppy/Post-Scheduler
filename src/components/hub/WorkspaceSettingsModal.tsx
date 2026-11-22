import React, { useState } from 'react';
import { Plus, Upload, X } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { fileToDataUrl } from '../../services/idb';
import { Workspace } from '../../types/studio';

interface WorkspaceSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({ open, onClose }) => {
  const { activeWorkspace, updateWorkspace, createWorkspace, setActiveWorkspaceId, themes, notify } =
    useStudio();

  const [mode, setMode] = useState<'edit' | 'create'>('edit');
  const [form, setForm] = useState<Workspace>(() => ({ ...activeWorkspace }));
  const [newName, setNewName] = useState('');
  const [newTagline, setNewTagline] = useState('');
  const [newVoice, setNewVoice] = useState('');

  if (!open) return null;

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      setForm((prev) => ({ ...prev, logoDataUrl: dataUrl }));
      notify('success', 'Brand logo updated', 'Ready to save workspace identity.');
    } catch {
      notify('error', 'Failed to read logo file.');
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    updateWorkspace(form);
    notify('success', 'Workspace identity saved', `${form.name} brand settings updated.`);
    onClose();
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const created = createWorkspace({
      name: newName.trim(),
      tagline: newTagline.trim() || 'Music & Creative Workspace',
      aestheticStyle: 'Dark luxury editorial',
      brandVoice: newVoice.trim() || 'Clear, creative, authoritative brand voice.',
      watermarkText: newName.trim().toUpperCase(),
      watermarkEnabled: true,
      defaultThemeId: themes[0]?.id || 'theme-dark-luxury',
      defaultOutroText: `Follow ${newName.trim()} for upcoming releases.`,
      palette: {
        background: '#09090b',
        surface: '#141418',
        accent: '#e4e4e7',
        text: '#fafafa',
      },
      typography: {
        displayFont: 'Plus Jakarta Sans',
        bodyFont: 'Manrope',
      },
    });
    setActiveWorkspaceId(created.id);
    notify('success', 'Workspace created', `${created.name} is now active.`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-[#111114] border border-zinc-800 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Brand Identity & Workspace Manager</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Each workspace keeps logos, themes, media, projects, and exports strictly isolated.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 pt-4 flex items-center gap-2 border-b border-zinc-800/80 pb-3">
          <button
            type="button"
            onClick={() => {
              setForm({ ...activeWorkspace });
              setMode('edit');
            }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              mode === 'edit' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Configure {activeWorkspace.name}
          </button>
          <button
            type="button"
            onClick={() => setMode('create')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium ${
              mode === 'create' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Brand Workspace</span>
          </button>
        </div>

        {mode === 'edit' ? (
          <form onSubmit={handleSaveEdit} className="p-6 overflow-y-auto space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Workspace Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Tagline</label>
                <input
                  type="text"
                  value={form.tagline}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Brand Voice Profile</label>
              <textarea
                rows={3}
                value={form.brandVoice}
                onChange={(e) => setForm({ ...form, brandVoice: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Default Design Theme</label>
                <select
                  value={form.defaultThemeId}
                  onChange={(e) => setForm({ ...form, defaultThemeId: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                >
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Watermark Text</label>
                <input
                  type="text"
                  value={form.watermarkText}
                  onChange={(e) => setForm({ ...form, watermarkText: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Default Outro Text</label>
              <input
                type="text"
                value={form.defaultOutroText}
                onChange={(e) => setForm({ ...form, defaultOutroText: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Background</label>
                <input
                  type="color"
                  value={form.palette.background}
                  onChange={(e) =>
                    setForm({ ...form, palette: { ...form.palette, background: e.target.value } })
                  }
                  className="w-full h-9 rounded bg-[#09090b] border border-zinc-800 p-1 cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Surface</label>
                <input
                  type="color"
                  value={form.palette.surface}
                  onChange={(e) =>
                    setForm({ ...form, palette: { ...form.palette, surface: e.target.value } })
                  }
                  className="w-full h-9 rounded bg-[#09090b] border border-zinc-800 p-1 cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Accent</label>
                <input
                  type="color"
                  value={form.palette.accent}
                  onChange={(e) =>
                    setForm({ ...form, palette: { ...form.palette, accent: e.target.value } })
                  }
                  className="w-full h-9 rounded bg-[#09090b] border border-zinc-800 p-1 cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Text</label>
                <input
                  type="color"
                  value={form.palette.text}
                  onChange={(e) =>
                    setForm({ ...form, palette: { ...form.palette, text: e.target.value } })
                  }
                  className="w-full h-9 rounded bg-[#09090b] border border-zinc-800 p-1 cursor-pointer"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Brand Logo (PNG/SVG)</label>
              <div className="flex items-center gap-4">
                {form.logoDataUrl ? (
                  <img
                    src={form.logoDataUrl}
                    alt={`${form.name} logo`}
                    className="h-10 w-auto object-contain bg-zinc-900 border border-zinc-800 rounded px-2 py-1"
                  />
                ) : (
                  <div className="h-10 px-3 flex items-center text-[11px] text-zinc-500 border border-dashed border-zinc-800 rounded">
                    Using wordmark ({form.watermarkText})
                  </div>
                )}
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-200 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload Logo</span>
                  <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                </label>
                {form.logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, logoDataUrl: undefined })}
                    className="text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-zinc-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-800/60"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
              >
                Save Workspace Identity
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleCreate} className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">New Brand Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Meridian Records"
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Workspace Tagline</label>
              <input
                type="text"
                value={newTagline}
                onChange={(e) => setNewTagline(e.target.value)}
                placeholder="e.g., Electronic Label & Tour Visuals"
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Brand Voice</label>
              <textarea
                rows={3}
                value={newVoice}
                onChange={(e) => setNewVoice(e.target.value)}
                placeholder="Describe tone, audience, and editorial approach..."
                className="w-full px-3 py-2 rounded-md bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div className="pt-4 border-t border-zinc-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-800/60"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
              >
                Create Isolated Workspace
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
