import React, { useState } from 'react';
import { Check, Send, Trash2 } from 'lucide-react';
import { useStudio } from '../../context/StudioContext';
import { SocialPost } from '../../types/studio';

export const PublishingQueueView: React.FC = () => {
  const { activeWorkspace, workspacePosts, savePost, deletePost, openPostComposerWithDraft, notify } =
    useStudio();

  const [filter, setFilter] = useState<'all' | SocialPost['status']>('all');

  const filtered = workspacePosts.filter((p) => filter === 'all' || p.status === filter);

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800/80 pb-5">
        <div className="text-xs text-zinc-400 mb-1">
          <span>{activeWorkspace.name}</span>
          <span className="mx-2 text-zinc-600">·</span>
          <span>Publishing Queue</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Social Publishing Queue</h1>
      </div>

      <div className="inline-flex p-1 rounded-lg bg-[#111114] border border-zinc-800 gap-1">
        {(['all', 'queued', 'scheduled', 'draft', 'published'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setFilter(tab)}
            className={`px-3 py-1.5 rounded text-xs font-medium capitalize ${
              filter === tab ? 'bg-zinc-100 text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="p-10 rounded-xl bg-[#111114] border border-zinc-800 text-center text-xs text-zinc-400">
          No posts in this queue state for {activeWorkspace.name}.
        </div>
      ) : (
        <div className="rounded-xl bg-[#111114] border border-zinc-800 divide-y divide-zinc-800/80">
          {filtered.map((post) => (
            <div key={post.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-semibold text-zinc-100 truncate">{post.title}</div>
                <div className="text-xs text-zinc-400 truncate">{post.caption || 'No caption entered'}</div>
                <div className="text-[11px] font-mono text-zinc-500">
                  {post.platform} · {post.status} · {post.mediaAssetIds.length} media file(s)
                  {post.scheduledDate ? ` · ${post.scheduledDate} ${post.scheduledTime || ''}` : ''}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {post.status !== 'published' && (
                  <button
                    type="button"
                    onClick={() => {
                      savePost({ ...post, status: 'published' });
                      notify('success', 'Marked as published', post.title);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs font-semibold"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Publish</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    openPostComposerWithDraft({
                      title: post.title,
                      platform: post.platform,
                      caption: post.caption,
                      hashtags: post.hashtags,
                      mediaAssetIds: post.mediaAssetIds,
                      sourceProjectId: post.sourceProjectId,
                    })
                  }
                  className="p-2 rounded border border-zinc-800 text-zinc-300 hover:border-zinc-600"
                  title="Edit in Composer"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => deletePost(post.id)}
                  className="p-2 rounded border border-zinc-800 text-zinc-400 hover:text-red-400"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
