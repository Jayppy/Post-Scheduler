import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { createId } from '../../services/storage';
import { Campaign } from '../../types/studio';

export const CampaignManagerView: React.FC = () => {
  const {
    activeWorkspace,
    workspaceCampaigns,
    workspaceProjects,
    saveCampaign,
    deleteCampaign,
    openProjectInEditor,
    notify,
  } = useStudio();

  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [startDate, setStartDate] = useState('2026-11-24');
  const [endDate, setEndDate] = useState('2026-12-24');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const camp: Campaign = {
      id: createId('camp'),
      workspaceId: activeWorkspace.id,
      name: name.trim(),
      objective: objective.trim() || 'Strategic social campaign rollout.',
      startDate,
      endDate,
      status: 'active',
      linkedProjectIds: [],
    };
    saveCampaign(camp);
    setName('');
    setObjective('');
    notify('success', 'Campaign created', camp.name);
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800/80 pb-5">
        <div className="text-xs text-zinc-400 mb-1">
          <span>{activeWorkspace.name}</span>
          <span className="mx-2 text-zinc-600">·</span>
          <span>Campaign Manager</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Release & Brand Campaigns</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleCreate}
          className="lg:col-span-4 p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-4"
        >
          <h2 className="text-sm font-semibold text-zinc-100">New Campaign</h2>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Campaign Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Debut EP Rollout"
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Objective</label>
            <textarea
              rows={3}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Key deliverables and campaign focus..."
              className="w-full px-3 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-2.5 py-2 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-100"
              />
            </div>
          </div>
          <button
            type="submit"
            className="w-full py-2.5 rounded-md bg-zinc-100 text-zinc-950 hover:bg-white text-xs font-semibold inline-flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Campaign</span>
          </button>
        </form>

        <div className="lg:col-span-8 space-y-4">
          {workspaceCampaigns.map((camp) => (
            <div key={camp.id} className="p-5 rounded-xl bg-[#111114] border border-zinc-800 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">{camp.name}</div>
                  <p className="text-xs text-zinc-400 mt-1">{camp.objective}</p>
                  <div className="text-[11px] font-mono tabular-nums text-zinc-500 mt-2">
                    {camp.startDate} → {camp.endDate} · {camp.status}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={camp.status}
                    onChange={(e) =>
                      saveCampaign({ ...camp, status: e.target.value as Campaign['status'] })
                    }
                    className="px-2.5 py-1 rounded bg-[#09090b] border border-zinc-800 text-xs text-zinc-200"
                  >
                    <option value="active">Active</option>
                    <option value="planning">Planning</option>
                    <option value="completed">Completed</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => deleteCampaign(camp.id)}
                    className="p-1.5 text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {workspaceProjects.length > 0 && (
                <div className="pt-3 border-t border-zinc-800/80">
                  <div className="text-[11px] text-zinc-400 mb-2">Link Creative Studio Projects</div>
                  <div className="flex flex-wrap gap-2">
                    {workspaceProjects.map((proj) => {
                      const linked = camp.linkedProjectIds.includes(proj.id);
                      return (
                        <button
                          key={proj.id}
                          type="button"
                          onClick={() => {
                            const nextIds = linked
                              ? camp.linkedProjectIds.filter((id) => id !== proj.id)
                              : [...camp.linkedProjectIds, proj.id];
                            saveCampaign({ ...camp, linkedProjectIds: nextIds });
                          }}
                          onDoubleClick={() => openProjectInEditor(proj)}
                          className={`px-2.5 py-1 rounded border text-[11px] ${
                            linked
                              ? 'bg-zinc-100 text-zinc-950 border-zinc-100 font-semibold'
                              : 'bg-[#09090b] border-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {proj.title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
