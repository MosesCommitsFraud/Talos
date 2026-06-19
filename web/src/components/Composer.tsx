import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  DatabaseIcon,
  LightbulbIcon,
  FileTextIcon,
  LayersIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PencilRulerIcon,
  PlayIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities, uploadFiles, type UploadedFile } from '@/api/client';
import { selectPendingPlan, useChat } from '@/state/chat';
import { usePrefs, type ChatMode } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { ContextMeter } from './ContextMeter';
import { ModelPicker } from './ModelPicker';
import { Button } from './ui/button';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './ui/menu';
import { Tooltip } from './ui/misc';

/** Thin vertical divider between footer mode controls (t3code separator). */
function FooterSeparator() {
  return <div aria-hidden="true" className="mx-0.5 hidden h-4 w-px shrink-0 bg-border sm:block" />;
}

/** t3code plan-toggle style: labeled ghost button, blue tint when active.
 *  Pass inactiveIcon/inactiveLabel to swap the face by state (Plan ↔ Work). */
function ModeToggle({
  active,
  onClick,
  icon,
  label,
  tooltip,
  inactiveIcon,
  inactiveLabel,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip: string;
  inactiveIcon?: React.ReactNode;
  inactiveLabel?: string;
}) {
  const face = active ? icon : (inactiveIcon ?? icon);
  const text = active ? label : (inactiveLabel ?? label);
  return (
    <Tooltip label={tooltip} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={tooltip}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2 text-[13px] font-medium whitespace-nowrap transition-colors sm:h-7 sm:px-2.5 [&_svg]:size-4 [&_svg]:shrink-0',
          active
            ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300'
            : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground/80',
        )}
      >
        {face}
        <span className="sr-only sm:not-sr-only">{text}</span>
      </button>
    </Tooltip>
  );
}

type ModeOpt = { key: ChatMode; rag: boolean; db: boolean; Icon: React.ComponentType<{ className?: string }>; label: string; desc: string };

/** Knowledge-mode dropdown styled like t3code's runtime-mode picker (ghost
 *  trigger, rich items with a description line). Shown only when both RAG and
 *  SQL are configured; drives use_rag/use_db. */
