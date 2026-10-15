import { useTranslation } from 'react-i18next';
import { CheckIcon, LoaderCircleIcon, PanelRightIcon, XIcon } from 'lucide-react';
import { useUi } from '@/state/ui';
import { type UiMessage, useChat } from '@/state/chat';
import { cn } from '@/lib/utils';
import { PlanIcon } from './icons';

export interface Step {
  text: string;
  done: boolean;
}

/** Pull GitHub-style checklist lines (`- [ ]` / `- [x]`) out of markdown. */
export function parseChecklist(markdown: string): Step[] {
  const steps: Step[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (m) steps.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() });
  }
  return steps;
}

/** Where a step stands: behind us, being worked on, or still ahead. The step
 *  "in work" is the first open one — but only while the turn runs; a settled
 *  turn works on nothing. */
type StepState = 'done' | 'current' | 'ahead';

function stepStates(steps: Step[], live: boolean): StepState[] {
  const current = live ? steps.findIndex((s) => !s.done) : -1;
  return steps.map((s, i) => (s.done ? 'done' : i === current ? 'current' : 'ahead'));
}

/** The plan as a vertical route: milestones on a line that fills in as the
 *  work passes them, the step in work lifted onto its own plate. */
function Timeline({ steps, live, compact }: { steps: Step[]; live: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const states = stepStates(steps, live);
  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const state = states[i];
        const last = i === steps.length - 1;
        return (
          <li key={i} className={cn('relative flex gap-2.5', compact ? '[--node-c:14px]' : '[--node-c:16px]')}>
            {/* Connector to the next milestone, centre to centre — it runs
                into the next row and under its node, so line and circles
                always meet. Filled once this milestone is done. */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-[var(--node-c)] -bottom-[var(--node-c)] left-2.5 w-px -translate-x-1/2',
                  state === 'done' ? 'bg-primary/70' : 'bg-foreground/15',
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                'relative z-[1] flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums',
                compact ? 'mt-1' : 'mt-1.5',
                state === 'done' && 'bg-primary text-primary-foreground',
                state === 'current' && 'bg-background text-primary ring-[1.5px] ring-primary',
                state === 'ahead' && 'bg-background text-muted-foreground ring-1 ring-foreground/20',
              )}
            >
              {state === 'done' ? (
                <CheckIcon className="size-3" strokeWidth={3} />
              ) : state === 'current' ? (
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
              ) : (
                i + 1
              )}
            </span>
            <div
              className={cn(
                'mb-1.5 min-w-0 flex-1 rounded-lg px-2.5',
                compact ? 'py-1' : 'py-1.5',
                state === 'current' && 'bg-primary/[0.08] ring-1 ring-primary/20',
              )}
            >
              {state === 'current' && (
                <span className="mb-0.5 block text-[10.5px] font-semibold tracking-wide text-primary uppercase">
                  {t('plan.now')}
                </span>
              )}
              <span
                className={cn(
                  'block text-[13px] leading-snug break-words',
                  state === 'done' && 'text-muted-foreground',
                  state === 'current' && 'font-medium text-foreground',
                  state === 'ahead' && 'text-foreground/85',
                )}
              >
                {step.text}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Progress as a ring with the count inside. */
function ProgressRing({ done, total, size = 44 }: { done: number; total: number; size?: number }) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const share = total ? done / total : 0;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - share)}
          className={cn('transition-[stroke-dashoffset] duration-700', share === 1 ? 'stroke-success' : 'stroke-primary')}
        />
      </svg>
      <span className="absolute text-[11px] font-semibold tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

/** One step's marker in the inline checklist: a filled check once done, a
 *  spinner while it is being worked on, a dashed ring while still ahead. */
function StepMarker({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      // Disc and check in ONE svg: as a span plus a nested icon the two boxes
      // snap to different fractional pixels (odd sizes, 125% scaling) and the
      // check drifts off-centre. Drawn together they always rasterise as one.
      <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="8" className="fill-muted-foreground/70" />
        <path
          d="M4.75 8.25 7 10.5 11.25 5.75"
          fill="none"
          className="stroke-background"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === 'current') {
    return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-foreground/80" strokeWidth={2.25} />;
  }
  return <span className="size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/60" />;
}

/** The turn's `update_plan` checklist under its reply: one row per step, the
 *  step in work spinning while the turn runs. Stays with the turn once it has
 *  settled (restored from the persisted tool event on reload); the pane
 *  button pins it beside the chat. */
export function PlanCard({ msg, live }: { msg: UiMessage; live: boolean }) {
  const { t } = useTranslation();
  const openPane = useUi((s) => s.setPlanPanelOpen);
  const steps = parseChecklist(msg.plan ?? '');
  if (steps.length === 0) return null;
  const states = stepStates(steps, live);
  const done = steps.filter((s) => s.done).length;

  return (
    <div
      className="group/plan relative mt-3 mb-6 rounded-xl border bg-card/40 px-4 py-3"
      aria-label={`${t('plan.title')} · ${t('plan.progress', { done, total: steps.length })}`}
    >
      <button
        type="button"
        title={t('plan.openInPanel')}
        aria-label={t('plan.openInPanel')}
        onClick={() => openPane(true)}
        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/plan:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
      >
        <PanelRightIcon className="size-3.5" />
      </button>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-2.5">
            <StepMarker state={states[i]} />
            <span
              className={cn(
                'min-w-0 text-sm leading-snug break-words',
                states[i] === 'done' && 'text-muted-foreground',
                states[i] === 'current' && 'font-medium text-foreground',
                states[i] === 'ahead' && 'text-foreground/80',
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The newest `update_plan` checklist of this chat. In the chat it scrolls
 *  away with its turn; the plan pane keeps it in view while the work runs. */
export function useSessionPlan(): string | undefined {
  return useChat((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].plan) return s.messages[i].plan;
    }
    return undefined;
  });
}

/** The plan as a pane of the right dock: a progress ring with where the work
 *  stands, then the route of steps. */
export function PlanPane({ className }: { className?: string }) {
  const { t } = useTranslation();
  const close = useUi((s) => s.setPlanPanelOpen);
  const live = useChat((s) => s.streaming);
  const steps = parseChecklist(useSessionPlan() ?? '');
  const done = steps.filter((s) => s.done).length;
  const allDone = steps.length > 0 && done === steps.length;
  const next = steps.find((s) => !s.done);
  const status = allDone
    ? t('plan.allDone')
    : live
      ? t('plan.stepOf', { n: done + 1, total: steps.length })
      : t('plan.remaining', { count: steps.length - done });

  return (
    <section className={className} aria-label={t('plan.title')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <PlanIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('plan.title')}</span>
        <button
          type="button"
          aria-label={t('plan.closePanel')}
          onClick={() => close(false)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {steps.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('plan.empty')}</p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b px-3 py-3">
              <ProgressRing done={done} total={steps.length} />
              <div className="min-w-0">
                <div className={cn('text-sm font-semibold', allDone && 'text-success')}>{status}</div>
                {!allDone && next && (
                  <div className="truncate text-xs text-muted-foreground" title={next.text}>
                    {live ? t('plan.working') : t('plan.next')}: {next.text}
                  </div>
                )}
              </div>
            </div>
            <div className="px-3 pt-3 pb-3">
              <Timeline steps={steps} live={live} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
