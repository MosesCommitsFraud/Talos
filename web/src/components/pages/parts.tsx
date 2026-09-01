import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Shared chrome for the three sidebar pages (Projects / Artifacts /
 *  Customize): one centered column, a title row that keeps its actions on the
 *  right, and a scrolling body underneath. */
export function Page({
  title,
  actions,
  belowTitle,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  /** Row between the title and the content — tabs, filters. */
  belowTitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[1100px] px-8 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-strong">{title}</h1>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {belowTitle && <div className="mt-5">{belowTitle}</div>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

/** Responsive card grid — the Projects and Artifacts pages both lay out in it. */
export function CardGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}
      {...props}
    />
  );
}

/** Centered "nothing here yet" block with an optional call to action. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
      <span className="text-muted-foreground [&_svg]:size-6">{icon}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-[46ch] text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
