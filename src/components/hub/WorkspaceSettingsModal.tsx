import React, { useEffect, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { fileToDataUrl } from '../../services/idb';
import { Workspace } from '../../types/studio';

interface WorkspaceSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({ open, onClose }) => {
  const { activeWorkspace, updateWorkspace, themes, notify } = useStudio();
  const [form, setForm] = useState<Workspace>(() => ({ ...activeWorkspace }));

  useEffect(() => {
    if (open) {
      setForm({ ...activeWorkspace });
    }
  }, [open, activeWorkspace]);

  if (!open) return null;

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      setForm((prev) => ({ ...prev, logoDataUrl: dataUrl }));
      notify('success', 'Brand logo updated', 'Ready to save Behind the Release identity.');
    } catch {
      notify('error', 'Failed to read logo file.');
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    updateWorkspace(form);
    notify('success', 'Brand identity saved', `${form.name} settings updated.`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-[#111114] border border-zinc-800 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              {activeWorkspace.name} · Brand Identity Settings
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Configure the visual identity, voice, and defaults for Behind the Release.
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
              Save Identity Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
