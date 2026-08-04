import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { describeCall, groupDiffStat, joinClauses, partsToString, summarizeCalls } from '@/lib/toolLabels';
import { Thinking } from './Thinking';
import { ToolLabel } from './ToolLabel';
import { DiffStatBadge, ToolRow } from './ToolRow';
import { Collapse } from './ui/collapse';

/** One item on a group's timeline. Reasoning sits on the same track as the
 *  calls, because to the reader it is the same thing — a step the agent took
 *  between two pieces of text — and giving it its own block left an awkward gap
 *  between the two. */
export type GroupEntry =
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | { kind: 'call'; call: ToolCall };

/** Everything the agent did between two pieces of assistant text, behind one
 *  line: reasoning and tool calls alike.
 *
 *  While the group runs the line tracks what is happening RIGHT NOW ("Thinking…"
 *  → "Running a command" → "Querying SQL"), shimmering like the sidebar's
 *  working label and rolling the text up as it changes. Once the group settles
 *  it turns into a past-tense recap of the batch ("Ran 2 commands, queried SQL
 *  twice"). Clicking opens the list; each row opens further into its
 *  command/output/diff, or the full reasoning.
 *
 *  A group of exactly one entry skips the wrapper: the header IS the row, so a
 *  single lookup doesn't cost two clicks to read. */
export function ToolGroup({ entries }: { entries: GroupEntry[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const calls = entries.flatMap((e) => (e.kind === 'call' ? [e.call] : []));
  const thoughts = entries.flatMap((e) => (e.kind === 'thinking' ? [e] : []));
  // Several calls can be in flight at once (the loop runs tool blocks in
  // parallel), so the header follows the most recently started one. Live
  // reasoning outranks them: it is what the agent is doing at this instant.
  const thinkingNow = thoughts.some((e) => e.streaming);
  const active = [...calls].reverse().find((c) => c.status === 'running');
  const stat = groupDiffStat(calls);
  // A settled summary names only what the agent DID — reasoning is a means, not
  // an outcome, and "Thought, ran a command" spent the most prominent slot on
  // the least informative word. Live thinking still takes the header (below),
  // and a group that is nothing but reasoning renders as a plain Thinking block.
  const clauses =
    thinkingNow || active
      ? []
      : // Lower-casing the joins is an English convention; German clauses open
        // with a noun that keeps its capital.
        joinClauses(summarizeCalls(calls, t), i18n.language.startsWith('en'));
  const live = !thinkingNow && active ? describeCall(active, t, 'running') : null;
  const running = thinkingNow || !!active;
  // Drives the roll animation: remounting on text change is what replays it.
  const labelText = thinkingNow
    ? t('thinking.thinking')
    : live
      ? partsToString(live)
      : clauses.map((c) => partsToString(c.segments)).join(', ');

  // Nothing but reasoning: there is no summary to write ("Thought" alone says
  // nothing), so it renders as the plain Thinking disclosure it would be on its
  // own — which is also the only place a reader can still reach that text.
  if (calls.length === 0) {
    return (
      <div className="my-1">
        {thoughts.map((entry, i) => (
          <Thinking key={i} text={entry.text} streaming={entry.streaming} />
        ))}
      </div>
    );
  }

  if (entries.length === 1) {
    const only = entries[0];
    return (
      <div className={only.kind === 'call' ? 'my-1 -mx-3' : 'my-1'}>
        {only.kind === 'call' ? (
          <ToolRow call={only.call} />
        ) : (
          <Thinking text={only.text} streaming={only.streaming} />
        )}
      </div>
    );
  }

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
              {thinkingNow || live ? (
                live ? (
                  <ToolLabel parts={live} />
                ) : (
                  labelText
                )
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
      {/* Reasoning sits ABOVE the list of calls and reads as plain prose: the
          group's own chevron already opened it, so wrapping it in a second
          disclosure would make the same text cost two clicks. The bordered list
          stays for the calls only. */}
      <Collapse open={open}>
        <div className="mt-1.5 space-y-1.5">
          {thoughts.map((entry, i) => (
            <div
              key={`t${i}`}
              className="whitespace-pre-wrap text-[15px] leading-relaxed text-muted-foreground"
            >
              {entry.text}
            </div>
          ))}
          {calls.length > 0 && (
            <div className="divide-y divide-foreground/12 overflow-hidden rounded-lg border border-foreground/14 dark:divide-border/60 dark:border-border">
              {calls.map((call, i) => (
                <ToolRow key={i} call={call} />
              ))}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
