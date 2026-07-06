import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
  LightbulbIcon,
  FileTextIcon,
  ListChecksIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  PencilRulerIcon,
  PlayIcon,
  PlusIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities, uploadFiles, type UploadedFile } from '@/api/client';
import { selectPendingPlan, useChat } from '@/state/chat';
import { usePrefs, type ChatMode } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useDictation } from '@/lib/useDictation';
import { ContextMeter } from './ContextMeter';
import { ModelPicker } from './ModelPicker';
import { Button } from './ui/button';
import { Menu, MenuItem, MenuLabel, MenuPopup, MenuTrigger } from './ui/menu';
import { Tooltip } from './ui/misc';

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
          'flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap transition-colors sm:h-6 sm:px-2 [&_svg]:size-3.5 [&_svg]:shrink-0',
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

type ModeOpt = { key: ChatMode; rag: boolean; db: boolean; label: string; desc: string };

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
    { key: 'chat', rag: false, db: false, label: t('composer.mode.chat'), desc: t('composer.mode.chatDesc') },
    { key: 'knowledge', rag: true, db: false, label: t('composer.mode.knowledge'), desc: t('composer.mode.knowledgeDesc') },
    { key: 'sql', rag: false, db: true, label: t('composer.mode.sql'), desc: t('composer.mode.sqlDesc') },
    { key: 'full', rag: true, db: true, label: t('composer.mode.full'), desc: t('composer.mode.fullDesc') },
  ];
  const active = modes.find((m) => m.key === mode) ?? modes[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.mode.label')}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus:outline-none focus-visible:outline-none sm:h-6 sm:px-2 [&_svg]:size-3.5 [&_svg]:shrink-0',
            mode === 'full'
              ? 'bg-yellow-400/10 text-yellow-300 hover:bg-yellow-400/15 hover:text-yellow-200'
              : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground/80',
          )}
        >
          <span className="sr-only sm:not-sr-only">{active.label}</span>
        </button>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-36">
        {modes.map((m) => (
          <MenuItem
            key={m.key}
            onSelect={() => setKnowledge(m.rag, m.db)}
            className="gap-2 px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">{m.label}</span>
            {m.key === mode && <CheckIcon className="size-3 shrink-0" />}
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
  if (caps.rag && caps.sql) return <ChatModeDropdown />;
  return caps.rag ? (
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
  );
}

/** One-click reasoning switch: Thinking ↔ No Thinking. Drives the `reasoning`
 *  flag; when off the backend sends vLLM enable_thinking:false. */
function ThinkingToggle() {
  const { t } = useTranslation();
  const reasoning = usePrefs((s) => s.reasoning);
  const toggle = usePrefs((s) => s.toggle);
  return (
    <ModeToggle
      active={reasoning}
      onClick={() => toggle('reasoning')}
      icon={<BrainIcon />}
      label={t('composer.reasoning.on')}
      inactiveIcon={<LightbulbIcon />}
      inactiveLabel={t('composer.reasoning.off')}
      tooltip={reasoning ? t('composer.reasoning.onDesc') : t('composer.reasoning.offDesc')}
    />
  );
}

/** Microphone picker beside the dictate button: enumerates audio inputs on
 *  open (labels appear once mic permission has been granted) and persists the
 *  choice; "System default" clears it. Takes effect on the next recording. */
function MicDeviceMenu() {
  const { t } = useTranslation();
  const micDeviceId = usePrefs((s) => s.micDeviceId);
  const setMicDeviceId = usePrefs((s) => s.setMicDeviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const loadDevices = () => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput' && d.deviceId)))
      .catch(() => setDevices([]));
  };
  return (
    <Menu onOpenChange={(open) => { if (open) loadDevices(); }}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('composer.micSelect')}
          className="flex h-7 w-4 shrink-0 items-center justify-center rounded-sm rounded-l-none border border-transparent text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground/80 focus:outline-none focus-visible:outline-none sm:h-6"
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      </MenuTrigger>
      {/* Compact rows matching the knowledge-mode dropdown. */}
      <MenuPopup align="start">
        <MenuLabel className="px-2 py-1">{t('composer.micSelect')}</MenuLabel>
        <MenuItem
          onSelect={() => setMicDeviceId(null)}
          className="gap-2 px-2 py-1 text-xs [&_svg]:size-3.5"
        >
          <MicIcon />
          <span className="min-w-0 flex-1 truncate">{t('composer.micDefault')}</span>
          {micDeviceId === null && <CheckIcon className="size-3 shrink-0 text-blue-400" />}
        </MenuItem>
        {devices.map((d, i) => (
          <MenuItem
            key={d.deviceId}
            onSelect={() => setMicDeviceId(d.deviceId)}
            className="gap-2 px-2 py-1 text-xs [&_svg]:size-3.5"
          >
            <MicIcon />
            <span className="min-w-0 max-w-56 flex-1 truncate">
              {d.label || t('composer.micUnnamed', { n: i + 1 })}
            </span>
            {micDeviceId === d.deviceId && <CheckIcon className="size-3 shrink-0 text-blue-400" />}
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
  const { data: caps } = useQuery({ queryKey: ['capabilities'], queryFn: fetchCapabilities, staleTime: 60_000 });

  // Voice dictation (Claude-style): while recording, the live transcript is
  // shown italic in place of the textarea; the first Enter confirms it into
  // the (editable) input, the second Enter sends. Escape discards the clip.
  const dictation = useDictation(
    (spoken) => {
      setText((prev) => (prev.trim() ? prev.replace(/\s+$/, '') + ' ' : '') + spoken);
    },
    { streaming: caps?.voice_streaming, deviceId: prefs.micDeviceId },
  );
  const dictating = dictation.status !== 'idle';
  // Refocus once the textarea is visible again (it's hidden while dictating —
  // focusing it from the onFinal callback would silently fail), so the second
  // Enter submits.
  const wasDictating = useRef(false);
  useEffect(() => {
    if (wasDictating.current && !dictating) {
      autoresize();
      textarea.current?.focus();
      const el = textarea.current;
      el?.setSelectionRange(el.value.length, el.value.length);
    }
    wasDictating.current = dictating;
  });
  useEffect(() => {
    if (!dictating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (dictation.status === 'recording') dictation.confirm();
        // While finalizing, Enter is swallowed so a fast double-Enter can't
        // send before the transcript has landed in the input.
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dictation.cancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dictating, dictation]);

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

  // Drag & drop covers the whole chat area — a file dropped anywhere over the
  // <main> chat column attaches to the composer, not just over the input box.
  // Scoped to <main> (not window) so the left sidebar and the right-side panels
  // are NOT drop targets. A depth counter balances the enter/leave events that
  // fire on every child boundary; `attach` is read through a ref so the listeners
  // can register once without going stale.
  const attachRef = useRef(attach);
  attachRef.current = attach;
  const [dropZone, setDropZone] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const main = textarea.current?.closest('main') ?? document.querySelector('main');
    if (!main) return;
    setDropZone(main);
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer) void attachRef.current(e.dataTransfer.files);
    };
    main.addEventListener('dragenter', onDragEnter);
    main.addEventListener('dragover', onDragOver);
    main.addEventListener('dragleave', onDragLeave);
    main.addEventListener('drop', onDrop);
    return () => {
      main.removeEventListener('dragenter', onDragEnter);
      main.removeEventListener('dragover', onDragOver);
      main.removeEventListener('dragleave', onDragLeave);
      main.removeEventListener('drop', onDrop);
    };
  }, []);

  const submit = async () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || streaming || uploading || dictating) return;
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

  const acceptPlan = async () => {
    if (!pendingPlan) return;
    await send(t('plan.implementing'), { approvedPlan: pendingPlan.content, planMode: false });
    void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
  };

  // A proposed plan replaces the input with an approval bar: Cancel discards it,
  // Accept executes it via the approved-plan flow. The full plan is in the panel.
  if (pendingPlan) {
    return (
      <div className="mx-auto w-full max-w-[800px] px-4 pb-2">
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
    <div className="mx-auto w-full max-w-[800px] px-4 pb-2.5">
      {/* Drop overlay — covers only the chat area (portaled into <main>, which is
          position:relative), so the sidebar and side panels stay clear. Shown
          while dragging files anywhere over the chat column. */}
      {dragging && dropZone && createPortal(
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-3 rounded-md border-2 border-dashed border-primary/50 bg-card/90 px-12 py-9 shadow-lg">
            <PaperclipIcon className="size-7 text-primary" />
            <span className="text-base font-medium text-foreground">{t('composer.dropFiles')}</span>
          </div>
        </div>,
        dropZone,
      )}
      <div
        className={cn(
          'relative rounded-[12px] border border-border bg-card transition-colors duration-200 focus-within:border-ring/45',
          dragging && 'border-primary/60 ring-2 ring-primary/30',
        )}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
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

        <div className="flex items-start px-3 py-2.5">
          {dictating && (
            <div
              aria-live="polite"
              className="max-h-[200px] min-h-[26px] w-full overflow-y-auto text-[15px] leading-relaxed break-words whitespace-pre-wrap"
            >
              {text.trim() && <span>{text.replace(/\s+$/, '')} </span>}
              <span className="text-muted-foreground italic">
                {dictation.interim ||
                  (dictation.status === 'finalizing'
                    ? t('composer.transcribing')
                    : t('composer.listening'))}
              </span>
              <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-muted-foreground/70" />
            </div>
          )}
          <textarea
            hidden={dictating}
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
          {/* Right-edge adornment, Claude Code style: while streaming, a boxed
              stop button; otherwise an Enter glyph once there's something to
              send (or while dictating, where Enter stops the recording). */}
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              aria-label={t('composer.stop')}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center self-end rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-95"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              aria-label={t('composer.send')}
              onClick={() => {
                // Mirrors the Enter key: confirm a running dictation, send otherwise.
                if (dictation.status === 'recording') dictation.confirm();
                else void submit();
              }}
              className={cn(
                'ml-2 flex size-6 shrink-0 cursor-pointer items-center justify-center self-end rounded-sm transition-colors active:scale-95',
                // Always visible; barely-there while there's nothing to send.
                text.trim().length > 0 || dictating
                  ? 'text-muted-foreground/50 hover:bg-accent hover:text-foreground'
                  : 'text-muted-foreground/25',
              )}
            >
              <CornerDownLeftIcon aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Control row — outside the input card, Claude Code style: knowledge/add/mic
          on the left, model/thinking/context on the right. Enter sends; a stop
          button appears at the far right only while a response is streaming. */}
      <div className="mt-2.5 flex min-w-0 flex-nowrap items-center justify-between gap-2 px-1.5">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
        />

        {/* Left cluster: knowledge mode · add · mic + device picker · plan */}
        <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <KnowledgeControl />

          {prefs.visibility.composerAttach && (
              <Menu>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('composer.add')}
                    className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-transparent text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground/80 focus:outline-none focus-visible:outline-none sm:size-6 [&_svg]:size-3.5"
                  >
                    <PlusIcon className={uploading ? 'animate-pulse' : undefined} />
                  </button>
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuItem
                    onSelect={() => fileInput.current?.click()}
                    className="gap-2 px-2 py-1 text-xs [&_svg]:size-3.5"
                  >
                    <PaperclipIcon />
                    {t('composer.attachFiles')}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            )}

            {caps?.voice && (
              <div className="flex shrink-0 items-center">
                <Tooltip
                  label={
                    dictation.status === 'recording'
                      ? t('composer.dictateStop')
                      : t('composer.dictate')
                  }
                  side="top"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (dictation.status === 'recording') dictation.confirm();
                      else if (dictation.status === 'idle') void dictation.start();
                    }}
                    disabled={dictation.status === 'finalizing'}
                    aria-label={
                      dictation.status === 'recording'
                        ? t('composer.dictateStop')
                        : t('composer.dictate')
                    }
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-sm rounded-r-none border border-transparent transition-colors sm:size-6 [&_svg]:size-3.5',
                      dictation.status === 'recording'
                        ? 'animate-pulse bg-red-500/10 text-red-500 hover:bg-red-500/20'
                        : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground/80 disabled:opacity-50',
                    )}
                  >
                    {dictation.status === 'finalizing' ? (
                      <Loader2Icon className="animate-spin" />
                    ) : (
                      <MicIcon />
                    )}
                  </button>
                </Tooltip>
                <MicDeviceMenu />
              </div>
            )}

            {prefs.visibility.composerPlan && (
              <ModeToggle
                active={prefs.planMode}
                onClick={() => prefs.toggle('planMode')}
                icon={<PencilRulerIcon />}
                label={t('composer.plan')}
                inactiveIcon={<WrenchIcon />}
                inactiveLabel={t('composer.work')}
                tooltip={prefs.planMode ? t('composer.planTooltipActive') : t('composer.planTooltipInactive')}
              />
            )}
          </div>

          {/* Right cluster: model · thinking · context meter */}
          <div className="flex shrink-0 flex-nowrap items-center justify-end gap-1">
            <ModelPicker visible={prefs.visibility.composerModelPicker} />

            <ThinkingToggle />

            {prefs.visibility.contextMeter && <ContextMeter />}
          </div>
        </div>
      {dictation.error && !dictating && (
        <p className="mt-1 text-center text-[11px] leading-tight text-red-500">
          {dictation.error === 'mic-denied'
            ? t('composer.micDenied')
            : t('composer.dictationFailed')}
        </p>
      )}
    </div>
  );
}
