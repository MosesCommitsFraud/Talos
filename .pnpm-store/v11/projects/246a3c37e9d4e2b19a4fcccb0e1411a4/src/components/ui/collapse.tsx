import type { ReactNode } from 'react';

/** Height-animated disclosure body, shared by every "click to reveal" control in
 *  the message stream (the turn's Worked-for fold, tool groups, tool rows,
 *  reasoning).
 *
 *  Animating to `height: auto` is not possible in CSS, and measuring the content
 *  in JS goes stale the moment it reflows. The grid `0fr → 1fr` trick animates
 *  to whatever height the content actually wants, with no measurement at all.
 *
 *  The content stays MOUNTED while closed — that is what makes closing animate
 *  rather than snap — so any margin must live inside `children`, not on this
 *  wrapper, or it would show as a gap in the closed state. Closed content is
 *  also made `visibility: hidden` by the stylesheet so its buttons drop out of
 *  the tab order. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`collapse-grid${open ? ' is-open' : ''}`}>
      <div>{children}</div>
    </div>
  );
}
