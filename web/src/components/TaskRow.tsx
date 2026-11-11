import { cn } from '@/lib/utils';

/** Where a piece of work stands. `ahead` is a step that has not started. */
export type TaskState = 'running' | 'done' | 'failed' | 'stopped' | 'ahead';

/** The mark at the head of a task row, in a 24px box whatever the state, so a
 *  row does not shift when its state changes:
 *
 *  a ring that turns while the work runs, a filled disc once it is over (check,
 *  cross, square for stopped), a dashed ring for what is still ahead. All of it
 *  in the greys of the text around it: a plan is a list to read down, and a
 *  column of green discs shouts over the answer it belongs to. Only a failure
 *  keeps its red. The rings can carry a number — the step's position in a plan, or how
 *  many steps a task has taken so far.
 *
 *  `animate` lets the settled disc pop in; leave it off for rows that are drawn
 *  already settled (a reopened chat), where nothing has just happened. */
export function StatusDisc({ state, count, animate = false }: { state: TaskState; count?: number; animate?: boolean }) {
  if (state === 'running' || state === 'ahead') {
    return (
      <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
        <svg viewBox="0 0 24 24" aria-hidden className={cn('absolute inset-0 size-full', state === 'running' && 'animate-spin [animation-duration:1.1s]')}>
          {state === 'running' ? (
            <>
              <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" className="stroke-foreground/12" />
              <path d="M12 2a10 10 0 0 1 10 10" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-foreground/75" />
            </>
          ) : (
            <circle cx="12" cy="12" r="10" fill="none" strokeWidth="1.5" strokeDasharray="3 3" className="stroke-muted-foreground/55" />
          )}
        </svg>
        {count != null && (
          <span className={cn('relative text-[10.5px] font-semibold tabular-nums', state === 'running' ? 'text-strong' : 'text-muted-foreground')}>
            {count}
          </span>
        )}
      </span>
    );
  }
  // Disc and mark in ONE svg: as a span with an icon nested in it, the two boxes
  // snap to different fractional pixels (odd sizes, 125% display scaling) and
  // the mark drifts off-centre. Drawn together they always rasterise as one.
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-6 shrink-0', animate && 'pop-in')}>
      <circle
        cx="12"
        cy="12"
        r="11"
        className={cn(
          state === 'done' && 'fill-muted-foreground/70',
          state === 'failed' && 'fill-destructive-foreground/85',
          state === 'stopped' && 'fill-muted-foreground/45',
        )}
      />
      {state === 'done' && (
        <path d="M7.5 12.2 10.6 15.3 16.5 8.8" fill="none" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className="stroke-background" />
      )}
      {state === 'failed' && (
        <path d="M8.4 8.4 15.6 15.6M15.6 8.4 8.4 15.6" fill="none" strokeWidth="2.3" strokeLinecap="round" className="stroke-background" />
      )}
      {state === 'stopped' && <rect x="8.25" y="8.25" width="7.5" height="7.5" rx="1.75" className="fill-background" />}
    </svg>
  );
}

const BADGE_TONE: Record<Exclude<TaskState, 'ahead'>, string> = {
  running: 'bg-foreground/[0.07] text-foreground',
  done: 'bg-foreground/[0.05] text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive-foreground',
  stopped: 'bg-foreground/[0.05] text-muted-foreground',
};

/** The state spelled out, as a small grey pill at the end of a task row. */
export function StatusBadge({ state, children, className }: { state: Exclude<TaskState, 'ahead'>; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap', BADGE_TONE[state], className)}>
      {children}
    </span>
  );
}
