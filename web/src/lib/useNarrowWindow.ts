import { useEffect, useState } from 'react';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';

/** Below this width the window has no room for a sidebar column beside the
 *  content: the sidebar starts collapsed there. */
const NARROW_QUERY = '(max-width: 860px)';

/** Whether the window is too narrow for a sidebar column beside the content. */
export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** True while the sidebar is not taking a column: collapsed by the user, or
 *  collapsed because the window is narrow and it has not been opened there.
 *  Its expand button then floats over the top-left corner of the page, so
 *  whatever a page puts there (a title, a back button) has to leave it room. */
export function useSidebarAway(): boolean {
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const narrowOpen = useUi((s) => s.sidebarNarrowOpen);
  const narrow = useNarrowWindow();
  return narrow ? !narrowOpen : collapsed;
}
