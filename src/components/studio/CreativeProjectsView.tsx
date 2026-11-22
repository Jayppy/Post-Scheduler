import React, { useState } from 'react';
import {
  Clapperboard,
  Copy,
  Edit3,
  Layers,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useStudio } from '../../context/StudioContext';

export const CreativeProjectsView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceProjects,
    workspaceThemes,
    openProjectInEditor,
    duplicateProject,
    renameProject,
    deleteProject,
    setStudioSubView,
    setActiveProjectId,
    notify,
  } = useStudio();

  const [filter, setFilter] = useState<'all' | 'carousel' | 'reel'>('all');
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filtered = workspaceProjects.filter((p) => {
    if (filter !== 'all' && p.type !== filter) return false;
    if (search.trim() && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleCommitRename = (id: string) => {
    if (renameText.trim()) {
      renameProject(id, renameText.trim());
      notify('success', 'Project renamed');
    }
    setRenamingId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Creative Projects</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Saved Creative Projects</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              setStudioSubView('carousel-creator');
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Carousel</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              setStudioSubView('reels-studio');
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200"
          >
            <Clapperboard className="w-3.5 h-3.5" />
            <span>New Reel</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-lg bg-[#111114] border border-zinc-800">
          {(['all', 'carousel', 'reel'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded text-xs font-medium capitalize ${
                filter === tab ? 'bg-zinc-100 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab === 'all' ? 'All Projects' : `${tab}s`}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full pl-8 pr-3 py-2 rounded-md bg-[#111114] border border-zinc-800 text-xs text-zinc-100"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-12 rounded-xl bg-[#111114] border border-zinc-800 text-center space-y-3">
          <p className="text-sm text-zinc-300">No projects match your current filter in {activeWorkspace.name}.</p>
          <p className="text-xs text-zinc-500">
            Projects created in the Carousel Creator or Reels & Shorts Studio are automatically stored here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden divide-y divide-zinc-800/80">
          {filtered.map((proj) => {
            const themeName = workspaceThemes.find((t) => t.id === proj.themeId)?.name || 'Custom';
            return (
              <div
                key={proj.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-900/40 transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-[#09090b] border border-zinc-800 text-zinc-300 shrink-0">
                    {proj.type === 'carousel' ? (
                      <Layers className="w-4 h-4" />
                    ) : (
                      <Clapperboard className="w-4 h-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    {renamingId === proj.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleCommitRename(proj.id)}
                          className="px-2 py-1 rounded bg-[#09090b] border border-zinc-600 text-xs text-zinc-100"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => handleCommitRename(proj.id)}
                          className="px-2 py-1 rounded bg-zinc-100 text-zinc-950 text-[11px] font-semibold"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="text-sm font-semibold text-zinc-100 truncate">{proj.title}</div>
                    )}

                    <div className="text-xs text-zinc-400 mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="capitalize">{proj.type}</span>
                      <span aria-hidden="true">·</span>
                      <span>{themeName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{proj.status.replace('-', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Updated {new Date(proj.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openProjectInEditor(proj)}
                    className="px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold"
                  >
                    Continue Editing
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      duplicateProject(proj.id);
                      notify('success', 'Project duplicated');
                    }}
                    className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100"
                    title="Duplicate project"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(proj.id);
                      setRenameText(proj.title);
                    }}
                    className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100"
                    title="Rename project"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  {confirmDeleteId === proj.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          deleteProject(proj.id);
                          setConfirmDeleteId(null);
                          notify('info', 'Project deleted');
                        }}
                        className="px-2.5 py-1.5 rounded bg-red-600 text-white text-[11px] font-semibold"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1.5 rounded border border-zinc-700 text-[11px] text-zinc-300"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(proj.id)}
                      className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-red-400"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
