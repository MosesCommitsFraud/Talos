import { ChevronDownIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** How the header hands one label over to the next, in milliseconds. The old
 *  text fades out, the chevron then slides to where the new text ends, and only
 *  once it has arrived does the new text fade in — three beats rather than one
 *  crossfade, so the eye follows the arrow instead of the swap. */
const FADE_OUT_MS = 130;
const SHIFT_MS = 220;
const FADE_IN_MS = 170;

/** Everything the agent did between two pieces of assistant text, behind one
 *  line.
 *
 *  While the group runs the line tracks what is happening RIGHT NOW ("Running a
 *  command" → "Querying SQL"), shimmering like the sidebar's working label and
 *  handing the text over as it changes. Once the group settles it turns into a
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
  const hasEntries = entries.length > 0;

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
  // Identity of the current label: the handover animation runs whenever it
  // changes, and the width measurer is what the arrow chases.
  const labelText = live ? partsToString(live) : clauses.map((c) => partsToString(c.segments)).join(', ');

  const label = live ? (
    <ToolLabel parts={live} />
  ) : (
    <>
      {clauses.map((clause, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <ToolLabel parts={clause.segments} failed={clause.failed} />
        </span>
      ))}
    </>
  );

  const { wrapRef, extrasRef, measureRef, shown, width, visible, animating } = useLabelHandover(labelText, label);

  if (!hasEntries) return null;

  return (
    <div className="my-1" ref={wrapRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${labelText} — ${open ? t('toolGroup.hide') : t('toolGroup.show')}`}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* The label sits in a box whose width is animated to the width of the
            incoming text. Everything after it — badge and chevron — is pushed
            along by that transition, which is what makes the arrow travel to
            its new spot instead of jumping. */}
        <span
          className="relative block overflow-hidden"
          style={{
            width: width ?? undefined,
            transition: animating ? `width ${SHIFT_MS}ms cubic-bezier(0.2, 0, 0, 1)` : undefined,
          }}
        >
          {/* Hidden twin, always holding the LATEST label: measuring it is how
              we know where the arrow has to end up before the new text is
              visible. */}
          <span
            ref={measureRef}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
          >
            {label}
          </span>
          <span
            className={`block truncate ${running ? 'shimmer-text' : ''}`}
            style={{
              opacity: visible ? 1 : 0,
              transition: `opacity ${visible ? FADE_IN_MS : FADE_OUT_MS}ms linear`,
            }}
          >
            {shown}
          </span>
        </span>
        <span ref={extrasRef} className="flex shrink-0 items-center gap-1.5">
          {stat && <DiffStatBadge added={stat.added} removed={stat.removed} />}
          <ChevronDownIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
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

/** Drives the three-beat handover between two header labels.
 *
 *  `shown` lags `label` on purpose: the old text stays mounted while it fades,
 *  is replaced the moment the width starts travelling, and is only revealed
 *  once the arrow has settled. Width comes from the hidden twin, clamped to the
 *  space left over beside the badge and chevron so a long recap still truncates
 *  rather than pushing the arrow off the line.
 *
 *  Reduced motion gets the swap with no beats at all. */
function useLabelHandover(key: string, label: ReactNode) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const extrasRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  // The incoming label as of this render, read from inside timeouts.
  const latest = useRef<ReactNode>(label);
  latest.current = label;

  const [shown, setShown] = useState<{ key: string; node: ReactNode }>({ key, node: label });
  const [width, setWidth] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [animating, setAnimating] = useState(false);

  const measure = useCallback(() => {
    const twin = measureRef.current;
    const wrap = wrapRef.current;
    if (!twin || !wrap) return null;
    const natural = Math.ceil(twin.scrollWidth);
    // 6px is the button's gap between the label box and the badge/chevron.
    // A zero container means we are measuring while the group is off-screen or
    // hidden; clamping to that would pin the label shut, so take the natural
    // width and let the next resize correct it.
    const avail = wrap.clientWidth - (extrasRef.current?.offsetWidth ?? 0) - 6;
    return avail > 0 ? Math.min(natural, avail) : natural;
  }, []);

  // First paint and container resizes: take the width straight, no travel.
  useLayoutEffect(() => {
    setWidth(measure());
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(measure()));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    if (key === shown.key) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setShown({ key, node: latest.current });
      setWidth(measure());
      return;
    }
    setVisible(false); // beat 1: the old label fades out
    const timers = [
      window.setTimeout(() => {
        // beat 2: swap the text while it is invisible and let the box — and so
        // the arrow — travel to the new width.
        setShown({ key, node: latest.current });
        setAnimating(true);
        setWidth(measure());
        timers.push(
          window.setTimeout(() => {
            setAnimating(false);
            setVisible(true); // beat 3: the new label fades in
          }, SHIFT_MS),
        );
      }, FADE_OUT_MS),
    ];
    return () => timers.forEach(window.clearTimeout);
    // `shown.key` is the comparison target, not a trigger; re-running on it
    // would restart the sequence half-way through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, measure]);

  return { wrapRef, extrasRef, measureRef, shown: shown.node, width, visible, animating };
}
