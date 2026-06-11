import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderIcon,
  GhostIcon,
  PencilIcon,
  Share2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { fetchSessions, renameSession } from '@/api/client';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';
import { Tooltip } from './ui/misc';

function messagesToMarkdown(messages: ReturnType<typeof useChat.getState>['messages']): string {
  return messages
    .map((m) => (m.role === 'user' ? `**You:**\n${m.content}` : `**Talos:**\n${m.content}`))
    .join('\n\n---\n\n');
}

export function ChatHeader({ onToggleFiles, filesOpen }: { onToggleFiles: () => void; filesOpen: boolean }) {
  const sessionId = useChat((s) => s.sessionId);
  const messages = useChat((s) => s.messages);
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
  const queryClient = useQueryClient();
  const incognito = usePrefs((s) => s.incognito);
  const toggle = usePrefs((s) => s.toggle);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const session = sessions?.find((s) => s.id === sessionId);
  const title = session?.name ?? '';

  const commitRename = async () => {
    setRenaming(false);
    const name = draft.trim();
    if (sessionId && name && name !== title) {
      await renameSession(sessionId, name);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  };

  const copyChat = async () => {
    await navigator.clipboard.writeText(messagesToMarkdown(messages));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadChat = () => {
    const blob = new Blob([messagesToMarkdown(messages)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title || 'chat'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="h-7 w-64 rounded-md border border-ring bg-transparent px-2 text-sm outline-none"
          />
        ) : (
          <>
            <span className="truncate text-sm font-medium">{title || 'New chat'}</span>
            {sessionId && (
              <Tooltip label="Rename chat">
                <button
                  type="button"
                  aria-label="Rename chat"
                  onClick={() => { setDraft(title); setRenaming(true); }}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-60 transition-all hover:bg-accent hover:opacity-100"
                >
                  <PencilIcon className="size-3.5" />
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {sessionId && (
        <Tooltip label={filesOpen ? 'Hide session files' : 'Session files & artifacts'}>
          <button
            type="button"
            aria-label="Session files"
            aria-pressed={filesOpen}
            onClick={onToggleFiles}
            className={cn(
              'flex size-8 items-center justify-center rounded-lg transition-colors',
              filesOpen ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <FolderIcon className="size-4" />
          </button>
        </Tooltip>
      )}

      {messages.length > 0 && (
        <Menu>
          <Tooltip label="Export chat">
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label="Export chat"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Share2Icon className="size-4" />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onSelect={() => { setDraft(title); setRenaming(true); }}>
              <PencilIcon /> Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => void copyChat()}>
              {copied ? <CheckIcon /> : <CopyIcon />} Copy as Markdown
            </MenuItem>
            <MenuItem onSelect={downloadChat}>
              <DownloadIcon /> Download .md
            </MenuItem>
            <MenuItem onSelect={onToggleFiles}>
              <FolderIcon /> Session files…
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => { window.location.href = '/legacy'; }}>
              <FileTextIcon /> Export PDF <span className="ml-auto text-xs text-muted-foreground">legacy</span>
            </MenuItem>
            <MenuItem onSelect={() => { window.location.href = '/legacy'; }}>
              <ExternalLinkIcon /> Export DOCX <span className="ml-auto text-xs text-muted-foreground">legacy</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}

      <Tooltip label={incognito ? 'Incognito on — chat not saved' : 'Incognito off'}>
        <button
          type="button"
          aria-label="Toggle incognito"
          aria-pressed={incognito}
          onClick={() => toggle('incognito')}
          className={cn(
            'flex size-8 items-center justify-center rounded-lg transition-colors',
            incognito
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <GhostIcon className="size-4" />
        </button>
      </Tooltip>
    </header>
  );
}
