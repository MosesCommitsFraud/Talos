import type { ComponentType } from 'react';
import type { Widget } from '@/api/types';
import { NewsWidget } from './NewsWidget';
import { TableWidget } from './TableWidget';
import { WeatherWidget } from './WeatherWidget';

/** Props every widget component receives. `data` is `unknown` on purpose — it
 *  comes off the wire and out of persisted turns written by older backends, so
 *  each component narrows its own payload instead of trusting a declared type.
 *  `version` is the escape hatch for a payload shape that changed: branch on it
 *  rather than repurposing a field, so old turns keep rendering. */
export interface WidgetProps {
  data: unknown;
  version: number;
}

/** Widget type -> component. The single place a new widget is hooked up on the
 *  frontend; the backend counterpart is `WIDGET_TYPES` in `src/widgets.py`. */
const WIDGET_REGISTRY: Record<string, ComponentType<WidgetProps>> = {
  weather: WeatherWidget,
  news: NewsWidget,
  table: TableWidget,
};

/** Render a tool result's widget, or nothing.
 *
 *  Nothing is a first-class outcome, not a failure: a backend that is ahead of
 *  the deployed bundle emits types this build has never heard of, and the right
 *  response is the ordinary tool row with its text output — not a crash, and not
 *  an error box for something the user never asked to see. That is also what
 *  makes shipping widgets one at a time safe.
 */
export function WidgetView({ widget }: { widget: Widget | undefined }) {
  if (!widget) return null;
  const Component = WIDGET_REGISTRY[widget.type];
  if (!Component) return null;
  // The spacing lives here rather than in each card, for two reasons: every
  // widget then sits at the same distance from the prose around it whichever
  // one renders, and a new widget cannot forget to bring its own. A widget
  // interrupts a run of text, so it needs more air than a block inside the text
  // would — enough that the answer above and below reads as its own thought
  // rather than as a caption for the card.
  return (
    <div className="my-5">
      <Component data={widget.data} version={widget.version} />
    </div>
  );
}

export function hasWidget(widget: Widget | undefined): boolean {
  return !!widget && widget.type in WIDGET_REGISTRY;
}
