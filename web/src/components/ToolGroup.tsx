import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { describeCall, groupDiffStat, joinClauses, partsToString, summarizeCalls } from '@/lib/toolLabels';
import { ToolLabel } from './ToolLabel';
import { DiffStatBadge, ToolRow } from './ToolRow';
import { Collapse } from './ui/collapse';
import { WidgetView } from './widgets/registry';

/** One item on a group's timeline. Only tool calls: the model's reasoning is
 *  shown beside the working timer instead of on this track. */
export type GroupEntry = { kind: 'call'; call: ToolCall };

/** Everything the agent did between two pieces of assistant text, behind one
 *  line.
 *
 *  While the group runs the line tracks what is happening RIGHT NOW ("Running a
 *  command" → "Querying SQL"), shimmering like the sidebar's working label and
 *  rolling the text up as it changes. Once the group settles it turns into a
 *  past-tense recap of the batch ("Ran 2 commands, queried SQL twice"). Clicking
 *  opens the list; each row opens further into its command/output/diff.
 *
 *  A single-call group keeps the same two levels rather than promoting its row
 *  to the header: the header is the recap ("Queried SQL"), the row inside it the
 *  detailed reading ("Queried SQL: list tables").
 *
 *  Widgets are the exception to the fold: a weather card is the answer, not a
 *  log line, so it sits under the header where it needs no click. `showWidgets`
 *  turns that off for the one caller that re-surfaces them itself — a settled
 *  turn shows the cards under the answer, and drawing them again inside the
 *  reopened fold would show the same card twice on one screen. */
export function ToolGroup({ entries, showWidgets = true }: { entries: GroupEntry[]; showWidgets?: boolean }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const calls = entries.map((e) => e.call);
  // Several calls can be in flight at once (the loop runs tool blocks in
  // parallel), so the header follows the most recently started one.
  const active = [...calls].reverse().find((c) => c.status === 'running');
  const stat = groupDiffStat(calls);
  const clauses = active
    ? []
    : // Lower-casing the joins is an English convention; German clauses open
      // with a noun that keeps its capital.
      joinClauses(summarizeCalls(calls, t), i18n.language.startsWith('en'));
  const live = active ? describeCall(active, t, 'running') : null;
  const running = !!active;
  // Drives the roll animation: remounting on text change is what replays it.
  const labelText = live ? partsToString(live) : clauses.map((c) => partsToString(c.segments)).join(', ');

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${labelText} — ${open ? t('toolGroup.hide') : t('toolGroup.show')}`}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* Clipped so the outgoing label slides out of view rather than
            overlapping the incoming one. */}
        <span className="block overflow-hidden">
          {/* Keyed on the label so React remounts the span and replays the roll
              animation every time the current action changes. The shimmer sits
              on a CHILD: both are `animation` shorthands, so sharing one element
              would let the roll silently cancel the sweep. */}
          <span key={labelText} className="tool-label-roll block">
            <span className={`block truncate ${running ? 'shimmer-text' : ''}`}>
              {live ? (
                <ToolLabel parts={live} />
              ) : (
                clauses.map((clause, i) => (
                  <span key={i}>
                    {i > 0 && ', '}
                    <ToolLabel parts={clause.segments} failed={clause.failed} />
                  </span>
                ))
              )}
            </span>
          </span>
        </span>
        {stat && <DiffStatBadge added={stat.added} removed={stat.removed} />}
        <ChevronDownIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="mt-1.5">
          <div className="divide-y divide-foreground/12 overflow-hidden rounded-lg border border-foreground/14 dark:divide-border/60 dark:border-border">
            {calls.map((call, i) => (
              <ToolRow key={i} call={call} />
            ))}
          </div>
        </div>
      </Collapse>
      {showWidgets &&
        calls.map((call, i) => call.widget && <WidgetView key={`w-${i}`} widget={call.widget} />)}
    </div>
  );
}
