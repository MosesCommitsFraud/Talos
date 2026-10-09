import { useTranslation } from 'react-i18next';
import { CheckIcon, ListChecksIcon, PanelRightIcon, XIcon } from 'lucide-react';
import { useUi } from '@/state/ui';
import { type UiMessage, useChat } from '@/state/chat';
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

/** Inline live checklist from `update_plan`. While the plan pane is open the
 *  plan lives there (see PlanPane) and the chat keeps no second copy; with
 *  the pane closed it shows here, with a way back into the pane. */
export function PlanCard({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  const paneOpen = useUi((s) => s.planPanelOpen);
  const openPane = useUi((s) => s.setPlanPanelOpen);
  const steps = parseChecklist(msg.plan ?? '');
  if (steps.length === 0 || paneOpen) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="mt-3 rounded-md border border-primary/30 bg-primary/[0.04]">
      <div className="flex items-center gap-2 border-b border-primary/15 px-3 py-2 text-xs font-medium text-muted-foreground">
        <ListChecksIcon className="size-3.5 text-primary" />
        <span className="tabular-nums">{t('plan.progress', { done, total: steps.length })}</span>
        <button
          type="button"
          title={t('plan.openInPanel')}
          aria-label={t('plan.openInPanel')}
          onClick={() => openPane(true)}
          className="ml-auto flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightIcon className="size-3.5" />
        </button>
      </div>
      <div className="p-3">
        <Checklist steps={steps} />
      </div>
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

/** The plan as a pane of the right dock: progress bar over the checklist. */
export function PlanPane({ className }: { className?: string }) {
  const { t } = useTranslation();
  const close = useUi((s) => s.setPlanPanelOpen);
  const steps = parseChecklist(useSessionPlan() ?? '');
  const done = steps.filter((s) => s.done).length;
  return (
    <section className={className} aria-label={t('plan.title')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('plan.title')}</span>
        {steps.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t('plan.progress', { done, total: steps.length })}
          </span>
        )}
        <button
          type="button"
          aria-label={t('plan.closePanel')}
          onClick={() => close(false)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4">
        {steps.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('plan.empty')}</p>
        ) : (
          <>
            <span aria-hidden className="mb-3 block h-1 w-full overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${(done / steps.length) * 100}%` }}
              />
            </span>
            <Checklist steps={steps} />
          </>
        )}
      </div>
    </section>
  );
}
