import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UiDraft, Widget } from '@/api/types';
import { clampHeight, readUiPayload, type UiPayload } from '@/lib/uiFrame';
import { InlineUi, UiFrame } from './InlineUi';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** What a draft can show so far, as a payload the frame understands. */
function draftPayload(draft: UiDraft): UiPayload {
  const f = draft.fields;
  return {
    title: str(f.title),
    initialHeight: clampHeight(f.initialHeight),
    placeholderMessages: Array.isArray(f.placeholderMessages)
      ? f.placeholderMessages.filter((m): m is string => typeof m === 'string')
      : [],
    css: str(f.css),
    html: str(f.html),
    js: '',
    jsInit: [],
    sources: [],
  };
}

/** An interactive answer at its place in the stream.
 *
 *  While the model writes it: the card with its title and the model's own
 *  placeholder lines, then — once markup arrives — a live preview of the
 *  markup (styles applied, no script). When the call has run, the finished UI
 *  mounts underneath and takes over only once it has drawn, so the hand-over
 *  is a swap rather than a blank frame. */
export function UiDraftView({ draft, widget }: { draft: UiDraft; widget?: Widget }) {
  const { t } = useTranslation();
  const ui = useMemo(() => draftPayload(draft), [draft]);
  const final = useMemo(() => (widget?.type === 'ui' ? readUiPayload(widget.data) : null), [widget]);
  const [finalReady, setFinalReady] = useState(false);

  return (
    <div className="relative my-5">
      {widget && final && (
        <div
          className={finalReady ? '' : 'pointer-events-none invisible absolute inset-x-0 top-0'}
          aria-hidden={!finalReady}
        >
          <InlineUi data={widget.data} version={widget.version} onReady={() => setFinalReady(true)} />
        </div>
      )}
      {!finalReady && (
        <div aria-busy="true" className="rounded-xl border-[0.5px] border-foreground/15 bg-card px-4 pt-2 pb-3 dark:border-foreground/12">
          <div className="mb-1 flex min-h-8 items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{ui.title}</span>
            <span className="shimmer-text text-[11px] text-muted-foreground">{t('interactive.building')}</span>
          </div>
          <UiFrame ui={ui} preview />
        </div>
      )}
    </div>
  );
}
