import React, { useEffect, useState } from 'react';
import { Check, Plus, Trash2, Upload } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { renderSlideToCanvas } from '../../services/carouselRenderer';
import { fileToDataUrl } from '../../services/idb';
import { createId } from '../../services/storage';
import { CarouselSlide, DesignTheme } from '../../types/studio';

const SAMPLE_SLIDE: CarouselSlide = {
  id: 'preview-slide',
  role: 'cover',
  kicker: '01 · EDITORIAL BREAKDOWN',
  headline: 'Designing Visual Worlds for Independent Releases',
  body: 'Consistent typography, deliberate negative space, and clear framing turn a single track drop into a cohesive cultural campaign.',
  highlight: 'Save this framework for your next single rollout.',
  layoutVariant: 'editorial-split',
};

export const DesignThemesView: React.FC = () => {
  const {
    activeWorkspace,
    updateWorkspace,
    workspaceThemes,
    saveTheme,
    deleteTheme,
    notify,
  } = useStudio();

  const [selectedThemeId, setSelectedThemeId] = useState<string>(
    activeWorkspace.defaultThemeId || workspaceThemes[0]?.id
  );
  const activeTheme =
    workspaceThemes.find((t) => t.id === selectedThemeId) || workspaceThemes[0];

  const [draft, setDraft] = useState<DesignTheme>(() => JSON.parse(JSON.stringify(activeTheme)));
  const [previewDataUrl, setPreviewDataUrl] = useState('');

  useEffect(() => {
    if (activeTheme) {
      setDraft(JSON.parse(JSON.stringify(activeTheme)));
    }
  }, [activeTheme?.id]);

  useEffect(() => {
    let cancelled = false;
    renderSlideToCanvas(SAMPLE_SLIDE, 0, 5, draft, activeWorkspace, '1080x1350')
      .then((c) => {
        if (!cancelled) setPreviewDataUrl(c.toDataURL('image/png'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft, activeWorkspace]);

  const handleUploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setDraft((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        backgroundImageUrl: dataUrl,
        imagePlacement: prev.layout.imagePlacement === 'none' ? 'background-scrim' : prev.layout.imagePlacement,
      },
    }));
  };

  const handleSaveAsNewWorkspaceTheme = () => {
    const customTheme: DesignTheme = {
      ...JSON.parse(JSON.stringify(draft)),
      id: createId('theme'),
      workspaceId: activeWorkspace.id,
      name: draft.isCustom ? draft.name : `${draft.name} (${activeWorkspace.name})`,
      isCustom: true,
    };
    saveTheme(customTheme);
    setSelectedThemeId(customTheme.id);
    notify('success', 'Custom theme saved', `${customTheme.name} added to ${activeWorkspace.name}.`);
  };

  const handleUpdateCustomTheme = () => {
    if (!draft.isCustom) {
      handleSaveAsNewWorkspaceTheme();
      return;
    }
    saveTheme(draft);
    notify('success', 'Theme updated', `${draft.name} saved.`);
  };

  const handleSetWorkspaceDefault = () => {
    updateWorkspace({ ...activeWorkspace, defaultThemeId: draft.id });
    notify('success', 'Default theme updated', `${draft.name} is now default for ${activeWorkspace.name}.`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Design Theme Library</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Music & Editorial Design Themes</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Customize colors, typography, logo placement, and save brand-specific theme collections.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleSetWorkspaceDefault}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:border-zinc-500"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Set Workspace Default</span>
          </button>
          <button
            type="button"
            onClick={handleSaveAsNewWorkspaceTheme}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Save as Brand Theme</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Theme Selector List */}
        <div className="xl:col-span-3 space-y-2">
          {workspaceThemes.map((t) => {
            const isSelected = t.id === activeTheme.id;
            const isDefault = activeWorkspace.defaultThemeId === t.id;
            return (
              <div
                key={t.id}
                onClick={() => setSelectedThemeId(t.id)}
                className={`p-3.5 rounded-lg border cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-[#18181d] border-zinc-300'
                    : 'bg-[#111114] border-zinc-800/80 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-100">{t.name}</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-3 h-3 rounded-full border border-zinc-700"
                      style={{ backgroundColor: t.colors.background }}
                    />
                    <span
                      className="w-3 h-3 rounded-full border border-zinc-700"
                      style={{ backgroundColor: t.colors.accent }}
                    />
                  </div>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1 flex items-center justify-between">
                  <span>
                    {t.category}
                    {t.isCustom ? ' · Custom' : ''}
                    {isDefault ? ' · Default' : ''}
                  </span>
                  {t.isCustom && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTheme(t.id);
                        setSelectedThemeId(workspaceThemes[0]?.id);
                      }}
                      className="text-zinc-500 hover:text-red-400"
                      title="Delete custom theme"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Live Rendered Preview */}
        <div className="xl:col-span-4 rounded-xl bg-[#111114] border border-zinc-800 p-4 flex flex-col items-center">
          <div className="w-full flex items-center justify-between text-xs text-zinc-400 mb-3">
            <span>Theme Canvas Preview</span>
            <span className="font-mono">1080×1350</span>
          </div>
          {previewDataUrl ? (
            <img
              src={previewDataUrl}
              alt={draft.name}
              className="w-full max-w-[360px] rounded-lg border border-zinc-800"
            />
          ) : (
            <div className="aspect-[4/5] w-full bg-[#09090b] rounded-lg" />
          )}
        </div>

        {/* Theme Customization Controls */}
        <div className="xl:col-span-5 rounded-xl bg-[#111114] border border-zinc-800 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">Customize Theme Tokens</h3>
            {draft.isCustom && (
              <button
                type="button"
                onClick={handleUpdateCustomTheme}
                className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-100"
              >
                Update Saved Theme
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Theme Name</label>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Category</label>
              <input
                type="text"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {(
              [
                ['background', 'BG'],
                ['surface', 'Surface'],
                ['accent', 'Accent'],
                ['primaryText', 'Heading'],
                ['mutedText', 'Body'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label className="block text-[11px] text-zinc-400 mb-1">{label}</label>
                <input
                  type="color"
                  value={draft.colors[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      colors: { ...draft.colors, [key]: e.target.value },
                    })
                  }
                  className="w-full h-9 rounded bg-[#09090b] border border-zinc-800 p-0.5 cursor-pointer"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Heading Font</label>
              <select
                value={draft.typography.headingFont}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    typography: {
                      ...draft.typography,
                      headingFont: e.target.value as DesignTheme['typography']['headingFont'],
                    },
                  })
                }
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                <option value="Cormorant Garamond">Cormorant Garamond</option>
                <option value="Oswald">Oswald</option>
                <option value="Manrope">Manrope</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Body Font</label>
              <select
                value={draft.typography.bodyFont}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    typography: {
                      ...draft.typography,
                      bodyFont: e.target.value as DesignTheme['typography']['bodyFont'],
                    },
                  })
                }
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="Manrope">Manrope</option>
                <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                <option value="Cormorant Garamond">Cormorant Garamond</option>
                <option value="JetBrains Mono">JetBrains Mono</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">
                Heading ({draft.typography.headingSize}px)
              </label>
              <input
                type="range"
                min={42}
                max={76}
                value={draft.typography.headingSize}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    typography: { ...draft.typography, headingSize: Number(e.target.value) },
                  })
                }
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">
                Body ({draft.typography.bodySize}px)
              </label>
              <input
                type="range"
                min={20}
                max={34}
                value={draft.typography.bodySize}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    typography: { ...draft.typography, bodySize: Number(e.target.value) },
                  })
                }
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Alignment</label>
              <select
                value={draft.typography.alignment}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    typography: {
                      ...draft.typography,
                      alignment: e.target.value as 'left' | 'center' | 'right',
                    },
                  })
                }
                className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Image Placement</label>
              <select
                value={draft.layout.imagePlacement}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    layout: {
                      ...draft.layout,
                      imagePlacement: e.target.value as DesignTheme['layout']['imagePlacement'],
                    },
                  })
                }
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="background-scrim">Full Background + Scrim</option>
                <option value="top-band">Top Editorial Band</option>
                <option value="bottom-band">Bottom Editorial Band</option>
                <option value="split-right">Split Right Panel</option>
                <option value="none">Typography Only</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Logo Placement</label>
              <select
                value={draft.layout.logoPlacement}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    layout: {
                      ...draft.layout,
                      logoPlacement: e.target.value as DesignTheme['layout']['logoPlacement'],
                    },
                  })
                }
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="top-left">Top Left</option>
                <option value="top-right">Top Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="bottom-right">Bottom Right</option>
                <option value="none">Hidden</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-center">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Decorative Element</label>
              <select
                value={draft.layout.decorativeStyle}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    layout: {
                      ...draft.layout,
                      decorativeStyle: e.target.value as DesignTheme['layout']['decorativeStyle'],
                    },
                  })
                }
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              >
                <option value="hairline-frame">Hairline Frame</option>
                <option value="editorial-rule">Editorial Rules</option>
                <option value="grid-ticks">Corner Grid Ticks</option>
                <option value="geometric-corner">Geometric Accents</option>
                <option value="minimal">Minimal Clean</option>
              </select>
            </div>

            <label className="flex items-center gap-2 text-xs text-zinc-300 mt-4 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.layout.showSlideNumbers}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    layout: { ...draft.layout, showSlideNumbers: e.target.checked },
                  })
                }
              />
              <span>Show Slide Numbers (01 / 05)</span>
            </label>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80">
            <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-200 cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Background Image</span>
              <input type="file" accept="image/*" onChange={handleUploadBg} className="hidden" />
            </label>
            {draft.layout.backgroundImageUrl && (
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    layout: { ...draft.layout, backgroundImageUrl: '' },
                  })
                }
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                Remove Background Image
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
