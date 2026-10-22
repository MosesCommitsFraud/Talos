import { memo, useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { Widget } from '@/api/types';
import { InlineUi, type UiFold } from '@/components/interactive/InlineUi';
import { builtinView } from '@/lib/builtinViews';

/** Props every widget component receives. `data` is `unknown` on purpose — it
 *  comes off the wire and out of persisted turns written by older backends, so
 *  each component narrows its own payload instead of trusting a declared type.
 *  `version` is the escape hatch for a payload shape that changed: branch on it
 *  rather than repurposing a field, so old turns keep rendering. */
export interface WidgetProps {
  data: unknown;
  version: number;
  /** The turn that produced the widget is over. */
  settled?: boolean;
}

/** A tool's own result view (weather, news, a result table) — rendered as an
 *  interactive UI like every render_ui answer: same frame, kit and card. The
 *  tool sends data; lib/builtinViews.ts supplies the view. */
function builtin(type: string): ComponentType<WidgetProps> {
  function BuiltinView({ data, version }: WidgetProps) {
    const { t } = useTranslation();
    const payload = useMemo(() => builtinView(type, data), [data]);
    // A query result starts folded to its title line, streaming or not: it sits
    // in the timeline between the reasoning and the calls, and a turn with a
    // few queries must not turn into a wall of result sets to scroll past. A
    // table shown as the answer stays open.
    const d = (data && typeof data === 'object' ? data : {}) as { answer?: unknown; rowCount?: unknown; rows?: unknown };
    let fold: UiFold | undefined;
    if (type === 'table' && d.answer !== true) {
      const shown = Array.isArray(d.rows) ? d.rows.length : 0;
      const total = typeof d.rowCount === 'number' ? d.rowCount : shown;
      fold = {
        open: false,
        meta: shown < total ? t('table.showingOf', { shown, total }) : t('table.rows', { count: total }),
        expandLabel: t('table.expand'),
        collapseLabel: t('table.collapse'),
      };
    }
    return payload ? <InlineUi data={payload} version={version} fold={fold} /> : null;
  }
  BuiltinView.displayName = `BuiltinView(${type})`;
  return BuiltinView;
}

/** Widget type -> component. The single place a new widget is hooked up on the
 *  frontend; the backend counterpart is `WIDGET_TYPES` in `src/widgets.py`.
 *  Everything renders as interactive UI. */
const WIDGET_REGISTRY: Record<string, ComponentType<WidgetProps>> = {
  weather: builtin('weather'),
  news: builtin('news'),
  table: builtin('table'),
  ui: InlineUi,
};

/** Render a tool result's widget, or nothing.
 *
 *  Nothing is a first-class outcome, not a failure: a backend that is ahead of
 *  the deployed bundle emits types this build has never heard of, and the right
 *  response is the ordinary tool row with its text output — not a crash, and not
 *  an error box for something the user never asked to see. That is also what
 *  makes shipping widgets one at a time safe.
 */
/** Memoised. A widget hangs in the transcript while the turn above it keeps
 *  streaming, and every delta re-renders the message list — so without this, a
 *  settled table's few thousand cells are reconciled tens of times per second
 *  for the rest of the turn, and the chat stops responding to input.
 *
 *  The comparison is safe because a settled tool call keeps its identity in the
 *  chat store: `patchAi` rebuilds only the call that is still running, so the
 *  `widget` object a finished call carries is the same object on every later
 *  render. */
export const WidgetView = memo(function WidgetView({
  widget,
  settled = false,
}: {
  widget: Widget | undefined;
  settled?: boolean;
}) {
  if (!widget) return null;
  const Component = WIDGET_REGISTRY[widget.type];
  if (!Component) return null;
  // The spacing lives here rather than in each card, for two reasons: every
  // widget then sits at the same distance from the prose around it whichever
  // one renders, and a new widget cannot forget to bring its own. A widget
  // interrupts a run of text, so it needs more air than a block inside the text
  // would — enough that the answer above and below reads as its own thought
  // rather than as a caption for the card. A folded result table is the
  // exception: it is one line of the work, spaced like the tool groups.
  return (
    <div className={staysInFold(widget) ? 'my-1.5' : 'my-5'}>
      <Component data={widget.data} version={widget.version} settled={settled} />
    </div>
  );
});

/** Widgets that belong to the work rather than to the answer. A result table
 *  is evidence the answer was drawn from — once the turn settles it folds away
 *  with the tool calls and reasoning, instead of being re-surfaced above the
 *  answer like a weather card, which IS the answer. */
export function staysInFold(widget: Widget | undefined): boolean {
  // A table the agent showed ON PURPOSE (render_widget) is the answer, not
  // evidence — it is marked `answer` and stays visible like any other card.
  const answer = !!widget && typeof widget.data === 'object' && widget.data !== null && (widget.data as { answer?: unknown }).answer === true;
  return widget?.type === 'table' && !answer;
}

export function hasWidget(widget: Widget | undefined): boolean {
  return !!widget && widget.type in WIDGET_REGISTRY;
}
