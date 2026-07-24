import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  ArrowUpIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
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
  ScanSearchIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities, uploadFiles, type UploadedFile } from '@/api/client';
import type { ArtifactSelection } from '@/api/types';
import { selectPendingPlan, useChat } from '@/state/chat';
import { usePrefs, type ChatMode } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useDictation } from '@/lib/useDictation';
import { artifactSelectionLocator } from '@/lib/artifactSelection';
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
          'flex h-6 shrink-0 items-center pt-[2px] gap-1.5 rounded-[4.5px] border border-transparent px-1 text-xs font-medium whitespace-nowrap transition-colors sm:h-5 sm:px-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:-translate-y-px',
          active
            ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300'
            : 'text-foreground/65 hover:bg-accent hover:text-foreground/90',
        )}
      >
        {face}
        {/* Without an icon the label is the whole face, so it must stay visible on mobile too. */}
        <span className={face ? 'sr-only sm:not-sr-only' : undefined}>{text}</span>
      </button>
    </Tooltip>
  );
}

type ModeOpt = { key: ChatMode; rag: boolean; db: boolean; label: string; desc: string };

type SlashCommand = {
  name: string;
  description: string;
  takesText?: boolean;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'btw', description: 'Ask a side question without changing the current task', takesText: true },
  { name: 'goal', description: 'Run autonomously until the goal is complete or blocked', takesText: true },
  { name: 'plan', description: 'Create an editable execution plan', takesText: true },
  { name: 'status', description: 'Show goal progress, next action, and blockers' },
  { name: 'compact', description: 'Summarize and persist older conversation context' },
  { name: 'pause', description: 'Pause the active goal after the current turn' },
  { name: 'resume', description: 'Resume a paused goal' },
  { name: 'cancel', description: 'Cancel the active goal and current run' },
  { name: 'attach', description: 'Choose local files to attach' },
  { name: 'summarize', description: 'Summarize text, attachments, or this conversation', takesText: true },
  { name: 'rewrite', description: 'Rewrite supplied or selected text', takesText: true },
  { name: 'extract', description: 'Extract structured facts and action items', takesText: true },
  { name: 'compare', description: 'Compare attached files or supplied passages', takesText: true },
  { name: 'decision', description: 'Analyze options, trade-offs, and recommend', takesText: true },
  { name: 'todos', description: 'Create an editable checklist', takesText: true },
  { name: 'export', description: 'Prepare the result as a local export', takesText: true },
  { name: 'skill', description: 'Create a reusable skill from a workflow or description', takesText: true },
];

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
            'flex h-6 shrink-0 items-center pt-[2px] gap-1.5 rounded-[4.5px] border border-transparent px-1 text-xs font-medium whitespace-nowrap outline-none transition-colors focus:outline-none focus-visible:outline-none sm:h-5 sm:px-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:-translate-y-px',
            mode === 'full'
              ? 'bg-yellow-400/10 text-yellow-400 hover:bg-yellow-400/15 hover:text-yellow-200'
              : 'text-foreground/65 hover:bg-accent hover:text-foreground/90',
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
      icon={null}
      label={t('composer.reasoning.on')}
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
          className="flex h-6 w-4 shrink-0 items-center pt-[2px] justify-center rounded-[4.5px] rounded-l-none border border-transparent text-foreground/65 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus:outline-none focus-visible:outline-none sm:h-5"
        >
          <ChevronDownIcon className="size-3.5 -translate-y-px" />
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
  const [slashIndex, setSlashIndex] = useState(0);
  const [commandError, setCommandError] = useState('');
  const [planArtifactSelections, setPlanArtifactSelections] = useState<Record<string, ArtifactSelection>>({});
  const [queuedMessages, setQueuedMessages] = useState<Array<{
    id: string;
    text: string;
    attachments: UploadedFile[];
    artifactSelection?: ArtifactSelection;
  }>>([]);
  const dragDepth = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const slashMenu = useRef<HTMLDivElement>(null);
  const previousSlashIndex = useRef(0);
  const streaming = useChat((s) => s.streaming);
  const sessionId = useChat((s) => s.sessionId);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const goal = useChat((s) => s.goal);
  const startGoal = useChat((s) => s.startGoal);
  const pauseGoal = useChat((s) => s.pauseGoal);
  const resumeGoal = useChat((s) => s.resumeGoal);
  const cancelGoal = useChat((s) => s.cancelGoal);
  const compact = useChat((s) => s.compact);
  const cancelPlan = useChat((s) => s.cancelPlan);
  const pendingPlan = useChat(selectPendingPlan);
  const setPlanPanelOpen = useUi((s) => s.setPlanPanelOpen);
  const artifactSelection = useUi((s) => s.artifactSelection);
  const setArtifactSelection = useUi((s) => s.setArtifactSelection);
  const prefs = usePrefs();
  const queryClient = useQueryClient();
  const { data: caps } = useQuery({ queryKey: ['capabilities'], queryFn: fetchCapabilities, staleTime: 60_000 });

  const slashMatch = text.match(/^\/([^\s]*)$/);
  const slashItems = slashMatch
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashMatch[1].toLowerCase()))
    : [];

  const rememberPlanSelection = (selection: ArtifactSelection | null) => {
    const key = selection?.sessionId ?? sessionId;
    if (!key) return;
    setPlanArtifactSelections((items) => {
      if (selection) return { ...items, [key]: selection };
      const next = { ...items };
      delete next[key];
      return next;
    });
  };

  useEffect(() => {
    setSlashIndex(0);
    previousSlashIndex.current = 0;
  }, [text]);
  useEffect(() => {
    const menu = slashMenu.current;
    const selected = menu?.querySelector<HTMLElement>(`[data-slash-index="${slashIndex}"]`);
    if (!menu || !selected) return;
    const previous = previousSlashIndex.current;
    previousSlashIndex.current = slashIndex;
    // Arrow navigation wraps. Follow that jump all the way so the newly
    // selected first/last command never remains outside the viewport.
    if (previous === slashItems.length - 1 && slashIndex === 0) {
      menu.scrollTop = 0;
      return;
    }
    if (previous === 0 && slashIndex === slashItems.length - 1) {
      menu.scrollTop = menu.scrollHeight;
      return;
    }
    const rowHeight = selected.offsetHeight;
    const rowTop = selected.offsetTop;
    const rowBottom = rowTop + rowHeight;
    const visibleTop = menu.scrollTop;
    const visibleBottom = visibleTop + menu.clientHeight;
    // Move exactly one row when keyboard selection crosses either edge. Using
    // scrollIntoView here can jump several rows depending on browser alignment.
    if (rowTop < visibleTop) menu.scrollTop = Math.max(0, visibleTop - rowHeight);
    else if (rowBottom > visibleBottom) menu.scrollTop = visibleTop + rowHeight;
  }, [slashIndex, slashItems.length]);

  // Messages submitted during a turn wait in FIFO order. Removing the item
  // before send prevents this effect from dispatching it twice when the store
  // updates several times during send setup.
  useEffect(() => {
    if (streaming || queuedMessages.length === 0) return;
    const next = queuedMessages[0];
    setQueuedMessages((items) => items.filter((item) => item.id !== next.id));
    void send(next.text, { attachments: next.attachments, artifactSelection: next.artifactSelection });
  }, [streaming, queuedMessages, send]);

  const steerQueuedMessage = (id: string) => {
    setQueuedMessages((items) => {
      const selected = items.find((item) => item.id === id);
      return selected ? [selected, ...items.filter((item) => item.id !== id)] : items;
    });
    stop();
  };

  const executeImmediate = async (name: string) => {
    setCommandError('');
    if (name === 'attach') { fileInput.current?.click(); return; }
    if (name === 'pause') { pauseGoal(); setText(''); return; }
    if (name === 'resume') { setText(''); await resumeGoal(); return; }
    if (name === 'cancel') { cancelGoal(); setText(''); return; }
    if (name === 'compact') {
      try { await compact(); setText(''); }
      catch (err) { setCommandError(err instanceof Error ? err.message : 'Compaction failed'); }
      return;
    }
    if (name === 'status') {
      setText('');
      await send('Report the current objective, completed work, current step, next action, and any blockers. Do not start new work.');
    }
  };

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
    const match = value.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (streaming) {
      if (!value && pending.length === 0) return;
      const queuedText = match?.[1]?.toLowerCase() === 'btw'
        ? `Side question: ${(match[2] ?? '').trim()}\n\nAnswer this briefly without changing, replacing, or reprioritizing the current task or goal. Then return control to the existing task.`
        : value;
      if (match?.[1]?.toLowerCase() === 'btw' && !(match[2] ?? '').trim()) {
        setCommandError('Add a question after /btw.');
        return;
      }
      setQueuedMessages((items) => [...items, {
        id: crypto.randomUUID(),
        text: queuedText,
        attachments: pending,
        artifactSelection: artifactSelection ?? undefined,
      }]);
      if (prefs.planMode) rememberPlanSelection(artifactSelection);
      setText('');
      setPending([]);
      if (!prefs.planMode) setArtifactSelection(null);
      requestAnimationFrame(autoresize);
      setCommandError('');
      return;
    }
    if ((!value && pending.length === 0) || uploading || dictating) return;

    if (match) {
      const command = match[1].toLowerCase();
      const arg = (match[2] ?? '').trim();
      setCommandError('');
      if (command === 'attach') { fileInput.current?.click(); return; }
      if (command === 'compact') {
        try { await compact(); setText(''); } catch (err) { setCommandError(err instanceof Error ? err.message : 'Compaction failed'); }
        return;
      }
      if (command === 'pause') { pauseGoal(); setText(''); return; }
      if (command === 'resume') { setText(''); await resumeGoal(); return; }
      if (command === 'cancel') { cancelGoal(); setText(''); return; }
      if (command === 'goal') {
        if (!arg) { setCommandError('Add an objective after /goal.'); return; }
        setText(''); setPending([]); requestAnimationFrame(autoresize);
        await startGoal(arg);
        return;
      }
      const prompts: Record<string, string> = {
        btw: `Side question: ${arg}\n\nAnswer this briefly without changing, replacing, or reprioritizing the current task or goal. Then return control to the existing task.`,
        plan: `Create an editable step-by-step plan for: ${arg || 'the current request'}. Do not execute it yet.`,
        status: 'Report the current objective, completed work, current step, next action, and any blockers. Do not start new work.',
        summarize: `Summarize ${arg || 'the attached material or current conversation'}. Preserve decisions, constraints, dates, and open questions.`,
        rewrite: `Rewrite the following clearly while preserving its meaning: ${arg || 'the attached or most recently discussed text'}`,
        extract: `Extract structured facts, decisions, dates, people, and action items from: ${arg || 'the attached material or current conversation'}`,
        compare: `Compare ${arg || 'the attached materials'}. Show meaningful similarities, differences, conflicts, and a concise conclusion.`,
        decision: `Analyze this decision: ${arg || 'the current decision'}. Give options, trade-offs, assumptions, risks, and a recommendation.`,
        todos: `Turn ${arg || 'the current conversation or attachments'} into an editable checklist with clear completion criteria.`,
        export: `Prepare ${arg || 'the current result'} as a clean, self-contained document suitable for saving locally.`,
        skill: `Create a reusable Talos skill for: ${arg || 'the workflow in the current conversation'}. Follow the skill-creator workflow — capture the intent (what it does, when it should trigger and when NOT, expected output), draft SKILL.md with a pushy description plus any needed references/scripts in a workspace folder, then save it with the create_skill tool. Ask me for anything you need before finalizing.`,
      };
      if (prompts[command]) {
        setText(''); setPending([]); requestAnimationFrame(autoresize);
        const selection = artifactSelection ?? undefined;
        if (command === 'plan' || prefs.planMode) rememberPlanSelection(artifactSelection);
        if (command !== 'plan' && !prefs.planMode) setArtifactSelection(null);
        await send(prompts[command], { attachments: pending, artifactSelection: selection });
        return;
      }
    }
    const attachments = pending;
    const selection = artifactSelection ?? undefined;
    if (prefs.planMode) rememberPlanSelection(artifactSelection);
    setText('');
    setPending([]);
    if (!prefs.planMode) setArtifactSelection(null);
    requestAnimationFrame(autoresize);
    await send(value, {
      attachments,
      artifactSelection: selection,
      onSessionCreated: () => {
        void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
      },
    });
    void queryClient.refetchQueries({ queryKey: ['sessions'], type: 'active' });
  };

  const acceptPlan = async () => {
    if (!pendingPlan) return;
    const selection = sessionId ? planArtifactSelections[sessionId] : undefined;
    rememberPlanSelection(null);
    setArtifactSelection(null);
    await send(t('plan.implementing'), { approvedPlan: pendingPlan.content, planMode: false, artifactSelection: selection });
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
      {queuedMessages.length > 0 && (
        <div className="mb-2 space-y-1.5" aria-label={t('composer.queuedMessages')}>
          {queuedMessages.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-xs">
              <span className="shrink-0 font-medium text-muted-foreground">{t('composer.queued')}</span>
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <Tooltip label={t('composer.steerNow')} side="top">
                <button
                  type="button"
                  onClick={() => steerQueuedMessage(item.id)}
                  aria-label={t('composer.steerNow')}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
              </Tooltip>
              <button
                type="button"
                onClick={() => setQueuedMessages((items) => items.filter((queued) => queued.id !== item.id))}
                aria-label={t('composer.removeQueued')}
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-destructive"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={cn(
          'group/composer relative rounded-[10px] border border-foreground/10 bg-card transition-colors duration-200 focus-within:border-foreground/20',
          dragging && 'border-primary/60 ring-2 ring-primary/30',
        )}
      >
        {slashItems.length > 0 && (
          <div ref={slashMenu} className="absolute inset-x-0 bottom-full z-40 mb-1.5 max-h-64 overflow-y-auto rounded-md border bg-popover px-1 py-1.5 text-popover-foreground shadow-xl">
            {slashItems.map((command, index) => (
              <button
                key={command.name}
                data-slash-index={index}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (command.takesText) {
                    setText(`/${command.name} `);
                    requestAnimationFrame(() => textarea.current?.focus());
                  } else {
                    void executeImmediate(command.name);
                  }
                }}
                onMouseEnter={() => setSlashIndex(index)}
                className={cn('flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left', index === slashIndex && 'bg-accent')}
              >
                <span className="w-20 shrink-0 font-mono text-xs font-medium text-primary">/{command.name}</span>
                <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        )}
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
        {artifactSelection && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-2 py-1 text-xs">
              <ScanSearchIcon className="size-3.5 text-primary" />
              <span className="max-w-64 truncate">{t('composer.selectionChip', { locator: artifactSelectionLocator(artifactSelection) ? ` ${artifactSelectionLocator(artifactSelection)}` : '' })}</span>
              <button type="button" aria-label={t('composer.removeArtifactSelection')} onClick={() => setArtifactSelection(null)} className="text-muted-foreground hover:text-foreground"><XIcon className="size-3" /></button>
            </span>
          </div>
        )}

        <div className="flex items-start py-2.5 pl-2.5 pr-2">
          {dictating && (
            <div
              aria-live="polite"
              className="max-h-[200px] w-full overflow-y-auto text-[15px] leading-relaxed break-words whitespace-pre-wrap"
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
              if (slashItems.length && e.key === 'ArrowDown') {
                e.preventDefault(); setSlashIndex((i) => (i + 1) % slashItems.length); return;
              }
              if (slashItems.length && e.key === 'ArrowUp') {
                e.preventDefault(); setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length); return;
              }
              if (slashItems.length && (e.key === 'Tab' || e.key === 'Enter')) {
                e.preventDefault();
                const command = slashItems[slashIndex];
                if (command.takesText) setText(`/${command.name} `);
                else void executeImmediate(command.name);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) { e.preventDefault(); void attach(files); }
            }}
            className="max-h-[200px] w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          {/* Right-edge adornment, Claude Code style: while streaming, a boxed
              stop button; otherwise an Enter glyph once there's something to
              send (or while dictating, where Enter stops the recording). */}
          {streaming && !text.trim() && pending.length === 0 ? (
            <button
              type="button"
              onClick={stop}
              aria-label={t('composer.stop')}
              // -my keeps the 28px hit target from adding height to the row
              // (the textarea line is 26px), so the box doesn't grow while
              // streaming.
              className="-my-1 flex size-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-sm text-foreground/65 transition-colors hover:bg-accent hover:text-foreground active:scale-95"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
                // Tracks the box border: foreground/10 resting, /20 while the
                // composer is focused, so glyph and frame read as one control.
                'ml-2 flex size-6 shrink-0 cursor-pointer items-center justify-center self-end rounded-sm text-foreground/10 transition-colors group-focus-within/composer:text-foreground/20 active:scale-95',
                (text.trim().length > 0 || dictating) && 'hover:bg-accent hover:text-foreground',
              )}
            >
              <CornerDownLeftIcon aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      {goal && !['completed', 'cancelled'].includes(goal.status) && (
        <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span className={cn('size-2 rounded-full', goal.status === 'running' ? 'animate-pulse bg-emerald-500' : 'bg-amber-500')} />
          <span className="min-w-0 flex-1 truncate">
            Goal · {goal.status} · iteration {goal.iteration} · {goal.objective}
          </span>
          {goal.status === 'running' ? (
            <button type="button" onClick={pauseGoal} aria-label="Pause goal" className="text-muted-foreground hover:text-foreground"><CirclePauseIcon className="size-4" /></button>
          ) : goal.status === 'paused' ? (
            <button type="button" onClick={() => void resumeGoal()} aria-label="Resume goal" className="text-muted-foreground hover:text-foreground"><PlayIcon className="size-4" /></button>
          ) : null}
          <button type="button" onClick={cancelGoal} aria-label="Cancel goal" className="text-muted-foreground hover:text-destructive"><CircleStopIcon className="size-4" /></button>
        </div>
      )}
      {commandError && <p className="mt-1 text-center text-xs text-destructive">{commandError}</p>}

      {/* Control row — outside the input card, Claude Code style: knowledge/add/mic
          on the left, model/thinking/context on the right. Enter sends; a stop
          button appears at the far right only while a response is streaming. */}
      <div className="mt-2.5 flex min-w-0 flex-nowrap items-center justify-between gap-2">
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
                    className="flex size-6 shrink-0 items-center pt-[2px] justify-center rounded-[4.5px] border border-transparent text-foreground/65 outline-none transition-colors hover:bg-accent hover:text-foreground/90 focus:outline-none focus-visible:outline-none sm:size-5 [&_svg]:size-3.5 [&_svg]:-translate-y-px"
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
                      'flex h-6 w-7 shrink-0 items-center pt-[2px] justify-center rounded-[4.5px] rounded-r-none border border-transparent transition-colors sm:h-5 sm:w-6 [&_svg]:size-3.5 [&_svg]:-translate-y-px',
                      dictation.status === 'recording'
                        ? 'animate-pulse bg-red-500/10 text-red-500 hover:bg-red-500/20'
                        : 'text-foreground/65 hover:bg-accent hover:text-foreground/90 disabled:opacity-50',
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
            : dictation.error === 'insecure-context'
              ? t('composer.micInsecureContext')
              : t('composer.dictationFailed')}
        </p>
      )}
    </div>
  );
}
