import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, FileTextIcon, MousePointer2Icon, RotateCcwIcon, XIcon } from 'lucide-react';
import type { ArtifactSelectionTarget } from '@/api/types';
import { downloadArtifact, fetchArtifactBlob, fetchArtifactPreviewBlob, fetchDocumentVersions, restoreDocumentVersion, updateDocument, type DocumentVersion } from '@/api/client';
import { fileExt, previewKind, type PreviewKind } from '@/lib/files';
import { queryClient } from '@/lib/queryClient';
import { useUi, type PreviewFile } from '@/state/ui';
import { Markdown } from './Markdown';
import { PdfViewer } from './PdfViewer';

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
  | { kind: 'excel'; sheets: { name: string; rows: string[][]; startRow: number; startCol: number }[] }
  | { kind: 'word'; blob: Blob }
  | { kind: 'presentation'; slides: PresentationSlide[] }
  | { kind: 'pdf'; blob: Blob }
  | { kind: 'image'; url: string };

function textLoaded(kind: PreviewKind, text: string, name: string): Loaded {
  if (kind === 'markdown') return { kind: 'markdown', text };
  if (kind === 'code') return { kind: 'code', text, lang: FENCE_LANG[fileExt(name)] ?? '' };
  return { kind: 'text', text };
}

type PresentationElement = { id: string; name: string; text?: string; src?: string };
type PresentationSlide = { texts: PresentationElement[]; images: PresentationElement[] };
type BoxSelectionCandidate = { target: ArtifactSelectionTarget; element: HTMLElement };

