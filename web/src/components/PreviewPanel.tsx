import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTextIcon, RotateCcwIcon } from 'lucide-react';
import { fetchArtifactBlob, fetchDocumentVersions, restoreDocumentVersion, updateDocument, type DocumentVersion } from '@/api/client';
import { fileExt, previewKind, type PreviewKind } from '@/lib/files';
import { queryClient } from '@/lib/queryClient';
import { useUi, type PreviewFile } from '@/state/ui';
import { Markdown } from './Markdown';

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
  | { kind: 'word'; blob: Blob }
  | { kind: 'presentation'; slides: { texts: string[]; images: string[] }[] }
  | { kind: 'blobUrl'; url: string; pdf: boolean };

function textLoaded(kind: PreviewKind, text: string, name: string): Loaded {
  if (kind === 'markdown') return { kind: 'markdown', text };
  if (kind === 'code') return { kind: 'code', text, lang: FENCE_LANG[fileExt(name)] ?? '' };
  return { kind: 'text', text };
}

async function parsePresentation(blob: Blob): Promise<{ texts: string[]; images: string[] }[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  return Promise.all(slidePaths.map(async (slidePath) => {
    const xml = await zip.file(slidePath)!.async('text');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const texts = Array.from(doc.getElementsByTagNameNS('*', 't'))
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean);
    const slideName = slidePath.split('/').pop()!;
    const rel = zip.file(`ppt/slides/_rels/${slideName}.rels`);
    const images: string[] = [];
    if (rel) {
      const relXml = await rel.async('text');
      const relDoc = new DOMParser().parseFromString(relXml, 'application/xml');
      const targets = Array.from(relDoc.getElementsByTagNameNS('*', 'Relationship'))
        .map((node) => node.getAttribute('Target') ?? '')
        .filter((target) => /(?:^|\/)media\//.test(target));
      for (const target of targets) {
        const mediaPath = target.replace(/^\.\.\//, 'ppt/');
        const file = zip.file(mediaPath);
        if (!file) continue;
        const ext = fileExt(mediaPath);
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
        images.push(`data:${mime};base64,${await file.async('base64')}`);
      }
    }
    return { texts, images };
  }));
}

/** Body of the document viewer (no panel chrome — the shared right panel owns
 *  the border, header and resize). Renders the selected workspace file in the
 *  current theme: markdown/text/code via the shared Markdown renderer, Excel via
 *  SheetJS tables, Word via docx-preview (real pages), PDFs/images inline. */
export function PreviewContent({ preview }: { preview: PreviewFile | null }) {
  const { t } = useTranslation();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [viewedVersion, setViewedVersion] = useState<number | 'current'>('current');
  const [currentText, setCurrentText] = useState('');
  const objectUrl = useRef<string | null>(null);
  const updatePreview = useUi((s) => s.updatePreview);

  const kind: PreviewKind = preview ? previewKind(preview.name, preview.mime) : 'none';

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);
    setEditing(false);
    setSaveError(false);
    setViewedVersion('current');
    // Revoke any object URL from a previous file before loading the next.
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }

    if (preview.content !== undefined && ['markdown', 'text', 'code'].includes(kind)) {
      setCurrentText(preview.content);
      setLoaded(textLoaded(kind, preview.content, preview.name));
      setLoading(false);
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const blob = await fetchArtifactBlob(preview.sessionId, preview.path);
        if (cancelled) return;
        if (kind === 'image' || kind === 'pdf') {
          const url = URL.createObjectURL(blob);
          objectUrl.current = url;
          setLoaded({ kind: 'blobUrl', url, pdf: kind === 'pdf' });
        } else if (kind === 'word') {
          // Rendered by docx-preview in <WordDocument> — it reads the .docx's
          // own styles/fonts/page layout, so keep the raw blob rather than a
          // lossy semantic HTML conversion.
          if (!cancelled) setLoaded({ kind: 'word', blob });
        } else if (kind === 'presentation') {
          const slides = await parsePresentation(blob);
          if (!cancelled) setLoaded({ kind: 'presentation', slides });
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
          if (!cancelled) {
            setCurrentText(text);
            setLoaded({ kind: 'code', text, lang: FENCE_LANG[fileExt(preview.name)] ?? '' });
          }
        } else {
          const text = await blob.text();
          if (!cancelled) {
            setCurrentText(text);
            setLoaded({ kind: kind === 'markdown' ? 'markdown' : 'text', text });
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [preview, kind]);

  const docId = preview?.path.startsWith('document:')
    ? preview.path.slice('document:'.length)
    : null;

  useEffect(() => {
    if (!docId || preview?.streaming) { setVersions([]); return; }
    let cancelled = false;
    void fetchDocumentVersions(docId).then((items) => {
      if (!cancelled) setVersions(items);
    }).catch(() => { if (!cancelled) setVersions([]); });
    return () => { cancelled = true; };
  }, [docId, preview?.version, preview?.streaming]);

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
      const saved = await updateDocument(preview.path.slice('document:'.length), draft);
      if (loaded?.kind === 'code') setLoaded({ ...loaded, text: draft });
      else if (loaded?.kind === 'markdown') setLoaded({ kind: 'markdown', text: draft });
      else setLoaded({ kind: 'text', text: draft });
      setCurrentText(draft);
      updatePreview({ content: draft, version: saved.version_count, streaming: false });
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['artifacts', preview.sessionId] });
      void fetchDocumentVersions(saved.id).then(setVersions);
    } catch (e) {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const chooseVersion = (value: string) => {
    if (value === 'current') {
      setViewedVersion('current');
      if (loaded) setLoaded(textLoaded(kind, currentText, preview.name));
      return;
    }
    const number = Number(value);
    const selected = versions.find((version) => version.version_number === number);
    if (!selected) return;
    setViewedVersion(number);
    if (loaded) setLoaded(textLoaded(kind, selected.content, preview.name));
    setEditing(false);
  };

  const restore = async () => {
    if (!docId || viewedVersion === 'current') return;
    setSaving(true);
    setSaveError(false);
    try {
      const restored = await restoreDocumentVersion(docId, viewedVersion);
      setCurrentText(restored.current_content);
      setLoaded(textLoaded(kind, restored.current_content, preview.name));
      setViewedVersion('current');
      updatePreview({ content: restored.current_content, version: restored.version_count });
      setVersions(await fetchDocumentVersions(docId));
      void queryClient.invalidateQueries({ queryKey: ['artifacts', preview.sessionId] });
    } catch {
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
          {!editing && versions.length > 1 && (
            <select value={viewedVersion} onChange={(e) => chooseVersion(e.target.value)} className="mr-auto max-w-44 rounded-md border bg-background px-2 py-1 text-xs">
              <option value="current">{t('preview.currentVersion', { version: versions[0]?.version_number })}</option>
              {versions.slice(1).map((version) => <option key={version.id} value={version.version_number}>v{version.version_number} · {version.summary || version.source || ''}</option>)}
            </select>
          )}
          {!editing && viewedVersion !== 'current' && (
            <button type="button" onClick={() => void restore()} disabled={saving} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"><RotateCcwIcon className="size-3.5" />{t('preview.restoreVersion')}</button>
          )}
          {editing ? (
            <>
              <button type="button" onClick={() => setEditing(false)} disabled={saving} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60">{saving ? t('common.loading') : t('common.save')}</button>
            </>
          ) : (
            viewedVersion === 'current' && <button type="button" onClick={() => { setDraft(editableText ?? ''); setSaveError(false); setEditing(true); }} className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium hover:bg-accent">{t('common.edit')}</button>
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

/** Renders a real .docx with docx-preview inside an ISOLATED iframe. The library
 *  reads the document's own styles, fonts, sizes and page geometry and lays it
 *  out as actual paper pages (like Word / the Claude app). The iframe is what
 *  makes it faithful: rendered into the app's DOM, the global CSS reset (Tailwind
 *  preflight) strips table borders, overrides fonts, and flattens spacing. An
 *  iframe has its own clean document, so only docx-preview's own styles apply.
 *  The iframe auto-sizes to its content so the surrounding panel does the
 *  scrolling (one continuous scroll through all pages). */
function WordDocument({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    let cancelled = false;
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    setError(false);
    // Fresh, reset-free document for docx-preview to own.
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !frame.contentDocument) return;
        const idoc = frame.contentDocument;
        await renderAsync(blob, idoc.body, idoc.head, {
          className: 'docx',
          inWrapper: true,     // gray backdrop with centered white pages
          breakPages: true,    // real page breaks, like Word
          ignoreLastRenderedPageBreak: false, // honor Word's page-break marks so pages show
          experimental: true,  // tab stops / better layout fidelity
          useBase64URL: true,  // inline images (no blob-URL lifetime issues)
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (cancelled || !frame.contentDocument) return;
        // Grow the iframe to fit its content; re-measure after fonts/images
        // settle so a late-loading image doesn't clip the last page.
        const measure = () => {
          const b = frame.contentDocument?.body;
          if (b && !cancelled) setHeight(b.scrollHeight + 4);
        };
        measure();
        window.setTimeout(measure, 250);
        window.setTimeout(measure, 1000);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);

  return (
    <div className="min-h-full bg-muted/40">
      {error && <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>}
      <iframe ref={frameRef} title="Word document" className="block w-full border-0" style={{ height }} />
    </div>
  );
}

function PreviewBody({ loaded, name }: { loaded: Loaded; name: string }) {
  if (loaded.kind === 'markdown') {
    // Markdown stays a plain, pageless reader — it isn't a Word document. Only
    // real Office files (.docx/.xlsx/.pptx) get the paper-page / grid treatment.
    return <div className="p-4"><Markdown text={loaded.text} /></div>;
  }
  if (loaded.kind === 'text') {
    return <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed">{loaded.text}</pre>;
  }
  if (loaded.kind === 'code') {
    return <div className="p-4"><Markdown text={'```' + loaded.lang + '\n' + loaded.text + '\n```'} /></div>;
  }
  if (loaded.kind === 'csv') {
    return <div className="min-h-full bg-muted/40 p-3"><SpreadsheetGrid rows={loaded.rows} /></div>;
  }
  if (loaded.kind === 'excel') {
    return <ExcelView sheets={loaded.sheets} />;
  }
  if (loaded.kind === 'word') {
    return <WordDocument blob={loaded.blob} />;
  }
  if (loaded.kind === 'presentation') {
    return (
      <div className="space-y-5 bg-muted/40 p-4">
        {loaded.slides.map((slide, index) => (
          <figure key={index} className="mx-auto w-full max-w-4xl">
            <section className="flex aspect-video w-full flex-col overflow-auto rounded-lg border bg-white p-8 text-slate-900 shadow-sm ring-1 ring-black/5">
              <div className="space-y-3">
                {slide.texts.map((text, i) => i === 0
                  ? <h2 key={i} className="text-2xl font-semibold leading-tight">{text}</h2>
                  : <p key={i} className="text-base leading-relaxed">{text}</p>)}
              </div>
              {slide.images.length > 0 && <div className="mt-5 grid grid-cols-2 gap-3">{slide.images.map((src, i) => <img key={i} src={src} alt="" className="max-h-64 w-full object-contain" />)}</div>}
            </section>
            <figcaption className="mt-1.5 text-center text-[11px] font-medium text-muted-foreground">{index + 1} / {loaded.slides.length}</figcaption>
          </figure>
        ))}
      </div>
    );
  }
  // blobUrl: pdf in an iframe, otherwise an image.
  if (loaded.pdf) {
    return <iframe src={loaded.url} title={name} className="h-full w-full border-0 bg-white" />;
  }
  return (
    <div className="flex h-full items-center justify-center bg-muted/40 p-4">
      <img src={loaded.url} alt={name} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
    </div>
  );
}

function ExcelView({ sheets }: { sheets: { name: string; rows: string[][] }[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/40">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {sheet && sheet.rows.length > 0 ? <SpreadsheetGrid rows={sheet.rows} /> : (
          <p className="px-1 py-4 text-xs text-muted-foreground">—</p>
        )}
      </div>
      {/* Sheet tabs pinned to the bottom, like a spreadsheet app. */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t bg-card px-2 py-1.5">
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
    </div>
  );
}

/** Spreadsheet column label for a 0-based index: 0→A, 25→Z, 26→AA, … */
function columnLabel(index: number): string {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** A real spreadsheet grid — A/B/C column headers, a row-number gutter, sticky
 *  headers and gridlines — so .xlsx/.csv artifacts read like a spreadsheet app
 *  rather than a plain HTML table. Every row is data (no header row is stolen),
 *  matching how a sheet actually looks. */
function SpreadsheetGrid({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="px-1 py-4 text-xs text-muted-foreground">—</p>;
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const colIdx = Array.from({ length: cols }, (_, i) => i);
  return (
    <div className="inline-block min-w-full overflow-hidden rounded-md border bg-card shadow-sm">
      <table className="border-collapse text-[13px] tabular-nums">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 w-11 border border-border/70 bg-muted" />
            {colIdx.map((i) => (
              <th key={i} className="sticky top-0 z-10 min-w-[84px] border border-border/70 bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground">{columnLabel(i)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <th className="sticky left-0 z-10 border border-border/70 bg-muted px-2 py-1 text-center text-xs font-normal text-muted-foreground">{ri + 1}</th>
              {colIdx.map((ci) => (
                <td key={ci} className="max-w-[28rem] truncate border border-border/60 px-2 py-1 align-top" title={r[ci] ?? ''}>{r[ci] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
