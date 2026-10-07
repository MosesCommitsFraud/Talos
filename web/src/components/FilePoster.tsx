import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { artifactDownloadUrl, artifactPreviewUrl, artifactRenderUrl, fetchArtifactBlob } from '@/api/client';
import { fileExt, previewKind } from '@/lib/files';
import { useThumbnail } from '@/lib/thumbnails';
import type { SessionFile } from '@/lib/useSessionFiles';
import { FilePreviewFace } from './AttachmentTile';
import { FileTypeIcon } from './FileTypeIcon';
import { Markdown } from './Markdown';

/** Width the poster thumbnails are rendered at — the file menu's content width. */
const POSTER_W = 328;
/** Page faces (PDF, Office) render at A4 proportions and are shown top-aligned
 *  in the shorter poster box, so the poster shows the head of the document —
 *  title and first lines — not a crop from the middle of page one. */
const PAGE_H = Math.round(POSTER_W * 1.414);

function Glyph({ file }: { file: SessionFile }) {
  return (
    <div className="flex size-full items-center justify-center bg-muted">
      <FileTypeIcon path={file.name} mime={file.mime} className="size-10 text-muted-foreground" />
    </div>
  );
}

/** First page of a PDF at page proportions, top-aligned. `fallback` covers a
 *  conversion that isn't available (no sandbox → no Office → PDF). */
function PageFace({ url, fallback }: { url: string; fallback: React.ReactNode }) {
  const thumb = useThumbnail(url, 'preview.pdf', 'application/pdf', POSTER_W, PAGE_H);
  if (thumb.failed) return <>{fallback}</>;
  return (
    <div ref={thumb.ref} className="size-full bg-white">
      {thumb.src && <img src={thumb.src} alt="" decoding="async" className="size-full object-cover object-top" />}
    </div>
  );
}

/** The file's text, for posters that render it themselves. Capped: a poster
 *  shows a screenful, not the whole file. */
function useArtifactText(sessionId: string, file: SessionFile, enabled: boolean) {
  return useQuery({
    queryKey: ['artifact-text', sessionId, file.path, file.version ?? file.mtime ?? 0],
    queryFn: async () => (await (await fetchArtifactBlob(sessionId, file.path)).text()).slice(0, 4000),
    enabled,
    staleTime: 60_000,
  });
}

/** Text-like files drawn as a half-scale page: markdown rendered, code and
 *  plain text monospaced, CSV as a little grid. */
function TextFace({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const kind = previewKind(file.name, file.mime);
  const { data, isError } = useArtifactText(sessionId, file, true);
  if (isError) return <Glyph file={file} />;
  if (data === undefined) return <div className="size-full animate-pulse bg-muted" />;
  let body: React.ReactNode;
  if (kind === 'markdown') {
    body = <div className="text-[15px] leading-relaxed text-strong"><Markdown text={data} /></div>;
  } else if (kind === 'csv') {
    const sep = fileExt(file.name) === 'tsv' ? '\t' : ',';
    const rows = data.split('\n').slice(0, 14).map((line) => line.split(sep).slice(0, 6));
    body = <MiniGrid rows={rows} />;
  } else {
    body = <pre className="whitespace-pre-wrap break-all font-mono text-[13px] leading-snug text-foreground/85">{data}</pre>;
  }
  return (
    <div className="size-full overflow-hidden bg-card">
      {/* Laid out at double width, then halved: reads as a page, not a zoom. */}
      <div className="w-[200%] origin-top-left scale-50 p-6">{body}</div>
    </div>
  );
}

function MiniGrid({ rows }: { rows: string[][] }) {
  return (
    <table className="w-full border-collapse text-[14px] text-foreground/85">
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className={r === 0 ? 'bg-muted font-medium' : ''}>
            {row.map((cell, c) => (
              <td key={c} className="truncate border border-border px-2 py-1">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Spreadsheet without the server-side PDF conversion: the first sheet's top
 *  rows, read in the browser like the preview panel's own fallback. */
function SheetFace({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const { data, isError } = useQuery({
    queryKey: ['artifact-sheet', sessionId, file.path, file.version ?? file.mtime ?? 0],
    queryFn: async () => {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await (await fetchArtifactBlob(sessionId, file.path)).arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
      return rows.slice(0, 14).map((row) => row.slice(0, 6).map((cell) => String(cell ?? '')));
    },
    staleTime: 60_000,
  });
  if (isError) return <Glyph file={file} />;
  if (!data) return <div className="size-full animate-pulse bg-muted" />;
  return (
    <div className="size-full overflow-hidden bg-card">
      <div className="w-[200%] origin-top-left scale-50 p-4"><MiniGrid rows={data} /></div>
    </div>
  );
}

/** A web page shown live, laid out at desktop width and scaled into the box.
 *  Inert: the poster is a picture of the page, clicks go to the card. */
function HtmlFace({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / 1280);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="relative size-full overflow-hidden bg-white">
      {scale > 0 && (
        <iframe
          title={file.name}
          src={artifactRenderUrl(sessionId, file.path)}
          sandbox="allow-scripts"
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: 1280, height: 1280 * 0.75, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

/** A large face for a file — what the file menu shows for the turn's
 *  deliverables, so a document is recognisable before it is opened. Fills its
 *  box; the caller sets the size. */
export function FilePoster({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const kind = previewKind(file.name, file.mime);
  switch (kind) {
    case 'image':
      return <FilePreviewFace url={artifactDownloadUrl(sessionId, file.path)} name={file.name} mime={file.mime} width={POSTER_W} height={160} />;
    case 'pdf':
      return <PageFace url={artifactDownloadUrl(sessionId, file.path)} fallback={<Glyph file={file} />} />;
    case 'word':
    case 'presentation':
      return <PageFace url={artifactPreviewUrl(sessionId, file.path)} fallback={<Glyph file={file} />} />;
    case 'excel':
      return <PageFace url={artifactPreviewUrl(sessionId, file.path)} fallback={<SheetFace sessionId={sessionId} file={file} />} />;
    case 'html':
      return <HtmlFace sessionId={sessionId} file={file} />;
    case 'markdown':
    case 'text':
    case 'code':
    case 'csv':
      return <TextFace sessionId={sessionId} file={file} />;
    default:
      return <Glyph file={file} />;
  }
}
