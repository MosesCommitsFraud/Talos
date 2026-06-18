import { useTranslation } from 'react-i18next';
import { CheckIcon, ListChecksIcon, PlayIcon } from 'lucide-react';
import { useChat, type UiMessage } from '@/state/chat';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface Step {
  text: string;
  done: boolean;
}

/** Pull GitHub-style checklist lines (`- [ ]` / `- [x]`) out of markdown. */
function parseChecklist(markdown: string): Step[] {
  const steps: Step[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (m) steps.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() });
  }
  return steps;
}

function Checklist({ steps }: { steps: Step[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span
            className={cn(
              'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
              step.done ? 'border-success bg-success/15 text-success' : 'border-input',
            )}
          >
            {step.done && <CheckIcon className="size-3" />}
          </span>
          <span className={cn(step.done && 'text-muted-foreground line-through')}>{step.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Renders a plan as a card. Two modes:
 *  - `variant="progress"`: a live checklist from `update_plan` (read-only).
 *  - `variant="approval"`: a plan-mode proposal with Implement / Revise buttons.
 *    Implement re-sends the checklist via the `approved_plan` flow so the next
 *    turn executes it (plan mode forced off). */
export function PlanCard({ msg, variant }: { msg: UiMessage; variant: 'progress' | 'approval' }) {
  const { t } = useTranslation();
  const send = useChat((s) => s.send);
  const streaming = useChat((s) => s.streaming);

  // Progress uses the update_plan text; approval uses the proposed plan in the
  // turn's own content.
  const source = variant === 'progress' ? msg.plan ?? '' : msg.content;
  const steps = parseChecklist(source);
  if (variant === 'progress' && steps.length === 0) return null;

  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  const acted = !!msg.answered;
  const disabled = acted || streaming;

  const implement = () => {
    if (disabled) return;
    void send(t('plan.implementing'), { approvedPlan: source.trim(), planMode: false });
  };

  const revise = () => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-composer-input]');
    el?.focus();
  };

  return (
    <div className={cn('mt-3 rounded-xl border border-primary/30 bg-primary/[0.04] p-3', acted && 'opacity-60')}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ListChecksIcon className="size-3.5" />
        <span>{variant === 'approval' ? t('plan.proposed') : t('plan.progress', { done, total })}</span>
        {variant === 'approval' && total > 0 && (
          <span className="ml-auto tabular-nums">{t('plan.progress', { done, total })}</span>
        )}
      </div>

      {/* The approval variant's checklist is already rendered as markdown in the
          turn's answer above, so only the progress variant lists steps here. */}
      {variant === 'progress' && steps.length > 0 && <Checklist steps={steps} />}

      {variant === 'approval' && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={revise}>
            {t('plan.revise')}
          </Button>
          <Button size="sm" disabled={disabled} onClick={implement}>
            <PlayIcon /> {t('plan.implement')}
          </Button>
        </div>
      )}
    </div>
  );
}
