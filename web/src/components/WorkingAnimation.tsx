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
 *  aria-label, so this is hidden from screen readers.
 *
 *  `playing` going false does not freeze the mark where it stands: it only turns
 *  looping off, so the cycle in flight runs out to its end frame and `onFinished`
 *  fires there. The caller keeps the row mounted until then — a loop cut off
 *  mid-swing reads as the UI breaking rather than as the turn finishing. */
export function WorkingAnimation({
  className,
  playing = true,
  onFinished,
}: {
  className?: string;
  playing?: boolean;
  onFinished?: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const anim = useRef<AnimationItem | null>(null);
  // Both props are read through refs inside the mount effect so that it never
  // re-runs — re-running would tear down and rebuild the player mid-cycle.
  const playingRef = useRef(playing);
  const finished = useRef(onFinished);
  playingRef.current = playing;
  finished.current = onFinished;

  useEffect(() => {
    let cancelled = false;
    loadAnimationData()
      .then((animationData) => {
        if (cancelled || !host.current) return;
        const player = lottie.loadAnimation({
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
        // With looping on, lottie fires 'loopComplete' at the end frame and
        // 'complete' never comes — so this only lands once the wind-down below
        // has turned looping off, at exactly the end of the cycle in flight.
        player.addEventListener('complete', () => finished.current?.());
        anim.current = player;
        // A short turn can end before the JSON lands; honour that immediately.
        if (!playingRef.current) player.setLoop(false);
      })
      .catch(() => {
        // A failed fetch just means no animation. Report it finished so the
        // caller doesn't hold an empty row open waiting for a cycle that will
        // never come; the timer beside it still says the turn is alive.
        if (!cancelled) finished.current?.();
      });
    return () => {
      cancelled = true;
      anim.current?.destroy();
      anim.current = null;
    };
  }, []);

  useEffect(() => {
    const player = anim.current;
    if (!player) return;
    player.setLoop(playing);
    // Resuming matters when a new turn starts in the same row before the
    // previous wind-down reached its end frame — 'complete' leaves the player
    // paused on the last frame, so it needs sending back to the top.
    if (playing && player.isPaused) player.goToAndPlay(0, true);
  }, [playing]);

  return <span ref={host} aria-hidden className={cn('inline-block shrink-0', className)} />;
}