async function parsePresentation(blob: Blob): Promise<PresentationSlide[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  return Promise.all(slidePaths.map(async (slidePath) => {
    const xml = await zip.file(slidePath)!.async('text');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const texts = Array.from(doc.getElementsByTagNameNS('*', 'sp')).flatMap((shape) => {
      const properties = shape.getElementsByTagNameNS('*', 'cNvPr')[0];
      const text = Array.from(shape.getElementsByTagNameNS('*', 't'))
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      return text ? [{ id: properties?.getAttribute('id') || crypto.randomUUID(), name: properties?.getAttribute('name') || 'Text', text }] : [];
    });
    const slideName = slidePath.split('/').pop()!;
    const rel = zip.file(`ppt/slides/_rels/${slideName}.rels`);
    const images: PresentationElement[] = [];
    if (rel) {
      const relXml = await rel.async('text');
      const relDoc = new DOMParser().parseFromString(relXml, 'application/xml');
      const targets = new Map(Array.from(relDoc.getElementsByTagNameNS('*', 'Relationship')).map((node) => [
        node.getAttribute('Id') ?? '',
        node.getAttribute('Target') ?? '',
      ]));
      for (const picture of Array.from(doc.getElementsByTagNameNS('*', 'pic'))) {
        const properties = picture.getElementsByTagNameNS('*', 'cNvPr')[0];
        const relationshipId = picture.getElementsByTagNameNS('*', 'blip')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
          || picture.getElementsByTagNameNS('*', 'blip')[0]?.getAttribute('r:embed') || '';
        const target = targets.get(relationshipId) || '';
        if (!/(?:^|\/)media\//.test(target)) continue;
        const mediaPath = target.replace(/^\.\.\//, 'ppt/');
        const file = zip.file(mediaPath);
        if (!file) continue;
        const ext = fileExt(mediaPath);
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
        images.push({
          id: properties?.getAttribute('id') || relationshipId,
          name: properties?.getAttribute('name') || file.name,
          src: `data:${mime};base64,${await file.async('base64')}`,
        });
      }
    }
    return { texts, images };
  }));
}

/** Body of the document viewer (no panel chrome — the shared right panel owns
 *  the border, header and resize). Renders the selected workspace file in the
 *  current theme: markdown/text/code via the shared Markdown renderer, Excel via
 *  SheetJS tables, Word via a server-rendered PDF, PDFs/images inline. */
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
  const selectionRoot = useRef<HTMLDivElement>(null);
  const committedElements = useRef<HTMLElement[]>([]);
  const [markMode, setMarkMode] = useState(false);
  const [selectionCandidates, setSelectionCandidates] = useState<BoxSelectionCandidate[]>([]);
  const [groupRect, setGroupRect] = useState<DOMRect | null>(null);
  const [selectionLayoutVersion, setSelectionLayoutVersion] = useState(0);
  const updatePreview = useUi((s) => s.updatePreview);
  const artifactSelection = useUi((s) => s.artifactSelection);
  const setArtifactSelection = useUi((s) => s.setArtifactSelection);

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
    setMarkMode(false);
    selectionCandidates.forEach((candidate) => candidate.element.classList.remove('talos-selection-candidate'));
    committedElements.current.forEach((element) => element.classList.remove('talos-selection-committed'));
    committedElements.current = [];
    setSelectionCandidates([]);
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
        if (kind === 'word') {
          try {
            const pdf = await fetchArtifactPreviewBlob(preview.sessionId, preview.path);
            if (cancelled) return;
            setLoaded({ kind: 'pdf', blob: pdf });
            return;
          } catch {
            // Keep the browser renderer as a fallback for local setups without
            // LibreOffice and while a newly deployed sandbox is restarting.
          }
        }
        const blob = await fetchArtifactBlob(preview.sessionId, preview.path);
        if (cancelled) return;
        if (kind === 'image' || kind === 'pdf') {
          if (kind === 'pdf') {
            setLoaded({ kind: 'pdf', blob });
          } else {
            const url = URL.createObjectURL(blob);
            objectUrl.current = url;
            setLoaded({ kind: 'image', url });
          }
        } else if (kind === 'word') {
          if (!cancelled) setLoaded({ kind: 'word', blob });
        } else if (kind === 'presentation') {
          const slides = await parsePresentation(blob);
          if (!cancelled) setLoaded({ kind: 'presentation', slides });
        } else if (kind === 'excel') {
          const XLSX = await import('xlsx');
          const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
          const sheets = wb.SheetNames.map((name) => {
            const sheet = wb.Sheets[name];
            const usedRange = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
            return {
              name,
              rows: XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: true, defval: '' }),
              startRow: usedRange.s.r,
              startCol: usedRange.s.c,
            };
          });
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

  useEffect(() => {
    if (artifactSelection && preview && artifactSelection.sessionId === preview.sessionId && artifactSelection.path === preview.path) return;
    committedElements.current.forEach((element) => element.classList.remove('talos-selection-committed'));
    committedElements.current = [];
  }, [artifactSelection, preview]);

  useEffect(() => {
    const root = selectionRoot.current;
    if (!root) return;
    const applyClasses = () => {
      root.querySelectorAll('.talos-selection-candidate').forEach((element) => element.classList.remove('talos-selection-candidate'));
      root.querySelectorAll('.talos-selection-committed').forEach((element) => element.classList.remove('talos-selection-committed'));
      for (const candidate of selectionCandidates) {
        const candidateKey = candidate.target.element;
        if (candidateKey) root.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(candidateKey)}"]`)?.classList.add('talos-selection-candidate');
      }
      const selectionMatches = !!artifactSelection && !!preview
        && artifactSelection.sessionId === preview.sessionId && artifactSelection.path === preview.path;
      const committedTargets = selectionMatches
        ? artifactSelection.targets ?? [artifactSelection.target]
        : [];
      for (const target of committedTargets) {
        if (target.element) root.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(target.element)}"]`)?.classList.add('talos-selection-committed');
      }
    };
    applyClasses();
    const observer = new MutationObserver(() => {
      applyClasses();
      setSelectionLayoutVersion((value) => value + 1);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [artifactSelection, preview, selectionCandidates]);

  useEffect(() => {
    const update = () => {
      const resolveElement = (candidate: BoxSelectionCandidate) => (
        candidate.target.element
          ? selectionRoot.current?.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(candidate.target.element)}"]`) ?? candidate.element
          : candidate.element
      );
      let elements = selectionCandidates.length > 1
        ? selectionCandidates.map(resolveElement)
        : [];
      const selectionMatches = !!artifactSelection && !!preview
        && artifactSelection.sessionId === preview.sessionId && artifactSelection.path === preview.path;
      if (!elements.length && selectionMatches && artifactSelection.targets && artifactSelection.targets.length > 1) {
        elements = artifactSelection.targets.map((target) => (
          target.element
            ? selectionRoot.current?.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(target.element)}"]`)
            : null
        )).filter((element): element is HTMLElement => !!element);
        if (elements.length < 2) elements = committedElements.current;
      }
      const rects = elements.filter((element) => element.isConnected).map((element) => {
        const rect = element.getBoundingClientRect();
        const frame = element.ownerDocument.defaultView?.frameElement;
        if (!(frame instanceof HTMLElement)) return rect;
        const frameRect = frame.getBoundingClientRect();
        return new DOMRect(frameRect.left + rect.left, frameRect.top + rect.top, rect.width, rect.height);
      });
      if (rects.length < 2) { setGroupRect(null); return; }
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      setGroupRect(new DOMRect(left, top, right - left, bottom - top));
    };
    update();
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.addEventListener('talos-selection-layout', update);
    return () => {
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('talos-selection-layout', update);
    };
  }, [artifactSelection, preview, selectionCandidates, selectionLayoutVersion]);

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

  const targetFromElement = (element: Element | null, quote?: string): ArtifactSelectionTarget => {
    const page = element?.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber;
    const cell = element?.closest<HTMLElement>('[data-cell]');
    const slide = element?.closest<HTMLElement>('[data-slide]')?.dataset.slide;
    let marked = element?.closest<HTMLElement>('[data-artifact-element]');
    if (!marked && element instanceof HTMLElement) {
      element.dataset.artifactElement = `box-${crypto.randomUUID()}`;
      marked = element;
    }
    return {
      type: 'element',
      quote: (element as HTMLElement | null)?.dataset.selectionQuote?.slice(0, 4000) || quote?.trim().slice(0, 4000) || undefined,
      page: page ? Number(page) : undefined,
      sheet: cell?.dataset.sheet,
      cell: cell?.dataset.cell,
      slide: slide ? Number(slide) : undefined,
      element: marked?.dataset.artifactElement,
    };
  };

  const chooseCandidate = (target: ArtifactSelectionTarget, element: HTMLElement, additive = false) => {
    setSelectionCandidates((current) => {
      if (!additive) {
        current.forEach((candidate) => candidate.element.classList.remove('talos-selection-candidate'));
        element.classList.add('talos-selection-candidate');
        return [{ target, element }];
      }
      const targetKey = `${target.page ?? ''}|${target.sheet ?? ''}|${target.cell ?? ''}|${target.slide ?? ''}|${target.element ?? ''}|${target.quote ?? ''}`;
      const existing = current.findIndex((candidate) => (
        `${candidate.target.page ?? ''}|${candidate.target.sheet ?? ''}|${candidate.target.cell ?? ''}|${candidate.target.slide ?? ''}|${candidate.target.element ?? ''}|${candidate.target.quote ?? ''}` === targetKey
      ));
      if (existing >= 0) {
        current[existing].element.classList.remove('talos-selection-candidate');
        element.classList.remove('talos-selection-candidate');
        return current.filter((_, index) => index !== existing);
      }
      if (current.length >= 20) return current;
      element.classList.add('talos-selection-candidate');
      return [...current, { target, element }];
    });
  };

  const captureElement = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!markMode) return;
    const clicked = event.target instanceof Element ? event.target : null;
    const smallest = clicked?.closest<HTMLElement>('[data-selection-box], [data-cell], td, th, [data-artifact-element^="shape-"], p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, img');
    const promoted = clicked?.closest<HTMLElement>('table, figure[data-slide], [data-page-number]');
    const element = smallest ?? promoted;
    if (!element || !selectionRoot.current?.contains(element)) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    const quote = element instanceof HTMLImageElement ? undefined : element.innerText.trim();
    chooseCandidate(targetFromElement(element, quote), element, event.shiftKey);
  };

  const commitSelection = () => {
    if (!selectionCandidates.length || !preview) return;
    const targets = selectionCandidates.map((candidate) => candidate.target);
    setArtifactSelection({
      sessionId: preview.sessionId,
      path: preview.path,
      name: preview.name,
      mime: preview.mime,
      version: preview.version,
      kind,
      target: targets[0],
      targets,
    });
    selectionCandidates.forEach((candidate) => candidate.element.classList.remove('talos-selection-candidate'));
    committedElements.current.forEach((element) => element.classList.remove('talos-selection-committed'));
    selectionCandidates.forEach((candidate) => candidate.element.classList.add('talos-selection-committed'));
    committedElements.current = selectionCandidates.map((candidate) => candidate.element);
    setSelectionCandidates([]);
    window.getSelection()?.removeAllRanges();
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
      {!loading && !error && !editing && loaded && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card px-2">
          <button type="button" aria-pressed={markMode} onClick={() => { setMarkMode((value) => !value); selectionCandidates.forEach((candidate) => candidate.element.classList.remove('talos-selection-candidate')); setSelectionCandidates([]); }} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${markMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
            <MousePointer2Icon className="size-3.5" />{t('preview.markElement')}
          </button>
          {selectionCandidates.length > 0 && (
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <span className="max-w-48 truncate text-xs text-muted-foreground">{selectionCandidates.length > 1 ? `${selectionCandidates.length} ${t('preview.selectedElements')}` : selectionCandidates[0].target.quote || selectionCandidates[0].target.cell || selectionCandidates[0].target.element || t('preview.selectedElement')}</span>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={commitSelection} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"><CheckIcon className="size-3" />{t('preview.addToPrompt')}</button>
              <button type="button" onClick={() => { selectionCandidates.forEach((candidate) => candidate.element.classList.remove('talos-selection-candidate')); setSelectionCandidates([]); }} aria-label={t('common.cancel')} className="rounded-md p-1 text-muted-foreground hover:bg-accent"><XIcon className="size-3.5" /></button>
            </div>
          )}
        </div>
      )}
      <div ref={selectionRoot} onClickCapture={captureElement} className={`min-h-0 flex-1 overflow-auto ${markMode ? 'talos-mark-mode cursor-crosshair select-none' : ''}`}>
      {loading && <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
      {error && <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>}
      {!loading && !error && editing && (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="h-full min-h-96 w-full resize-none bg-background p-4 font-mono text-[13px] leading-relaxed outline-none" spellCheck={false} />
      )}
       {!loading && !error && !editing && loaded && <PreviewBody loaded={loaded} preview={preview} markMode={markMode} onBoxCandidate={chooseCandidate} committedTargets={artifactSelection && artifactSelection.sessionId === preview.sessionId && artifactSelection.path === preview.path ? artifactSelection.targets ?? [artifactSelection.target] : []} />}
      </div>
      {groupRect && <div className="pointer-events-none fixed z-50 rounded-sm border-2 border-primary bg-primary/[0.03] shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_14%,transparent)]" style={{ left: groupRect.left - 4, top: groupRect.top - 4, width: groupRect.width + 8, height: groupRect.height + 8 }} />}
    </div>
  );
}

