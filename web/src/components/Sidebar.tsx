import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MessageSquare, SquarePen } from 'lucide-react';
import { fetchSessions } from '@/api/client';
import { useChat } from '@/state/chat';

export function Sidebar() {
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions, refetchInterval: 30_000 });
  const activeId = useChat((s) => s.sessionId);
  const openSession = useChat((s) => s.openSession);
  const newChat = useChat((s) => s.newChat);

  const visible = (sessions ?? []).filter((s) => !s.archived);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-ink/8 bg-panel" aria-label="Sidebar">
      <div className="px-3 pt-4 pb-2">
        <span className="px-2 text-[17px] font-semibold text-accent">Talos</span>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={newChat}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] hover:bg-ink/7 transition-colors"
        >
          <SquarePen size={18} className="opacity-75" />
          New chat
        </button>
      </div>

      <div className="mt-3 px-4 pb-1 text-xs font-medium text-ink-muted">Chats</div>
      <div className="flex-1 overflow-y-auto px-2">
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => void openSession(s.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors ${
              s.id === activeId ? 'bg-ink/10' : 'hover:bg-ink/7'
            }`}
            title={s.name}
          >
            <MessageSquare size={16} className="shrink-0 opacity-60" />
            <span className="truncate">{s.name || 'Untitled'}</span>
          </button>
        ))}
        {visible.length === 0 && (
          <div className="px-2.5 py-2 text-[13px] text-ink-muted">No chats yet</div>
        )}
      </div>

      <div className="border-t border-ink/8 p-2">
        <a
          href="/legacy"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-muted hover:bg-ink/7 hover:text-ink transition-colors"
        >
          <ExternalLink size={15} className="opacity-75" />
          Legacy UI
        </a>
      </div>
    </nav>
  );
}
