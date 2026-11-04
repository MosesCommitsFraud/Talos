import { useTranslation } from 'react-i18next';
import { LoaderCircleIcon } from 'lucide-react';
import type { UiMessage } from '@/state/chat';
import { cn } from '@/lib/utils';

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
 *  settled (restored from the persisted tool event on reload). */
export function PlanCard({ msg, live }: { msg: UiMessage; live: boolean }) {
  const { t } = useTranslation();
  const steps = parseChecklist(msg.plan ?? '');
  if (steps.length === 0) return null;
  const states = stepStates(steps, live);
  const done = steps.filter((s) => s.done).length;

  return (
    <div
      className="mt-3 mb-6 rounded-xl border bg-card/40 px-4 py-3"
      aria-label={`${t('plan.title')} · ${t('plan.progress', { done, total: steps.length })}`}
    >
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