/** Renders a real .docx with docx-preview inside an ISOLATED iframe. The library
 *  reads the document's own styles, fonts, sizes and page geometry and lays it
 *  out as actual paper pages (like Word / the Claude app). The iframe is what
 *  makes it faithful: rendered into the app's DOM, the global CSS reset (Tailwind
 *  preflight) strips table borders, overrides fonts, and flattens spacing. An
 *  iframe has its own clean document, so only docx-preview's own styles apply.
 *  The iframe fills the panel and scrolls its own content, so a "current / total"
 *  page badge can float over a fixed viewport (bottom-left) and update on scroll. */
function WordDocument({ blob, markMode, onBoxCandidate, committedTargets }: { blob: Blob; markMode: boolean; onBoxCandidate: (target: ArtifactSelectionTarget, element: HTMLElement, additive?: boolean) => void; committedTargets: ArtifactSelectionTarget[] }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const markModeRef = useRef(markMode);
  const onBoxCandidateRef = useRef(onBoxCandidate);
  markModeRef.current = markMode;
  onBoxCandidateRef.current = onBoxCandidate;
  const [error, setError] = useState(false);
  const [page, setPage] = useState<{ cur: number; total: number }>({ cur: 1, total: 0 });

  useEffect(() => {
    let cancelled = false;
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    setError(false);
    setPage({ cur: 1, total: 0 });
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
        const win = frame.contentWindow;
        if (!win) return;
        const pages = () => Array.from(frame.contentDocument?.querySelectorAll('section.docx') ?? []);
        setPage({ cur: 1, total: pages().length });
        // Current page = the last page whose top has scrolled above a marker line
        // ~30% down the viewport (so a page counts as "current" once it dominates
        // the view). Recomputed cheaply on each scroll/resize via rAF.
        let raf = 0;
        const update = () => {
          raf = 0;
          const secs = pages();
          if (!secs.length || cancelled) return;
          const marker = (frame.contentDocument?.documentElement.clientHeight ?? 0) * 0.3;
          let cur = 1;
          for (let i = 0; i < secs.length; i++) {
            if (secs[i].getBoundingClientRect().top <= marker) cur = i + 1;
            else break;
          }
          setPage({ cur, total: secs.length });
        };
        const onScroll = () => {
          if (!raf) raf = win.requestAnimationFrame(update);
          window.dispatchEvent(new Event('talos-selection-layout'));
        };
        const style = idoc.createElement('style');
        style.textContent = '.talos-selection-candidate{outline:2px solid #3d87cb;outline-offset:2px}.talos-selection-committed{outline:2px solid #3d87cb;outline-offset:2px;box-shadow:0 0 0 3px rgb(61 135 203 / 18%)}';
        idoc.head.appendChild(style);
        pages().forEach((section, pageIndex) => {
          section.querySelectorAll<HTMLElement>('td, th, p, h1, h2, h3, h4, h5, h6, li, img, table').forEach((element, elementIndex) => {
            element.dataset.artifactElement ||= `word-page-${pageIndex + 1}-box-${elementIndex + 1}`;
          });
        });
        for (const target of committedTargets) {
          if (target.element) idoc.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(target.element)}"]`)?.classList.add('talos-selection-committed');
        }
        const onClick = (event: MouseEvent) => {
          if (!markModeRef.current) return;
          const clicked = event.target instanceof Element ? event.target : null;
          const smallest = clicked?.closest<HTMLElement>('td, th, p, h1, h2, h3, h4, h5, h6, li, img');
          const promoted = clicked?.closest<HTMLElement>('table, section.docx');
          const element = smallest ?? promoted;
          if (!element) return;
          event.preventDefault();
          event.stopPropagation();
          win.getSelection()?.removeAllRanges();
          const section = element.closest('section.docx');
          const pageNumber = section ? pages().indexOf(section) + 1 : undefined;
          const quote = element instanceof HTMLImageElement ? undefined : element.innerText.trim().slice(0, 4000);
          onBoxCandidateRef.current({ type: 'element', quote, page: pageNumber || undefined, element: element.dataset.artifactElement }, element, event.shiftKey);
        };
        win.addEventListener('scroll', onScroll, { passive: true });
        idoc.addEventListener('click', onClick, true);
        window.addEventListener('resize', onScroll);
        cleanupRef.current = () => {
          win.removeEventListener('scroll', onScroll);
          idoc.removeEventListener('click', onClick, true);
          window.removeEventListener('resize', onScroll);
          if (raf) win.cancelAnimationFrame(raf);
        };
        update();
        // Re-measure once images/fonts settle (may change page count/offsets).
        window.setTimeout(update, 400);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = undefined;
    };
  }, [blob]);

  useEffect(() => {
    const idoc = frameRef.current?.contentDocument;
    if (!idoc) return;
    idoc.querySelectorAll('.talos-selection-committed').forEach((element) => element.classList.remove('talos-selection-committed'));
    for (const target of committedTargets) {
      if (target.element) idoc.querySelector<HTMLElement>(`[data-artifact-element="${CSS.escape(target.element)}"]`)?.classList.add('talos-selection-committed');
    }
  }, [committedTargets]);

  return (
    <div className="relative h-full bg-muted/40">
      {error && <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>}
      <iframe ref={frameRef} title="Word document" className="block h-full w-full border-0" />
      {page.total > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border bg-background/90 px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground shadow-sm backdrop-blur">
          {t('preview.pageOf', { cur: page.cur, total: page.total, defaultValue: '{{cur}} / {{total}}' })}
        </div>
      )}
    </div>
  );
}

