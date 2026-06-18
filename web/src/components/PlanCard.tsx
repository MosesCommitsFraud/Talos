import { useTranslation } from 'react-i18next';
import { CheckIcon, ListChecksIcon } from 'lucide-react';
import { type UiMessage } from '@/state/chat';
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

export function Checklist({ steps }: { steps: Step[] }) {
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

/** Inline live checklist from `update_plan` while an approved plan executes. The
 *  proposal/approval flow lives in the side PlanPanel, not here. */
export function PlanCard({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  const steps = parseChecklist(msg.plan ?? '');
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/[0.04]">
      <div className="flex items-center gap-2 border-b border-primary/15 px-3 py-2 text-xs font-medium text-muted-foreground">
        <ListChecksIcon className="size-3.5 text-primary" />
        <span className="ml-auto tabular-nums">{t('plan.progress', { done, total: steps.length })}</span>
      </div>
      <div className="p-3">
        <Checklist steps={steps} />
      </div>
    </div>
  );
}
