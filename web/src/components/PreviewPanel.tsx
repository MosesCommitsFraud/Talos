import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTextIcon } from 'lucide-react';
import { fetchArtifactBlob, updateDocument } from '@/api/client';
import { fileExt, previewKind, type PreviewKind } from '@/lib/files';
import { queryClient } from '@/lib/queryClient';
import { Markdown } from './Markdown';

type PreviewFile = { sessionId: string; path: string; name: string; mime?: string };

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

/** Body of the document viewer (no panel chrome — the shared right panel owns
 *  the border, header and resize). Renders the selected workspace file in the
 *  current theme: markdown/text/code via the shared Markdown renderer, Excel via
 *  SheetJS tables, Word via mammoth→HTML, PDFs/images inline. */
export function PreviewContent({ preview }: { preview: PreviewFile | null }) {
  const { t } = useTranslation();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const objectUrl = useRef<string | null>(null);

  const kind: PreviewKind = preview ? previewKind(preview.name, preview.mime) : 'none';

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);
    setEditing(false);
    setSaveError(false);
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
          const sep = fileExt(preview.name) === 'tsv' ? '\t' : ',';
          const rows = parseDelimited(text, sep);
          if (!cancelled) setLoaded({ kind: 'csv', rows });
        } else if (kind === 'code') {
          const text = await blob.text();
          if (!cancelled) setLoaded({ kind: 'code', text, lang: FENCE_LANG[fileExt(preview.name)] ?? '' });
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

  if (!preview) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <FileTextIcon className="size-7 opacity-60" />
        <p className="text-xs">{t('preview.empty')}</p>
      </div>
    );
  }

  const editableText = loaded && (
    loaded.kind === 'markdown' || loaded.kind === 'text' || loaded.kind === 'code'
  ) ? loaded.text : null;
  const editableDocument = preview.path.startsWith('document:') && editableText !== null;

  const save = async () => {
    if (!editableDocument) return;
    setSaving(true);
    setSaveError(false);
    try {
      await updateDocument(preview.path.slice('document:'.length), draft);
      if (loaded?.kind === 'code') setLoaded({ ...loaded, text: draft });
      else if (loaded?.kind === 'markdown') setLoaded({ kind: 'markdown', text: draft });
      else setLoaded({ kind: 'text', text: draft });
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['artifacts', preview.sessionId] });
    } catch (e) {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {editableDocument && !loading && !error && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {saveError && <span className="mr-auto text-xs text-destructive-foreground">{t('preview.saveError')}</span>}
          {editing ? (
            <>
              <button type="button" onClick={() => setEditing(false)} disabled={saving} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60">{saving ? t('common.loading') : t('common.save')}</button>
            </>
          ) : (
            <button type="button" onClick={() => { setDraft(editableText ?? ''); setSaveError(false); setEditing(true); }} className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium hover:bg-accent">{t('common.edit')}</button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
      {loading && <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
      {error && <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>}
      {!loading && !error && editing && (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="h-full min-h-96 w-full resize-none bg-background p-4 font-mono text-[13px] leading-relaxed outline-none" spellCheck={false} />
      )}
      {!loading && !error && !editing && loaded && <PreviewBody loaded={loaded} name={preview.name} />}
      </div>
    </div>
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
