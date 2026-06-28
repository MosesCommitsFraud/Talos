import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, XIcon, FileTextIcon } from 'lucide-react';
import { artifactDownloadUrl, fetchArtifactBlob } from '@/api/client';
import { useUi } from '@/state/ui';
import { usePrefs } from '@/state/prefs';
import { fileExt, previewKind, type PreviewKind } from '@/lib/files';
import { Markdown } from './Markdown';
import { Tooltip } from './ui/misc';

const MIN_WIDTH = 320;
/** Cap the panel at most of the viewport so the chat never fully disappears. */
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));

/** Map a code-file extension to a markdown fence language so the shared Markdown
 *  renderer highlights it (and inherits the current theme). */
const FENCE_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yaml: 'yaml',
  yml: 'yaml', html: 'html', htm: 'html', css: 'css', scss: 'scss', rs: 'rust',
  go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
  hpp: 'cpp', rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift', xml: 'xml',
  toml: 'toml', lua: 'lua', r: 'r',
};

type Loaded =
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'csv'; rows: string[][] }
  | { kind: 'excel'; sheets: { name: string; rows: string[][] }[] }
  | { kind: 'word'; html: string }
  | { kind: 'blobUrl'; url: string; pdf: boolean };

/** Right-side resizable document viewer. Opens on a workspace file and renders
 *  it in the current theme: markdown/text/code via the shared Markdown renderer,
 *  Excel via SheetJS tables, Word via mammoth→HTML, PDFs/images inline. Chrome
 *  matches the left sidebar (rounded border, bg-background). */
export function PreviewPanel() {
  const { t } = useTranslation();
  const preview = useUi((s) => s.preview);
  const close = useUi((s) => s.closePreview);
  const width = usePrefs((s) => s.previewWidth);
  const setWidth = usePrefs((s) => s.setPreviewWidth);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Live width during a drag (avoids persisting on every mousemove).
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const objectUrl = useRef<string | null>(null);

  const kind: PreviewKind = preview ? previewKind(preview.path, preview.mime) : 'none';

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);
    // Revoke any object URL from a previous file before loading the next.
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }

    (async () => {
      try {
        const blob = await fetchArtifactBlob(preview.sessionId, preview.path);
        if (cancelled) return;
        if (kind === 'image' || kind === 'pdf') {
          const url = URL.createObjectURL(blob);
          objectUrl.current = url;
          setLoaded({ kind: 'blobUrl', url, pdf: kind === 'pdf' });
        } else if (kind === 'word') {
          const mammoth = await import('mammoth');
          const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
          if (!cancelled) setLoaded({ kind: 'word', html: value });
        } else if (kind === 'excel') {
          const XLSX = await import('xlsx');
          const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
          const sheets = wb.SheetNames.map((name) => ({
            name,
            rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, blankrows: false, defval: '' }),
          }));
          if (!cancelled) setLoaded({ kind: 'excel', sheets });
        } else if (kind === 'csv') {
          const text = await blob.text();
          const sep = fileExt(preview.path) === 'tsv' ? '\t' : ',';
          const rows = parseDelimited(text, sep);
          if (!cancelled) setLoaded({ kind: 'csv', rows });
        } else if (kind === 'code') {
          const text = await blob.text();
          if (!cancelled) setLoaded({ kind: 'code', text, lang: FENCE_LANG[fileExt(preview.path)] ?? '' });
        } else {
          const text = await blob.text();
          if (!cancelled) setLoaded({ kind: kind === 'markdown' ? 'markdown' : 'text', text });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [preview, kind]);

  // Release the last object URL when the panel unmounts.
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setDragWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(next);
      setDragWidth(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width, setWidth]);

  if (!preview) return null;
  const effWidth = dragWidth ?? width;

  return (
    <aside
      className="relative m-2 flex shrink-0 flex-col overflow-hidden rounded-md border bg-background"
      style={{ width: effWidth }}
      aria-label={t('preview.panelLabel')}
    >
      {/* Drag handle on the left edge — widens/narrows the panel. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('preview.resize')}
        onPointerDown={onResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/40"
      />
      <div className="flex h-10 shrink-0 items-center justify-between border-b pl-3 pr-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate" title={preview.name}>{preview.name}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label={t('preview.download')}>
            <a
              href={artifactDownloadUrl(preview.sessionId, preview.path)}
              download
              aria-label={t('preview.download')}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <DownloadIcon className="size-4" />
            </a>
          </Tooltip>
          <button
            type="button"
            aria-label={t('preview.close')}
            onClick={close}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
        {error && <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>}
        {!loading && !error && loaded && <PreviewBody loaded={loaded} name={preview.name} />}
      </div>
    </aside>
  );
}

function PreviewBody({ loaded, name }: { loaded: Loaded; name: string }) {
  if (loaded.kind === 'markdown') {
    return <div className="p-4"><Markdown text={loaded.text} /></div>;
  }
  if (loaded.kind === 'text') {
    return <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed">{loaded.text}</pre>;
  }
  if (loaded.kind === 'code') {
    return <div className="p-4"><Markdown text={'```' + loaded.lang + '\n' + loaded.text + '\n```'} /></div>;
  }
  if (loaded.kind === 'csv') {
    return <div className="p-3 overflow-auto"><DataTable rows={loaded.rows} /></div>;
  }
  if (loaded.kind === 'excel') {
    return <ExcelView sheets={loaded.sheets} />;
  }
  if (loaded.kind === 'word') {
    return <div className="docx-preview p-5" dangerouslySetInnerHTML={{ __html: loaded.html }} />;
  }
  // blobUrl: pdf in an iframe, otherwise an image.
  if (loaded.pdf) {
    return <iframe src={loaded.url} title={name} className="h-full w-full border-0 bg-white" />;
  }
  return (
    <div className="flex h-full items-center justify-center p-4">
      <img src={loaded.url} alt={name} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function ExcelView({ sheets }: { sheets: { name: string; rows: string[][] }[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors ${
                i === active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {sheet && sheet.rows.length > 0 ? <DataTable rows={sheet.rows} /> : (
          <p className="px-1 py-4 text-xs text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}

/** Renders a matrix as a bordered, themed table; the first row is the header. */
function DataTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="px-1 py-4 text-xs text-muted-foreground">—</p>;
  const [head, ...body] = rows;
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {pad(head).map((cell, i) => (
            <th key={i} className="sticky top-0 border bg-muted px-2 py-1 text-left font-medium">{String(cell)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, ri) => (
          <tr key={ri} className="even:bg-muted/30">
            {pad(r).map((cell, ci) => (
              <td key={ci} className="border px-2 py-1 align-top">{String(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes and the
 *  chosen separator inside quotes. Good enough for previewing agent output. */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}
