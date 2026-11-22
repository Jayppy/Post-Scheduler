import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PenSquare, Plus, Trash2 } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';

export const ContentCalendarView: React.FC = () => {
  const { activeWorkspace, workspacePosts, savePost, deletePost, setNavSection } = useStudio();

  const [cursorDate, setCursorDate] = useState(() => new Date(2026, 10, 1)); // Nov 2026
  const year = cursorDate.getFullYear();
  const month = cursorDate.getMonth();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();

  const monthLabel = cursorDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const postsByDay = useMemo(() => {
    const map: Record<string, typeof workspacePosts> = {};
    for (const post of workspacePosts) {
      if (!post.scheduledDate) continue;
      if (!map[post.scheduledDate]) map[post.scheduledDate] = [];
      map[post.scheduledDate].push(post);
    }
    return map;
  }, [workspacePosts]);

  const calendarCells = useMemo(() => {
    const cells: Array<{ day: number | null; dateStr?: string }> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateStr });
    }
    return cells;
  }, [year, month, daysInMonth, firstWeekday]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="text-xs text-zinc-400 mb-1">
            <span>{activeWorkspace.name}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span>Content Calendar</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Release & Social Schedule</h1>
        </div>

        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-1 rounded-md bg-[#111114] border border-zinc-800 p-1">
            <button
              type="button"
              onClick={() => setCursorDate(new Date(year, month - 1, 1))}
              className="p-1.5 text-zinc-400 hover:text-zinc-100"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-semibold text-zinc-100 min-w-[130px] text-center">
              {monthLabel}
            </span>
            <button
              type="button"
              onClick={() => setCursorDate(new Date(year, month + 1, 1))}
              className="p-1.5 text-zinc-400 hover:text-zinc-100"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setNavSection('post-composer')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Schedule Post</span>
          </button>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-zinc-800 text-[11px] font-medium text-zinc-400">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="py-2.5 px-3 border-r last:border-r-0 border-zinc-800/70">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {calendarCells.map((cell, idx) => {
            const items = cell.dateStr ? postsByDay[cell.dateStr] || [] : [];
            return (
              <div
                key={idx}
                className="min-h-[110px] p-2 border-r border-b border-zinc-800/70 bg-[#0d0d10] flex flex-col gap-1.5"
              >
                {cell.day !== null && (
                  <>
                    <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                      {String(cell.day).padStart(2, '0')}
                    </div>
                    {items.map((post) => (
                      <div
                        key={post.id}
                        className="p-1.5 rounded bg-[#18181e] border border-zinc-700/80 text-[11px] space-y-0.5"
                      >
                        <div className="font-semibold text-zinc-100 truncate">{post.title}</div>
                        <div className="text-[10px] font-mono text-zinc-400">
                          {post.scheduledTime || '18:00'} · {post.platform}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scheduled List Management */}
      <div className="rounded-xl bg-[#111114] border border-zinc-800 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
          All Scheduled Entries ({workspacePosts.filter((p) => p.scheduledDate).length})
        </div>
        <div className="divide-y divide-zinc-800/70">
          {workspacePosts
            .filter((p) => p.scheduledDate)
            .map((post) => (
              <div key={post.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-zinc-100 truncate">{post.title}</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    <span>{post.platform}</span>
                    <span className="mx-1.5">·</span>
                    <span className="font-mono tabular-nums">
                      {post.scheduledDate} {post.scheduledTime || ''}
                    </span>
                    <span className="mx-1.5">·</span>
                    <span>{post.mediaAssetIds.length} attached asset(s)</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={post.scheduledDate || ''}
                    onChange={(e) => savePost({ ...post, scheduledDate: e.target.value })}
                    className="px-2 py-1 rounded bg-[#09090b] border border-zinc-800 text-[11px] text-zinc-200"
                  />
                  <button
                    type="button"
                    onClick={() => setNavSection('post-composer')}
                    className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-100"
                    title="Compose new"
                  >
                    <PenSquare className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePost(post.id)}
                    className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};
