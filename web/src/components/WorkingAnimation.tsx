import { useEffect, useRef } from 'react';
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light';
import { cn } from '@/lib/utils';
import animationUrl from '@/assets/working-animation.json?url';

/** The Lottie JSON is ~750 KB, so it is emitted as its own asset and fetched on
 *  first use instead of riding along in the main bundle. One in-flight promise
 *  is shared by every mount: the indicator appears and disappears constantly
 *  during a turn, and each remount would otherwise re-request the file. */
let dataPromise: Promise<unknown> | null = null;
function loadAnimationData(): Promise<unknown> {
  dataPromise ??= fetch(animationUrl).then((r) => {
    if (!r.ok) throw new Error(`animation ${r.status}`);
    return r.json();
  });
  return dataPromise;
}

/** The looping Talos mark shown while the agent is working — the moving half of
 *  the "Working for Xs" row. Purely decorative: the row itself carries the
 *  aria-label, so this is hidden from screen readers. */
export function WorkingAnimation({ className }: { className?: string }) {
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let anim: AnimationItem | null = null;
    let cancelled = false;
    loadAnimationData()
      .then((animationData) => {
        if (cancelled || !host.current) return;
        anim = lottie.loadAnimation({
          container: host.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData,
          rendererSettings: {
            // The export is a 1728x1049 scene: the mark sits in the middle and
            // an unrelated bar sits in the bottom-right corner. Cropping to the
            // mark's own (square) bounds drops the bar and stops the mark from
            // shrinking to a speck when the whole frame is fit into an icon-sized
            // box. Bounds are the union across all 360 frames, plus a little air.
            viewBoxSize: '554 214 620 620',
            preserveAspectRatio: 'xMidYMid meet',
            progressiveLoad: true,
          },
        });
      })
      .catch(() => {
        // A failed fetch just means no animation; the timer next to it still
        // tells the user the turn is alive.
      });
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, []);

  return <span ref={host} aria-hidden className={cn('inline-block shrink-0', className)} />;
}
