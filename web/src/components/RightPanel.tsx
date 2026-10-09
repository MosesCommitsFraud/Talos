import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react';
import { downloadPreviewFile } from '@/api/client';
import { displayName, fileTypeLabel } from '@/lib/files';
import { useBgTasks } from '@/lib/useBgTasks';
import { useChat } from '@/state/chat';
import { type DockPane, type DockSizes, usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from './FileTypeIcon';
import { AgentsIcon, PlanIcon } from './icons';
import { PlanPane, useSessionPlan } from './PlanCard';
import { PreviewContent } from './PreviewPanel';
import { SessionFilesPopover } from './SessionFilesPopover';
import { TasksPane } from './TasksPanel';
import { Tooltip } from './ui/misc';

const MIN_WIDTH = 320;
/** Cap the dock at most of the viewport so the chat never fully disappears. */
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));
const clampWidth = (px: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, px));

/** Shared drag plumbing: cursor + no text selection for the whole drag,
 *  live callback on move, commit on release. */
function startDrag(
  e: React.PointerEvent,
  cursor: string,
  onMove: (ev: PointerEvent) => void,
  onUp: (ev: PointerEvent) => void,
) {
  e.preventDefault();
  const move = (ev: PointerEvent) => onMove(ev);
  const up = (ev: PointerEvent) => {
    onUp(ev);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const iconBtn = 'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const paneChrome = 'flex min-h-0 flex-col overflow-hidden rounded-md border bg-background shadow-lg';

/** The file preview as a pane: header (name, download, full screen, close)
 *  over the content. Sizing is the dock's business. */
function PreviewPane({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const { t } = useTranslation();
  const setOpen = useUi((s) => s.setArtifactsOpen);
  const preview = useUi((s) => s.preview);
  const fullscreen = useUi((s) => s.previewFullscreen);
  const setFullscreen = useUi((s) => s.setPreviewFullscreen);
  if (!preview) return null;
  return (
    <section className={cn(paneChrome, className)} style={style} aria-label={t('preview.panelLabel')}>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pl-3 pr-2">
        <div className="flex min-w-0 items-center gap-2" title={preview.name}>
          <FileTypeIcon path={preview.name} mime={preview.mime} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{displayName(preview.name)}</span>
          <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground">{fileTypeLabel(preview.name, preview.mime)}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!preview.streaming && (
            <Tooltip label={t('preview.download')}>
              <button
                type="button"
                onClick={() => { void downloadPreviewFile(preview); }}
                aria-label={t('preview.download')}
                className={iconBtn}
              >
                <DownloadIcon className="size-4" />
              </button>
            </Tooltip>
          )}
          <Tooltip label={fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}>
            <button
              type="button"
              onClick={() => setFullscreen(!fullscreen)}
              aria-label={fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
              aria-pressed={fullscreen}
              className={iconBtn}
            >
              {fullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
            </button>
          </Tooltip>
          <button
            type="button"
            aria-label={t('preview.close')}
            onClick={() => setOpen(false)}
            className={iconBtn}
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      <PreviewContent preview={preview} />
    </section>
  );
}

/** A drag strip with a pill that shows on hover — the "grab here" line of
 *  the dock's left edge and of the split between its panes. */
function Grip({
  orientation,
  label,
  onPointerDown,
  className,
}: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  onPointerDown: (e: React.PointerEvent) => void;
  className?: string;
}) {
  const vertical = orientation === 'vertical';
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      onPointerDown={onPointerDown}
      className={cn(
        'group/grip z-10 flex shrink-0 items-center justify-center',
        vertical ? 'w-2 cursor-col-resize self-stretch' : 'h-2 cursor-row-resize',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full bg-foreground/0 transition-colors group-hover/grip:bg-foreground/60 group-active/grip:bg-foreground/80',
          vertical ? 'h-10 w-[3px]' : 'h-[3px] w-10',
        )}
      />
    </div>
  );
}

/** Switches for the plan and task panes, each shown once there is something
 *  to show. They sit in the dock's bar while the dock is open and in the chat
 *  header otherwise — after a turn this is the way back to its plan. */
export function PaneToggles() {
  const { t } = useTranslation();
  const planOpen = useUi((s) => s.planPanelOpen);
  const setPlanOpen = useUi((s) => s.setPlanPanelOpen);
  const tasksOpen = useUi((s) => s.tasksPanelOpen);
  const setTasksOpen = useUi((s) => s.setTasksPanelOpen);
  const hasPlan = !!useSessionPlan();
  const hasTasks = useBgTasks().length > 0;
  const toggle = (on: boolean) => cn(iconBtn, on && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary');
  return (
    <>
      {(hasPlan || planOpen) && (
        <Tooltip label={planOpen ? t('plan.closePanel') : t('plan.show')}>
          <button
            type="button"
            aria-pressed={planOpen}
            aria-label={planOpen ? t('plan.closePanel') : t('plan.show')}
            onClick={() => setPlanOpen(!planOpen)}
            className={toggle(planOpen)}
          >
            <PlanIcon className="size-4" />
          </button>
        </Tooltip>
      )}
      {(hasTasks || tasksOpen) && (
        <Tooltip label={tasksOpen ? t('tasks.closePanel') : t('tasks.show')}>
          <button
            type="button"
            aria-pressed={tasksOpen}
            aria-label={tasksOpen ? t('tasks.closePanel') : t('tasks.show')}
            onClick={() => setTasksOpen(!tasksOpen)}
            className={toggle(tasksOpen)}
          >
            <AgentsIcon className="size-4" />
          </button>
        </Tooltip>
      )}
    </>
  );
}

type PaneDef = { key: DockPane; node: (className: string) => React.ReactNode };

/** The right-hand dock: file preview, plan and task list, each its own pane.
 *  One open → it takes the whole height; several → they stack, preview on
 *  top, with a draggable divider between neighbours. A single grip on the
 *  left edge resizes the dock as one. Above the panes sits the dock's bar:
 *  the chat's files button (handed over from the chat header, so the title
 *  there gets the whole column) and switches for the plan and task panes.
 *  Full-screen preview lifts out of the dock and covers the chat column (App
 *  gives it a positioned box that stops at the sidebar). */
export function RightDock() {
  const { t } = useTranslation();
  const sessionId = useChat((s) => s.sessionId);
  const previewOpen = useUi((s) => s.artifactsOpen && !!s.preview);
  const planOpen = useUi((s) => s.planPanelOpen);
  const tasksOpen = useUi((s) => s.tasksPanelOpen);
  const fullscreen = useUi((s) => s.previewFullscreen);
  const setFullscreen = useUi((s) => s.setPreviewFullscreen);
  const width = usePrefs((s) => s.previewWidth);
  const setWidth = usePrefs((s) => s.setPreviewWidth);
  const sizes = usePrefs((s) => s.dockSizes);
  const setSizes = usePrefs((s) => s.setDockSizes);
  // Live values during a drag (avoids persisting on every mousemove).
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [dragSizes, setDragSizes] = useState<DockSizes | null>(null);
  const dock = useRef<HTMLElement>(null);
  const paneEls = useRef<Partial<Record<DockPane, HTMLDivElement | null>>>({});

  const onWidthDrag = useCallback((e: React.PointerEvent) => {
    const startX = e.clientX;
    // From what is on screen: the CSS cap may hold the dock below the stored
    // width, and a drag must move it from where the reader sees it.
    const startWidth = dock.current?.getBoundingClientRect().width ?? width;
    startDrag(
      e,
      'col-resize',
      (ev) => setDragWidth(clampWidth(startWidth + (startX - ev.clientX))),
      (ev) => {
        setWidth(clampWidth(startWidth + (startX - ev.clientX)));
        setDragWidth(null);
      },
    );
  }, [width, setWidth]);

  /** Move the divider between two neighbouring panes: their combined height
   *  stays, it is only shared differently. Weights, not pixels, are stored,
   *  so the layout keeps its proportions as the window resizes. */
  const onSplitDrag = useCallback((e: React.PointerEvent, above: DockPane, below: DockPane) => {
    const a = paneEls.current[above]?.getBoundingClientRect().height ?? 0;
    const b = paneEls.current[below]?.getBoundingClientRect().height ?? 0;
    if (a + b <= 0) return;
    const startY = e.clientY;
    const weight = sizes[above] + sizes[below];
    const MIN = 72;
    const next = (ev: PointerEvent): DockSizes => {
      const h = Math.min(a + b - MIN, Math.max(MIN, a + (ev.clientY - startY)));
      const wa = (weight * h) / (a + b);
      return { ...sizes, [above]: wa, [below]: weight - wa };
    };
    startDrag(
      e,
      'row-resize',
      (ev) => setDragSizes(next(ev)),
      (ev) => {
        setSizes(next(ev));
        setDragSizes(null);
      },
    );
  }, [sizes, setSizes]);

  // Escape steps out of full screen (before anything closes the panel).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, setFullscreen]);

  const panes: PaneDef[] = [];
  if (previewOpen && !fullscreen) panes.push({ key: 'preview', node: (c) => <PreviewPane className={c} /> });
  if (planOpen) panes.push({ key: 'plan', node: (c) => <PlanPane className={cn(paneChrome, c)} /> });
  if (tasksOpen) panes.push({ key: 'tasks', node: (c) => <TasksPane className={cn(paneChrome, c)} /> });
  const weights = dragSizes ?? sizes;

  return (
    <>
      {previewOpen && fullscreen && (
        // z-40 sits above everything the chat floats — header, scroll-to-bottom
        // pill (z-30) — so none of it shows through.
        <PreviewPane className="absolute inset-0 z-40 m-2" />
      )}
      {panes.length > 0 && (
        // The cap keeps the chat column usable on a narrow window, whatever
        // width was stored on a wide one.
        <aside
          ref={dock}
          className="flex shrink-0 py-2 pr-2"
          style={{ width: dragWidth ?? width, maxWidth: 'max(18rem, calc(100% - 22rem))' }}
        >
          <Grip orientation="vertical" label={t('preview.resizeDock')} onPointerDown={onWidthDrag} />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Same line as the chat header (top-2, h-7). */}
            <div className="mb-2 flex h-7 shrink-0 items-center justify-end gap-1">
              <PaneToggles />
              {sessionId && <SessionFilesPopover sessionId={sessionId} />}
            </div>
            {panes.map((pane, i) => (
              <Fragment key={pane.key}>
                {i > 0 && (
                  <Grip
                    orientation="horizontal"
                    label={t('preview.resizeSplit')}
                    onPointerDown={(e) => onSplitDrag(e, panes[i - 1].key, pane.key)}
                  />
                )}
                <div
                  ref={(el) => { paneEls.current[pane.key] = el; }}
                  className="flex min-h-0 flex-col"
                  style={{ flex: panes.length > 1 ? `${weights[pane.key]} 1 0` : '1 1 0' }}
                >
                  {pane.node('flex-1')}
                </div>
              </Fragment>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}
