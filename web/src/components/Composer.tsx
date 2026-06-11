import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { uploadFiles, type UploadedFile } from '@/api/client';
import { useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { cn } from '@/lib/utils';
import { ModelPicker } from './ModelPicker';
import { Tooltip } from './ui/misc';

function TogglePill({
  active,
  onClick,
  icon,
  label,
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip label={tooltip} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors [&_svg]:size-3.5',
          active
            ? 'border-primary/40 bg-primary/12 text-primary'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {icon}
        {label}
      </button>
    </Tooltip>
  );
}

export function Composer() {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const prefs = usePrefs();
  const queryClient = useQueryClient();

  const autoresize = () => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const attach = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(list);
      setPending((p) => [...p, ...uploaded]);
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || streaming) return;
    const attachments = pending.map((f) => f.id);
    setText('');
    setPending([]);
    requestAnimationFrame(autoresize);
    await send(value, {
      attachments,
      onSessionCreated: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  const canSend = (text.trim().length > 0 || pending.length > 0) && !uploading;

  return (
    <div className="mx-auto w-full max-w-[800px] px-4 pb-4">
      <div className="rounded-3xl border bg-card shadow-[0_2px_16px_rgb(0_0_0/0.08)] dark:shadow-[0_2px_16px_rgb(0_0_0/0.3)]">
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3">
            {pending.map((f) => (
              <span
                key={f.id}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-muted px-2 py-1 text-xs"
              >
                <FileTextIcon className="size-3.5 text-muted-foreground" />
                <span className="max-w-40 truncate">{String(f.name ?? f.id)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${String(f.name ?? f.id)}`}
                  onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-start px-4 pt-3.5">
          <textarea
            ref={textarea}
            value={text}
            rows={1}
            autoFocus
            placeholder="Message Talos…"
            aria-label="Message input"
            onChange={(e) => { setText(e.target.value); autoresize(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) { e.preventDefault(); void attach(files); }
            }}
            className="max-h-[200px] min-h-[26px] w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <ModelPicker />
        </div>

        <div className="flex items-center gap-1 px-2.5 pt-1.5 pb-2.5">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
          />
          <Tooltip label="Attach files" side="top">
            <button
              type="button"
              aria-label="Attach files"
              onClick={() => fileInput.current?.click()}
              className={cn(
                'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                uploading && 'animate-pulse',
              )}
            >
              <PaperclipIcon className="size-4" />
            </button>
          </Tooltip>

          <TogglePill active={prefs.planMode} onClick={() => prefs.toggle('planMode')} icon={<ListTodoIcon />} label="Plan" tooltip="Plan before acting" />
          <TogglePill active={prefs.useWeb} onClick={() => prefs.toggle('useWeb')} icon={<GlobeIcon />} label="Web" tooltip="Search the web" />
          <TogglePill active={prefs.useRag} onClick={() => prefs.toggle('useRag')} icon={<FileTextIcon />} label="Docs" tooltip="Use document RAG" />
          <TogglePill active={prefs.useDb} onClick={() => prefs.toggle('useDb')} icon={<DatabaseIcon />} label="DB" tooltip="Query connected databases" />

          <div className="flex-1" />

          {streaming ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop generating"
              className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send message"
              className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs transition-all hover:bg-primary/90 disabled:opacity-30"
            >
              <ArrowUpIcon className="size-4.5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