function PreviewBody({ loaded, preview, markMode, onBoxCandidate, committedTargets }: { loaded: Loaded; preview: PreviewFile; markMode: boolean; onBoxCandidate: (target: ArtifactSelectionTarget, element: HTMLElement, additive?: boolean) => void; committedTargets: ArtifactSelectionTarget[] }) {
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
    return <div className="min-h-full bg-muted/40 p-3"><SpreadsheetGrid rows={loaded.rows} sheet="CSV" startRow={0} startCol={0} /></div>;
  }
  if (loaded.kind === 'excel') {
    return <ExcelView sheets={loaded.sheets} />;
  }
  if (loaded.kind === 'word') {
    return <WordDocument blob={loaded.blob} markMode={markMode} onBoxCandidate={onBoxCandidate} committedTargets={committedTargets} />;
  }
  if (loaded.kind === 'presentation') {
    return (
      <div className="space-y-5 bg-muted/40 p-4">
        {loaded.slides.map((slide, index) => (
          <figure key={index} data-slide={index + 1} data-artifact-element={`slide-${index + 1}`} className="mx-auto w-full max-w-4xl">
            <section className="flex aspect-video w-full flex-col overflow-auto rounded-lg border bg-white p-8 text-slate-900 shadow-sm ring-1 ring-black/5">
              <div className="space-y-3">
                {slide.texts.map((element, i) => i === 0
                  ? <h2 key={element.id} data-artifact-element={`slide-${index + 1}-shape-${element.id}`} title={element.name} className="text-2xl font-semibold leading-tight">{element.text}</h2>
                  : <p key={element.id} data-artifact-element={`slide-${index + 1}-shape-${element.id}`} title={element.name} className="text-base leading-relaxed">{element.text}</p>)}
              </div>
              {slide.images.length > 0 && <div className="mt-5 grid grid-cols-2 gap-3">{slide.images.map((element) => <img key={element.id} src={element.src} alt={element.name} data-artifact-element={`slide-${index + 1}-shape-${element.id}`} className="max-h-64 w-full object-contain" />)}</div>}
            </section>
            <figcaption className="mt-1.5 text-center text-[11px] font-medium text-muted-foreground">{index + 1} / {loaded.slides.length}</figcaption>
          </figure>
        ))}
      </div>
    );
  }
  if (loaded.kind === 'pdf') {
    return (
      <PdfViewer
        blob={loaded.blob}
        name={preview.name}
        onDownload={() => { void downloadArtifact(preview.sessionId, preview.path, preview.name); }}
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-muted/40 p-4">
      <img src={loaded.url} alt={preview.name} data-artifact-element="image" className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
    </div>
  );
}

function ExcelView({ sheets }: { sheets: { name: string; rows: string[][]; startRow: number; startCol: number }[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/40">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {sheet && sheet.rows.length > 0 ? <SpreadsheetGrid rows={sheet.rows} sheet={sheet.name} startRow={sheet.startRow} startCol={sheet.startCol} /> : (
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
function SpreadsheetGrid({ rows, sheet, startRow, startCol }: { rows: string[][]; sheet: string; startRow: number; startCol: number }) {
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
              <th key={i} className="sticky top-0 z-10 min-w-[84px] border border-border/70 bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground">{columnLabel(i + startCol)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <th className="sticky left-0 z-10 border border-border/70 bg-muted px-2 py-1 text-center text-xs font-normal text-muted-foreground">{ri + startRow + 1}</th>
              {colIdx.map((ci) => (
                <td key={ci} data-sheet={sheet} data-cell={`${columnLabel(ci + startCol)}${ri + startRow + 1}`} data-artifact-element={`${sheet}!${columnLabel(ci + startCol)}${ri + startRow + 1}`} className="max-w-[28rem] truncate border border-border/60 px-2 py-1 align-top" title={r[ci] ?? ''}>{r[ci] ?? ''}</td>
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