function ChatModeDropdown() {
  const { t } = useTranslation();
  const useRag = usePrefs((s) => s.useRag);
  const useDb = usePrefs((s) => s.useDb);
  const setKnowledge = usePrefs((s) => s.setKnowledge);
  const mode: ChatMode = useRag ? (useDb ? 'full' : 'knowledge') : (useDb ? 'sql' : 'chat');
  const modes: ModeOpt[] = [
    { key: 'chat', rag: false, db: false, Icon: MessageSquareIcon, label: t('composer.mode.chat'), desc: t('composer.mode.chatDesc') },
    { key: 'knowledge', rag: true, db: false, Icon: BookOpenIcon, label: t('composer.mode.knowledge'), desc: t('composer.mode.knowledgeDesc') },
    { key: 'sql', rag: false, db: true, Icon: DatabaseIcon, label: t('composer.mode.sql'), desc: t('composer.mode.sqlDesc') },
    { key: 'full', rag: true, db: true, Icon: LayersIcon, label: t('composer.mode.full'), desc: t('composer.mode.fullDesc') },
  ];
  const active = modes.find((m) => m.key === mode) ?? modes[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.mode.label')}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2 text-[13px] font-medium whitespace-nowrap text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground/80 focus:outline-none focus-visible:outline-none sm:h-7 sm:px-2.5 [&_svg]:size-4 [&_svg]:shrink-0"
        >
          <active.Icon />
          <span className="sr-only sm:not-sr-only">{active.label}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </button>
      </MenuTrigger>
      <MenuPopup align="start">
        {modes.map((m) => (
          <MenuItem key={m.key} onSelect={() => setKnowledge(m.rag, m.db)} className="min-w-64 py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <m.Icon />
                {m.label}
                {m.key === mode && <CheckIcon className="size-3.5 text-blue-400" />}
              </span>
              <span className="text-xs leading-4 text-muted-foreground">{m.desc}</span>
            </div>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** Picks the right knowledge control for the chat input based on what's
 *  configured: the 3-mode dropdown when both RAG and SQL are set up, a single
 *  toggle when only one is, nothing when neither. Also clamps persisted flags
 *  so a stale toggle can't enable an unconfigured source. */
function KnowledgeControl() {
  const { t } = useTranslation();
  const { data: caps } = useQuery({ queryKey: ['capabilities'], queryFn: fetchCapabilities, staleTime: 60_000 });
  const useRag = usePrefs((s) => s.useRag);
  const useDb = usePrefs((s) => s.useDb);
  const setKnowledge = usePrefs((s) => s.setKnowledge);

  useEffect(() => {
    if (!caps) return;
    const r = caps.rag && useRag;
    const d = caps.sql && useDb;
    if (r !== useRag || d !== useDb) setKnowledge(r, d);
  }, [caps, useRag, useDb, setKnowledge]);

  if (!caps || (!caps.rag && !caps.sql)) return null;
  return (
    <>
      <FooterSeparator />
      {caps.rag && caps.sql ? (
        <ChatModeDropdown />
      ) : caps.rag ? (
        <ModeToggle
          active={useRag}
          onClick={() => setKnowledge(!useRag, false)}
          icon={<BookOpenIcon />}
          label={t('composer.rag')}
          tooltip={t('composer.ragTooltip')}
        />
      ) : (
        <ModeToggle
          active={useDb}
          onClick={() => setKnowledge(false, !useDb)}
          icon={<DatabaseIcon />}
          label={t('composer.sql')}
          tooltip={t('composer.sqlTooltip')}
        />
      )}
    </>
  );
}

type ReasoningOpt = { on: boolean; Icon: React.ComponentType<{ className?: string }>; label: string; desc: string };

/** Reasoning on/off dropdown, styled like the knowledge mode picker. Drives
 *  the `reasoning` flag; when off the backend sends vLLM enable_thinking:false. */
function ReasoningDropdown() {
  const { t } = useTranslation();
  const reasoning = usePrefs((s) => s.reasoning);
  const toggle = usePrefs((s) => s.toggle);
  const opts: ReasoningOpt[] = [
    { on: true, Icon: BrainIcon, label: t('composer.reasoning.on'), desc: t('composer.reasoning.onDesc') },
    { on: false, Icon: LightbulbIcon, label: t('composer.reasoning.off'), desc: t('composer.reasoning.offDesc') },
  ];
  const active = opts.find((o) => o.on === reasoning) ?? opts[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.reasoning.label')}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2 text-[13px] font-medium whitespace-nowrap text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground/80 focus:outline-none focus-visible:outline-none sm:h-7 sm:px-2.5 [&_svg]:size-4 [&_svg]:shrink-0"
        >
          <active.Icon />
          <span className="sr-only sm:not-sr-only">{active.label}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </button>
      </MenuTrigger>
      <MenuPopup align="start">
        {opts.map((o) => (
          <MenuItem key={String(o.on)} onSelect={() => { if (o.on !== reasoning) toggle('reasoning'); }} className="min-w-64 py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <o.Icon />
                {o.label}
                {o.on === reasoning && <CheckIcon className="size-3.5 text-blue-400" />}
              </span>
              <span className="text-xs leading-4 text-muted-foreground">{o.desc}</span>
            </div>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function Composer() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const cancelPlan = useChat((s) => s.cancelPlan);
  const pendingPlan = useChat(selectPendingPlan);
  const setPlanPanelOpen = useUi((s) => s.setPlanPanelOpen);
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

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void attach(e.dataTransfer.files);
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || streaming) return;
    const attachments = pending;
    setText('');
    setPending([]);
    requestAnimationFrame(autoresize);
    await send(value, {
      attachments,
      onSessionCreated: () => {
        void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
      },
    });
    void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
  };

  const canSend = (text.trim().length > 0 || pending.length > 0) && !uploading;

  const acceptPlan = async () => {
    if (!pendingPlan) return;
    await send(t('plan.implementing'), { approvedPlan: pendingPlan.content, planMode: false });
    void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
  };

  // A proposed plan replaces the input with an approval bar: Cancel discards it,
  // Accept executes it via the approved-plan flow. The full plan is in the panel.
  if (pendingPlan) {
    return (
      <div className="mx-auto w-full max-w-[800px] px-4 pb-4">
        <div className="flex items-center gap-3 rounded-[20px] border border-primary/30 bg-primary/[0.05] px-4 py-3">
          <button
            type="button"
            onClick={() => setPlanPanelOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-foreground"
          >
            <ListChecksIcon className="size-4 shrink-0 text-primary" />
            <span className="truncate">{t('plan.reviewPrompt')}</span>
          </button>
          <Button variant="outline" size="sm" onClick={cancelPlan}>
            {t('plan.cancel')}
          </Button>
          <Button size="sm" onClick={() => void acceptPlan()}>
            <PlayIcon /> {t('plan.accept')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[800px] px-4 pb-4">
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'relative rounded-[20px] border border-border bg-card transition-colors duration-200 focus-within:border-ring/45',
          dragging && 'border-primary/60 ring-2 ring-primary/30',
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[20px] bg-card/85 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <PaperclipIcon className="size-4" />
              {t('composer.dropFiles')}
            </div>
          </div>
        )}
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
                  aria-label={t('composer.removeFile', { name: String(f.name ?? f.id) })}
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
            data-composer-input
            value={text}
            rows={1}
            autoFocus
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.messageInput')}
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
        </div>

        <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-2.5 pt-1.5 pb-2.5 sm:px-3 sm:pb-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
          />

          {prefs.visibility.composerAttach && (
            <Tooltip label={t('composer.attachFiles')} side="top">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label={t('composer.attachFiles')}
                className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[18px]"
              >
                <PaperclipIcon className={uploading ? 'animate-pulse' : undefined} />
              </button>
            </Tooltip>
          )}

          <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ModelPicker visible={prefs.visibility.composerModelPicker} />

            <KnowledgeControl />

            <FooterSeparator />
            <ReasoningDropdown />

            {prefs.visibility.composerPlan && (
              <>
                <FooterSeparator />
                <ModeToggle
                  active={prefs.planMode}
                  onClick={() => prefs.toggle('planMode')}
                  icon={<PencilRulerIcon />}
                  label={t('composer.plan')}
                  inactiveIcon={<WrenchIcon />}
                  inactiveLabel={t('composer.work')}
                  tooltip={prefs.planMode ? t('composer.planTooltipActive') : t('composer.planTooltipInactive')}
                />
              </>
            )}
          </div>

          <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
            {prefs.visibility.contextMeter && <ContextMeter />}

            {streaming ? (
              <button
                type="button"
                onClick={stop}
                aria-label={t('composer.stop')}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_rgb(255_255_255/16%)] transition-all duration-150 hover:scale-105 hover:bg-destructive active:shadow-none active:inset-shadow-[0_1px_rgb(0_0_0/8%)] sm:h-8 sm:w-8"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <rect x="2" y="2" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={t('composer.send')}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-primary/24 enabled:inset-shadow-[0_1px_rgb(255_255_255/16%)] hover:scale-105 hover:bg-primary active:shadow-none active:inset-shadow-[0_1px_rgb(0_0_0/8%)] disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
