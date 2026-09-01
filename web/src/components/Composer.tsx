import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CornerDownLeftIcon,
  ListChecksIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  PlayIcon,
  XIcon,
  ScanSearchIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { fetchCapabilities, uploadDownloadUrl, uploadFiles, type UploadedFile } from '@/api/client';
import type { ArtifactSelection } from '@/api/types';
import { selectPendingPlan, useChat } from '@/state/chat';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { useDictation } from '@/lib/useDictation';
import { artifactSelectionLocator } from '@/lib/artifactSelection';
import { previewKind } from '@/lib/files';
import { ContextMeter } from './ContextMeter';
import { FilePreviewFace, hasVisualPreview, openUploadViewer } from './AttachmentTile';
import { FileTypeIcon } from './FileTypeIcon';
import { ComposerAddMenu } from './ComposerAddMenu';
import { ModelEffortPicker } from './ModelEffortPicker';
import { Button } from './ui/button';
import { Tooltip } from './ui/misc';

/** How tall the input may grow before it starts scrolling. */
const MAX_INPUT_HEIGHT = 220;

/** Gap the text keeps from the controls pinned inside the box (matches the
 *  box's own 8px inset, so the add button is evenly spaced all round). */
const CONTROL_GAP = 8;

/** Typography shared by the input and its measuring twin — they have to wrap
 *  identically or the animated height lands on the wrong line count. */
const INPUT_TEXT = 'text-base leading-relaxed';

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

/** Dictate button, now inside the input box beside the send control. The
 *  microphone chooser that used to sit next to it moved into the add menu. */
function MicButton({
  status,
  onClick,
  hero,
}: {
  status: 'idle' | 'recording' | 'finalizing';
  onClick: () => void;
  hero?: boolean;
}) {
  const { t } = useTranslation();
  const label = status === 'recording' ? t('composer.dictateStop') : t('composer.dictate');
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={onClick}
        disabled={status === 'finalizing'}
        aria-label={label}
        className={cn(
          'flex shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:scale-95',
          hero ? 'size-8 [&_svg]:size-4' : 'size-7 [&_svg]:size-3.5',
          status === 'recording'
            ? 'animate-pulse bg-red-500/10 text-red-500 hover:bg-red-500/20'
            : 'text-foreground/45 hover:bg-accent hover:text-foreground/70 disabled:opacity-50 dark:text-foreground/35 dark:hover:text-foreground/60',
        )}
      >
        {status === 'finalizing' ? <Loader2Icon className="animate-spin" /> : <MicIcon />}
      </button>
    </Tooltip>
  );
}

/** Stop control shown while a turn streams. Same treatment as the send glyph it
 *  replaces — plate-only hover, glyph tracking the composer frame — so the swap
 *  doesn't change the control's weight mid-turn. */
function StopButton({ onClick, hero }: { onClick: () => void; hero?: boolean }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t('composer.stop')} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={t('composer.stop')}
        className={cn(
          'flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground/20 transition-colors hover:bg-accent active:scale-95 group-focus-within/composer:text-foreground/40 dark:text-foreground/10 dark:group-focus-within/composer:text-foreground/20',
          hero ? 'size-8' : 'size-7',
        )}
      >
        <svg width={hero ? 16 : 14} height={hero ? 16 : 14} viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </Tooltip>
  );
}

