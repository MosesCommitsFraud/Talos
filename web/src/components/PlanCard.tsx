import { useTranslation } from 'react-i18next';
import type { UiMessage } from '@/state/chat';
import { cn } from '@/lib/utils';
import { StatusBadge, StatusDisc } from './TaskRow';

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

/** The turn's `update_plan` checklist under its reply, as task rows: one per
 *  step with its number, the step in work turning while the turn runs and
 *  each finished one ticked and marked done. Stays with the turn once it has
 *  settled (restored from the persisted tool event on reload). */
export function PlanCard({ msg, live }: { msg: UiMessage; live: boolean }) {
  const { t } = useTranslation();
  const steps = parseChecklist(msg.plan ?? '');
  if (steps.length === 0) return null;
  const states = stepStates(steps, live);
  const done = steps.filter((s) => s.done).length;

  return (
    <div
      className="mt-3 mb-6 overflow-hidden rounded-xl border bg-card/40"
      aria-label={`${t('plan.title')} · ${t('plan.progress', { done, total: steps.length })}`}
    >
      <ol>
        {steps.map((step, i) => {
          const state = states[i];
          return (
            <li
              key={i}
              // Rows rise in one after the other while the plan is being
              // written; a settled or reopened plan is simply there.
              className={cn('flex min-h-10 items-center gap-2.5 border-b border-border/70 py-1.5 pr-3 pl-2.5 last:border-0', live && 'fade-up')}
              style={live ? { animationDelay: `${Math.min(i, 8) * 60}ms` } : undefined}
            >
              <StatusDisc state={state === 'current' ? 'running' : state} count={i + 1} animate={live} />
              <span
                className={cn(
                  'min-w-0 flex-1 text-[13px] leading-snug font-medium break-words',
                  state === 'done' && 'text-muted-foreground',
                  state === 'current' && 'text-strong',
                  state === 'ahead' && 'text-foreground/80',
                )}
              >
                {step.text}
              </span>
              {state === 'done' && <StatusBadge state="done">{t('tasks.state.done')}</StatusBadge>}
              {state === 'current' && <StatusBadge state="running">{t('tasks.state.running')}</StatusBadge>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
