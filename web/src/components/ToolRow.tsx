import { CheckIcon, ChevronRightIcon, CopyIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@/api/types';
import { describeCall, diffStat, partsToString, toolFamily } from '@/lib/toolLabels';
import { cn, copyTextToClipboard } from '@/lib/utils';
import { useUi } from '@/state/ui';
import { TOOL_FAIL_CLASS, TOOL_PASS_CLASS, ToolLabel } from './ToolLabel';
import { Collapse } from './ui/collapse';

export interface ToolImage {
  src: string;
  label?: string;
}

/** Responsive grid of clickable image thumbnails. Clicking opens the shared
 *  full-screen lightbox (zoom + download). Labels render centered under each
 *  image to match the centered thumbnail; pass `showLabels={false}` for the
 *  end-of-turn recap where the subtitle would just be noise. */
export function ImageGallery({ images, showLabels = true }: { images: ToolImage[]; showLabels?: boolean }) {
  const { t } = useTranslation();
  const openLightbox = useUi((s) => s.openLightbox);
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
      {images.map((image, i) => (
        <figure key={`${image.src.slice(0, 48)}-${i}`} className="m-0 min-w-0">
          <button
            type="button"
            onClick={() => openLightbox(image)}
            aria-label={image.label || t('messages.toolImage', { n: i + 1 })}
            className="block w-full cursor-zoom-in rounded-lg transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={image.src}
              alt={image.label || t('messages.toolImage', { n: i + 1 })}
              className="max-h-80 w-full rounded-lg object-contain"
            />
          </button>
          {showLabels && image.label && (
            <figcaption className="mt-1 break-words text-center text-xs text-muted-foreground">{image.label}</figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}

export function toolImages(call: ToolCall): ToolImage[] {
  const images: ToolImage[] = [];
  if (call.image_url) images.push({ src: call.image_url, label: call.image_prompt || 'Generated image' });
  if (call.screenshot) images.push({ src: call.screenshot, label: 'Screenshot' });
  for (const image of call.created_images ?? []) {
    const src = image.data_url || image.url;
    if (src) images.push({ src, label: image.caption || image.name });
  }
  return images.filter((image, i, all) => all.findIndex((other) => other.src === image.src) === i);
}

/** Line-coloured unified diff, the format `_unified_diff` emits on the backend
 *  for edit_file / write_file. Shown instead of the raw tool output so a code
 *  edit reads as a change rather than as a log line. The sign sits in its own
 *  gutter so the code lines up down the column; file headers are dropped (the
 *  row's label already names the file) and hunk markers become quiet dividers.
 *  Renders as a bare section — `CallDetails` supplies the box. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
  return (
    <div className="max-h-80 overflow-auto pb-2">
      {lines.map((line, i) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        if (kind === 'hunk') {
          return (
            <div key={i} className="px-3 py-0.5 text-[11px] text-muted-foreground/70">
              {line}
            </div>
          );
        }
        return (
          <div key={i} className={cn('flex min-w-0', kind === 'add' && 'bg-success/10', kind === 'del' && 'bg-destructive/10')}>
            <span
              aria-hidden
              className={cn(
                'w-7 shrink-0 text-center select-none',
                kind === 'add' ? 'text-success' : kind === 'del' ? 'text-destructive-foreground' : 'text-transparent',
              )}
            >
              {kind === 'add' ? '+' : kind === 'del' ? '−' : '·'}
            </span>
            <span className={cn('min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words', kind === 'ctx' ? 'text-muted-foreground' : 'text-strong')}>
              {(kind === 'ctx' ? line.replace(/^ /, '') : line.slice(1)) || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Changed-line counter — "+21 -2". Part of the label sentence, not a badge
 *  bolted onto it: it inherits the label's size and typeface so the whole line
 *  reads as one run of text, and only its digits carry the muted pass/fail
 *  tints (the loud --success / --destructive are for alerts). */
export function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      {added > 0 && <span className={TOOL_PASS_CLASS}>+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className={TOOL_FAIL_CLASS}>-{removed}</span>}
    </span>
  );
}

/* ── Call details ──
   What a tool was given and what it gave back, as one box with named sections.
   The point is that it reads: arguments are laid out as a list instead of one
   line of JSON, code and commands get a block with a gutter, and structured
   output is indented. */

/** The argument object of a call, when `command` is one. */
function parseArgs(command: string): Record<string, unknown> | null {
  const text = command.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Output that is JSON reads better indented; anything else is left as it is. */
function prettyOutput(output: string): string {
  const text = output.trim();
  if (!/^[[{]/.test(text)) return output;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return output;
  }
}

/** Arguments that hold a program rather than a value: shown as a code block
 *  once they are longer than a short line. */
const CODE_KEYS = new Set(['code', 'query', 'sql', 'script', 'command', 'content', 'html', 'source']);

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={t('toolDetails.copy')}
      title={t('toolDetails.copy')}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

/** One named part of the box: a caption line (what this is, a note about it, a
 *  copy button), then the content. */
function DetailSection({ label, meta, copy, tone, children }: {
  label: string;
  meta?: ReactNode;
  copy?: string;
  tone?: 'error';
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border/60 first:border-t-0">
      <header className="flex h-7 items-center gap-2 pr-1.5 pl-3 font-sans text-[11px]">
        <span
          className={cn(
            'font-medium tracking-wide uppercase',
            tone === 'error' ? 'text-destructive-foreground' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {meta && <span className="min-w-0 truncate text-muted-foreground/70 tabular-nums">{meta}</span>}
        {copy && (
          <span className="ml-auto">
            <CopyButton text={copy} />
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/** Code or a command with a gutter: line numbers for a block of several lines,
 *  a shell prompt for a terminal command. */
function CodeBlock({ text, prompt = false }: { text: string; prompt?: boolean }) {
  const lines = text.replace(/\n+$/, '').split('\n');
  const numbered = !prompt && lines.length > 1;
  const gutter = numbered || prompt;
  return (
    <div className="selectable max-h-64 overflow-auto pb-2">
      {lines.map((line, i) => (
        <div key={i} className="flex min-w-0">
          {gutter && (
            <span
              aria-hidden
              className={cn(
                'shrink-0 pr-2.5 pl-3 text-right select-none',
                prompt ? 'text-primary' : 'w-10 text-muted-foreground/45 tabular-nums',
              )}
            >
              {prompt ? (i === 0 ? '$' : ' ') : i + 1}
            </span>
          )}
          <span className={cn('min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words text-strong', !gutter && 'pl-3')}>
            {line || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Arguments as a two-column list: the name muted on the left, the value on
 *  the right. A value that is a program (a query, a script) breaks out into a
 *  code block of its own under its name. */
function ArgList({ args }: { args: Record<string, unknown> }) {
  const inline: Array<[string, string]> = [];
  const blocks: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const isProgram = CODE_KEYS.has(key) && typeof value === 'string' && text.length > 48;
    if (text.includes('\n') || isProgram) blocks.push([key, text]);
    else inline.push([key, text]);
  }
  return (
    <div className="pb-2">
      {inline.length > 0 && (
        <dl className="selectable grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-3">
          {inline.map(([key, text]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words text-strong">{text}</dd>
            </div>
          ))}
        </dl>
      )}
      {blocks.map(([key, text]) => (
        <div key={key} className={inline.length > 0 ? 'mt-1.5' : undefined}>
          <div className="px-3 pb-0.5 text-muted-foreground">{key}</div>
          <div className="-mb-2">
            <CodeBlock text={text} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Input, change and output of one call as ONE box rather than stacked ones: a
 *  single border and background, sections split by hairlines and each named. */
function CallDetails({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const family = toolFamily(call.tool);
  const command = call.command ?? '';
  const args = command ? parseArgs(command) : null;
  const stat = diffStat(call.diff);
  const failed = call.status === 'error';
  const output = call.output ? prettyOutput(call.output) : '';
  const outputLines = output ? output.replace(/\n+$/, '').split('\n').length : 0;
  const outputMeta = [
    outputLines > 1 ? t('toolDetails.lines', { count: outputLines }) : null,
    call.exitCode != null && call.exitCode !== 0 ? t('toolDetails.exit', { code: call.exitCode }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (!command && !call.diff && !output) return null;
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30 font-mono text-[12.5px] leading-[1.6]">
      {command && (
        <DetailSection
          label={t(family === 'command' ? 'toolDetails.command' : family === 'code' ? 'toolDetails.code' : 'toolDetails.input')}
          meta={family === 'command' || family === 'code' ? undefined : call.tool}
          copy={command}
        >
          {args ? <ArgList args={args} /> : <CodeBlock text={command} prompt={family === 'command'} />}
        </DetailSection>
      )}
      {call.diff && (
        <DetailSection
          label={t('toolDetails.change')}
          meta={stat ? <DiffStatBadge added={stat.added} removed={stat.removed} /> : undefined}
          copy={call.diff}
        >
          <div className="selectable">
            <DiffView diff={call.diff} />
          </div>
        </DetailSection>
      )}
      {output && (
        <DetailSection
          label={t(failed ? 'toolDetails.error' : 'toolDetails.output')}
          tone={failed ? 'error' : undefined}
          meta={outputMeta || undefined}
          copy={call.output}
        >
          <pre
            className={cn(
              'selectable max-h-72 overflow-auto px-3 pb-2.5 whitespace-pre-wrap break-words',
              failed ? 'text-destructive-foreground' : 'text-foreground/85',
            )}
          >
            {output}
          </pre>
        </DetailSection>
      )}
    </div>
  );
}

/** One tool-call row inside a ToolGroup: a readable label ("Read TODO.md"),
 *  expandable to the raw command, its output, and a diff when the call changed
 *  a file. `compact` suppresses the inline image gallery — those images
 *  resurface in the turn's end-of-turn grid instead. */
export function ToolRow({ call, compact = false }: { call: ToolCall; compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const images = toolImages(call);
  const running = call.status === 'running';
  const label = describeCall(call, t, running ? 'running' : 'past');
  const stat = diffStat(call.diff);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        // The verb's colour carries pass/fail visually; spell it out for screen
        // readers, which get no colour.
        aria-label={`${partsToString(label)}${call.status === 'error' ? ` — ${t('toolGroup.failed')}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className={`min-w-0 truncate ${running ? 'shimmer-text' : ''}`}>
          <ToolLabel parts={label} failed={call.status === 'error'} />
        </span>
        {stat && <DiffStatBadge added={stat.added} removed={stat.removed} />}
        <ChevronRightIcon className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="px-3 pb-2.5">
          <CallDetails call={call} />
        </div>
      </Collapse>
      {(call.image_note || (!compact && images.length > 0)) && (
        <div className="space-y-1.5 px-3 pb-2.5">
          {call.image_note && <div className="text-xs text-muted-foreground">{call.image_note}</div>}
          {!compact && <ImageGallery images={images} />}
        </div>
      )}
    </div>
  );
}