export function Composer() {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  // Empty-state prompt: one of a handful, re-rolled whenever the box goes empty
  // (mount, send, clear) and held steady while there is text to type over.
  const placeholders = useMemo(() => {
    const list = t('composer.placeholders', { returnObjects: true });
    return Array.isArray(list) && list.length > 0 ? (list as string[]) : [t('composer.placeholder')];
    // Keyed on the language, not on `t`: `t` gets a new identity on unrelated
    // i18n activity, and a fresh array here used to re-roll the prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);
  const [placeholder, setPlaceholder] = useState(() => placeholders[Math.floor(Math.random() * placeholders.length)]);
  const empty = text.length === 0;
  // One roll per emptying, not one per render while empty — otherwise every
  // unrelated re-render (streaming ticks, menu opens) swaps the prompt, which
  // reads as the box changing its mind while you look at it.
  const wasEmpty = useRef(true);
  useEffect(() => {
    if (empty && !wasEmpty.current) {
      setPlaceholder(placeholders[Math.floor(Math.random() * placeholders.length)]);
    }
    wasEmpty.current = empty;
  }, [empty, placeholders]);
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
  const mirror = useRef<HTMLDivElement>(null);
  const inputRow = useRef<HTMLDivElement>(null);
  const inputBox = useRef<HTMLDivElement>(null);
  const inputLead = useRef<HTMLDivElement>(null);
  const inputTrail = useRef<HTMLDivElement>(null);
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

  // A draft with no session yet is the new-chat screen: the box grows into the
  // hero layout that carries its own control row.
  const hero = sessionId === null;
  // Typing during a turn queues the message, so the send control stays a send
  // control; the stop disc only replaces it while there is nothing to queue.
  const showStop = streaming && !text.trim() && pending.length === 0;

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

  // Height is measured on a hidden twin rather than by resetting the textarea
  // to `height:auto`: that reset forces a layout at the content height, which
  // becomes the transition's starting point and kills the growth animation.
  // The twin carries the same width, font and wrapping, so its height is the
  // one the textarea should animate to.
  const autoresize = () => {
    const el = textarea.current;
    const twin = mirror.current;
    const row = inputRow.current;
    const box = inputBox.current;
    if (!el) return;
    if (!twin || !row || !box) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
      return;
    }
    // The trailing newline keeps a just-opened line from collapsing away.
    twin.textContent = `${el.value}\n`;
    const pad = getComputedStyle(row);
    const inner = row.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const lead = inputLead.current?.offsetWidth ?? 0;
    const trail = inputTrail.current?.offsetWidth ?? 0;
    const measure = (width: number) => {
      twin.style.width = `${Math.max(1, width)}px`;
      return twin.scrollHeight;
    };
    // Two widths: the narrow lane between the pinned controls, and the full
    // box. Whether the text has outgrown its lane is decided at the NARROW
    // width only — deciding it at whatever width is currently applied would
    // oscillate, since widening can drop the very line that caused the switch.
    const lanePad = (lead ? lead + CONTROL_GAP : 0) + (trail ? trail + CONTROL_GAP : 0);
    const laneHeight = measure(inner - lanePad);
    const lineHeight = parseFloat(getComputedStyle(twin).lineHeight) || laneHeight;
    const overflows = laneHeight > lineHeight + 1;
    const height = Math.min(overflows ? measure(inner) : laneHeight, MAX_INPUT_HEIGHT);
    // Margins, not a re-render: this runs on every keystroke, and CSS animates
    // the text sliding over the controls for free.
    box.style.marginInlineStart = overflows || !lead ? '0px' : `${lead + CONTROL_GAP}px`;
    box.style.marginInlineEnd = overflows || !trail ? '0px' : `${trail + CONTROL_GAP}px`;
    const controlRow = Math.max(inputLead.current?.offsetHeight ?? 0, inputTrail.current?.offsetHeight ?? 0);
    box.style.marginBottom = overflows && controlRow ? `${controlRow + CONTROL_GAP}px` : '0px';
    el.style.height = `${height}px`;
    // A scrollbar while the box is still growing is just the animation lagging
    // the content; only a genuinely capped input scrolls.
    el.style.overflowY = height >= MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
  };

  // Widths change without the text changing: mount, viewport resize, and the
  // control set itself (mic appearing once capabilities load, send ↔ stop).
  useEffect(() => {
    autoresize();
    const onResize = () => autoresize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero, caps?.voice, showStop, dictating, prefs.visibility.composerAttach]);

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
    <div className="mx-auto w-full max-w-[800px] px-4 pb-1">
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
          // Light mode: the box shares the page background and is defined by its
          // frame alone, which steps darker while focused. Dark mode keeps the
          // raised --card panel, where a flush box would disappear.
          // The faint lift in light mode: the box shares the page background, so
          // a whisper of shadow is what separates it from the message stream.
          // Dark mode drops it — the --card step already does that job there.
          'group/composer relative rounded-[10px] border border-foreground/14 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.03),0_6px_16px_-8px_rgba(0,0,0,0.07)] transition-colors duration-200 focus-within:border-foreground/32 dark:border-foreground/10 dark:bg-card dark:shadow-none dark:focus-within:border-foreground/20',
          dragging && 'border-primary/60 ring-2 ring-primary/30',
        )}
      >
        {slashItems.length > 0 && (
          <div ref={slashMenu} className="dropdown-glass absolute inset-x-0 bottom-full z-40 mb-1.5 max-h-64 overflow-y-auto rounded-lg p-1 text-popover-foreground">
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
                className={cn(
                  'flex min-h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left sm:min-h-7',
                  index === slashIndex && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="w-20 shrink-0 font-mono text-xs font-medium text-primary">/{command.name}</span>
                <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        )}
        {/* Staged attachments: an image shows itself, anything else shows the
            glyph with its type baked in (PDF, XLSX, PY…) next to the name. The
            remove button only surfaces on hover/focus, so a full strip reads as
            content rather than as a row of close boxes. */}
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {pending.map((f) => {
              const name = String(f.name ?? f.id);
              const isImage = previewKind(name, f.mime) === 'image';
              return (
                <div key={f.id} className="group/att relative">
                  <Tooltip label={name} side="top">
                    {/* Images and PDFs open their viewer straight from the
                        composer — the same click they answer once sent. */}
                    <button
                      type="button"
                      onClick={() => openUploadViewer({ url: uploadDownloadUrl(f.id), name, mime: f.mime, sessionId })}
                      className={cn(
                        'block text-left transition-opacity',
                        hasVisualPreview(name, f.mime) ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
                      )}
                    >
                      {isImage ? (
                        <div className="size-12 overflow-hidden rounded-lg border bg-muted">
                          <FilePreviewFace url={uploadDownloadUrl(f.id)} name={name} mime={f.mime} width={48} height={48} />
                        </div>
                      ) : (
                        <div className="flex h-12 max-w-48 items-center gap-2 rounded-lg border bg-muted px-2.5 text-xs">
                          <FileTypeIcon path={name} mime={f.mime} className="size-5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 truncate">{name}</span>
                        </div>
                      )}
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    aria-label={t('composer.removeFile', { name })}
                    onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}
                    className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/att:opacity-100"
                  >
                    <XIcon className="size-2.5" />
                  </button>
                </div>
              );
            })}
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

        <div ref={inputRow} className={cn('relative', hero ? 'px-3 pb-1 pt-2' : 'p-2')}>
          {/* Text block. In the conversation layout it starts out inset between
              the pinned controls below and widens over them once it wraps —
              autoresize animates those margins, so the text flows into the full
              width instead of stranding a gutter beside the growing box. */}
          <div ref={inputBox} className="relative min-w-0 transition-[margin] duration-150 ease-out">
          {dictating && (
            <div
              aria-live="polite"
              className={cn('w-full overflow-y-auto break-words whitespace-pre-wrap', INPUT_TEXT)}
              style={{ maxHeight: MAX_INPUT_HEIGHT }}
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
          {/* Hidden twin the height animation measures against — see autoresize. */}
          <div
            ref={mirror}
            aria-hidden="true"
            className={cn(
              'pointer-events-none invisible absolute left-0 top-0 break-words whitespace-pre-wrap',
              INPUT_TEXT,
            )}
          />
          <textarea
            hidden={dictating}
            ref={textarea}
            data-composer-input
            value={text}
            rows={1}
            autoFocus
            placeholder={placeholder}
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
            className={cn(
              'relative block w-full resize-none bg-transparent text-strong outline-none transition-[height] duration-150 ease-out placeholder:text-muted-foreground/65 dark:placeholder:text-muted-foreground',
              INPUT_TEXT,
            )}
            style={{ maxHeight: MAX_INPUT_HEIGHT }}
          />
          </div>
          {/* Conversation layout: the controls are pinned to the bottom of the
              box — add on the left, mic and send/stop on the right — so a
              growing text block can slide over them instead of pushing them
              around. The new-chat box carries its controls in the row below. */}
          {!hero && prefs.visibility.composerAttach && (
            <div ref={inputLead} className="absolute bottom-2 start-2">
              <ComposerAddMenu
                onAttach={() => fileInput.current?.click()}
                uploading={uploading}
                showMic={!!caps?.voice}
                showPlan={prefs.visibility.composerPlan}
              />
            </div>
          )}
          {!hero && (
            <div ref={inputTrail} className="absolute bottom-2 end-2 flex items-center gap-1">
              {caps?.voice && (
                <MicButton
                  status={dictation.status}
                  onClick={() => {
                    if (dictation.status === 'recording') dictation.confirm();
                    else if (dictation.status === 'idle') void dictation.start();
                  }}
                />
              )}
              {showStop ? (
                <StopButton onClick={stop} />
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
                    // The hover plate is always there — a glyph with no hit feedback
                    // reads as decoration. Only the plate reacts: the glyph keeps
                    // tracking the composer frame so the two stay one control.
                    'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground/20 transition-colors group-focus-within/composer:text-foreground/40 hover:bg-accent active:scale-95 dark:text-foreground/10 dark:group-focus-within/composer:text-foreground/20',
                  )}
                >
                  <CornerDownLeftIcon aria-hidden="true" className="size-4" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* New-chat layout: every control sits inside the box, Claude-style —
            the add menu (which carries the knowledge and plan switches) on the
            left, model+effort and the send control on the right. */}
        {hero && (
          // px-1.5 rather than px-3: the button plate insets its glyph by 6px,
          // so this is what puts the + glyph on the same left edge as the text
          // above it, with the same 12px to the bottom of the box.
          <div className="flex min-w-0 items-center gap-1 ps-1.5 pe-3 pb-1">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
            />
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {prefs.visibility.composerAttach && (
                <ComposerAddMenu
                  onAttach={() => fileInput.current?.click()}
                  uploading={uploading}
                  showMic={!!caps?.voice}
                  showPlan={prefs.visibility.composerPlan}
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <ModelEffortPicker visible={prefs.visibility.composerModelPicker} />
              {showStop ? (
                <StopButton hero onClick={stop} />
              ) : empty && pending.length === 0 && caps?.voice && !dictating ? (
                <MicButton hero status={dictation.status} onClick={() => void dictation.start()} />
              ) : (
                <button
                  type="button"
                  aria-label={t('composer.send')}
                  onClick={() => {
                    if (dictation.status === 'recording') dictation.confirm();
                    else void submit();
                  }}
                  className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95"
                >
                  <ArrowUpIcon aria-hidden="true" className="size-4" />
                </button>
              )}
            </div>
          </div>
        )}
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

      {/* Control row — under the input card once a conversation is running.
          Everything else moved inside the box or into the add menu, so the
          left half is free for the AI disclaimer and the right holds the
          model+effort picker with the context meter, all on one centre line. */}
      {!hero && (
        <div className="mt-1 flex min-w-0 flex-nowrap items-center justify-between gap-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
          />

          <p className="min-w-0 truncate ps-1 text-xs text-muted-foreground/70">{t('composer.aiDisclaimer')}</p>

          <div className="me-2 flex shrink-0 flex-nowrap items-center justify-end gap-1">
            <ModelEffortPicker visible={prefs.visibility.composerModelPicker} placement="outside" />

            {prefs.visibility.contextMeter && <ContextMeter />}
          </div>
        </div>
      )}
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
