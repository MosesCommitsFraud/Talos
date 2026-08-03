import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { describeCall, groupDiffStat, summarizeCalls } from '@/lib/toolLabels';
import { DiffStatBadge, ToolRow } from './ToolRow';

/** Every tool call the agent made between two pieces of assistant text, behind
 *  one line.
 *
 *  While the group runs the line tracks what is happening RIGHT NOW ("Running a
 *  command" → "Querying SQL"), shimmering like the sidebar's working label and
 *  rolling the text up as it changes. Once the group settles it turns into a
 *  past-tense recap of the whole batch ("Ran 2 commands, queried SQL twice").
 *  Clicking opens the list; each row opens further into command/output/diff.
 *
 *  A group of exactly one call skips the wrapper: the header IS the row, so a
 *  single lookup doesn't cost two clicks to read. */
export function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  // Several calls can be in flight at once (the loop runs tool blocks in
  // parallel), so the header follows the most recently started running one.
  const active = [...calls].reverse().find((c) => c.status === 'running');
  const stat = groupDiffStat(calls);
  const label = active
    ? describeCall(active, t, 'running')
    // Joining clauses lower-cased is an English convention; German clauses open
    // with a noun that keeps its capital.
    : summarizeCalls(calls, t, i18n.language.startsWith('en'));

  if (calls.length === 1) {
    return (
      <div className="my-1 -mx-3">
        <ToolRow call={calls[0]} />
      </div>
    );
  }

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t('toolGroup.hide') : t('toolGroup.show')}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* Clipped so the outgoing label slides out of view rather than
            overlapping the incoming one. */}
        <span className="block overflow-hidden">
          {/* Keyed on the label so React remounts the span and replays the roll
              animation every time the current action changes. The shimmer sits
              on a CHILD: both are `animation` shorthands, so sharing one element
              would let the roll silently cancel the sweep. */}
          <span key={label} className="tool-label-roll block">
            <span className={`block truncate ${active ? 'shimmer-text' : ''}`}>{label}</span>
          </span>
        </span>
        {stat && <DiffStatBadge added={stat.added} removed={stat.removed} />}
        <ChevronDownIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 divide-y divide-border/60 overflow-hidden rounded-lg border">
          {calls.map((call, i) => (
            <ToolRow key={i} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}
