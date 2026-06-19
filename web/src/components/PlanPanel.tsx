import { useTranslation } from 'react-i18next';
import { DownloadIcon, ListChecksIcon, XIcon } from 'lucide-react';
import { selectActivePlan, useChat } from '@/state/chat';
import { useUi } from '@/state/ui';
import { Markdown, downloadBlob } from './Markdown';
import { Checklist, parseChecklist } from './PlanCard';

/** Right-side drawer that holds a proposed plan (Context / Approach / Plan /
 *  Verification), opening like the artifacts panel. Read-only — accept/cancel
 *  live on the composer's approval bar. While the plan executes, the live
 *  `update_plan` checklist is shown as progress beneath it. */
export function PlanPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.planPanelOpen);
  const setOpen = useUi((s) => s.setPlanPanelOpen);
  const plan = useChat(selectActivePlan);
  const progressMsg = useChat((s) => [...s.messages].reverse().find((m) => m.plan));

  if (!open || !plan) return null;
  const progressSteps = progressMsg?.plan ? parseChecklist(progressMsg.plan) : [];
  const done = progressSteps.filter((s) => s.done).length;

  return (
    <aside className="flex w-[26rem] max-w-[40vw] shrink-0 flex-col border-l bg-card" aria-label={t('plan.panelLabel')}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ListChecksIcon className="size-4 text-primary" />
          {t('plan.proposed')}
          {plan.answered && <span className="text-xs font-normal text-muted-foreground">· {t('plan.answered')}</span>}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('plan.downloadMd')}
            title={t('plan.downloadMd')}
            onClick={() =>
              downloadBlob(plan.content, `plan-${new Date().toISOString().slice(0, 10)}.md`, 'text/markdown;charset=utf-8')
            }
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <DownloadIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t('plan.closePanel')}
            onClick={() => setOpen(false)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Markdown text={plan.content} />
        {progressSteps.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <div className="mb-2 text-xs font-medium tabular-nums text-muted-foreground">
              {t('plan.progress', { done, total: progressSteps.length })}
            </div>
            <Checklist steps={progressSteps} />
          </div>
        )}
      </div>
    </aside>
  );
}
