import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { cn } from '@/lib/utils';
import { usePrefs } from '@/state/prefs';

export type { OrbState };

/** How long a state change takes to dissolve from one orb into the next. */
const MORPH_MS = 450;
/** How long the orb keeps going after the turn ends before reporting finished.
 *  The orb has no cycle to run out like the Lottie mark did, so the wind-down
 *  is a fixed beat of the calm `breathing` state instead. */
const SETTLE_MS = 1400;

/** The dotted orb shown while the agent is working — the replacement for the
 *  Lottie mark (still available as the legacy option in Settings → Appearance).
 *  Same contract as `WorkingAnimation`: `playing` going false lets it play on
 *  for a moment before `onFinished` fires, so the caller can dissolve it into
 *  the resting logo rather than cutting it off.
 *
 *  `state` follows what the turn is doing. A change never swaps the canvas in
 *  place: the old orb stays mounted and fades out while the new one fades in on
 *  top, so the hand-off reads as one orb changing its mind. */
export function WorkingOrb({
  className,
  state,
  playing = true,
  onFinished,
}: {
  className?: string;
  state: OrbState;
  playing?: boolean;
  onFinished?: () => void;
}) {
  const shown: OrbState = playing ? state : 'breathing';
  const theme = usePrefs((s) => s.theme);
  const orbTheme = theme === 'system' ? 'auto' : theme;

  // Newest last. Every layer but the last is on its way out.
  const [layers, setLayers] = useState<Array<{ key: number; state: OrbState }>>(() => [{ key: 0, state: shown }]);
  const nextKey = useRef(1);
  const [entered, setEntered] = useState(true);

  useEffect(() => {
    setLayers((prev) => {
      if (prev[prev.length - 1]?.state === shown) return prev;
      return [...prev, { key: nextKey.current++, state: shown }];
    });
  }, [shown]);

  // A freshly added layer mounts at opacity 0 and is flipped to 1 on the next
  // frame, so the CSS transition actually has a start value to run from.
  const topKey = layers[layers.length - 1].key;
  useEffect(() => {
    setEntered(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    const id = setTimeout(() => setLayers((prev) => prev.slice(-1)), MORPH_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(id);
    };
  }, [topKey]);

  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => finished.current?.(), SETTLE_MS);
    return () => clearTimeout(id);
  }, [playing]);

  return (
    <span aria-hidden className={cn('relative inline-block shrink-0', className)}>
      {layers.map((layer, i) => {
        const top = i === layers.length - 1;
        const visible = top && (entered || layers.length === 1);
        return (
          <ThinkingOrb
            key={layer.key}
            state={layer.state}
            size={20}
            theme={orbTheme}
            aria-hidden
            className="absolute inset-0 m-auto transition-[opacity,transform] ease-out"
            style={{
              width: '100%',
              height: '100%',
              transitionDuration: `${MORPH_MS}ms`,
              opacity: visible ? 1 : 0,
              transform: visible ? 'scale(1)' : top ? 'scale(0.7)' : 'scale(1.15)',
            }}
          />
        );
      })}
    </span>
  );
}
