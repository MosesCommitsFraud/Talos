import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  PrinterIcon,
  RotateCwIcon,
  SearchIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer as PdfTextLayer } from 'pdfjs-dist';
import { Button } from './ui/button';
import { Tooltip } from './ui/misc';

type PdfViewerProps = {
  blob: Blob;
  name: string;
  onDownload: () => void;
};

function buildPdfSelectionBoxes(textContainer: HTMLDivElement, boxContainer: HTMLDivElement, pageNumber: number) {
  boxContainer.replaceChildren();
  const pageRect = boxContainer.getBoundingClientRect();
  const spans = Array.from(textContainer.querySelectorAll<HTMLSpanElement>('span'))
    .map((span) => ({ span, rect: span.getBoundingClientRect(), text: span.textContent?.trim() ?? '' }))
    .filter((item) => item.text && item.rect.width > 1 && item.rect.height > 1)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const lines: typeof spans[] = [];
  for (const item of spans) {
    const center = item.rect.top + item.rect.height / 2;
    const line = lines.find((items) => {
      const first = items[0].rect;
      return Math.abs(center - (first.top + first.height / 2)) <= Math.max(first.height, item.rect.height) * 0.55;
    });
    if (line) line.push(item);
    else lines.push([item]);
  }
  let blockIndex = 0;
  for (const line of lines) {
    line.sort((a, b) => a.rect.left - b.rect.left);
    const runs: typeof spans[] = [];
    for (const item of line) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      if (!previous || item.rect.left - previous.rect.right > Math.max(20, item.rect.height * 2)) runs.push([item]);
      else run.push(item);
    }
    for (const run of runs) {
      const left = Math.min(...run.map((item) => item.rect.left)) - pageRect.left;
      const top = Math.min(...run.map((item) => item.rect.top)) - pageRect.top;
      const right = Math.max(...run.map((item) => item.rect.right)) - pageRect.left;
      const bottom = Math.max(...run.map((item) => item.rect.bottom)) - pageRect.top;
      const box = document.createElement('div');
      box.className = 'talos-pdf-selection-box absolute pointer-events-none';
      box.dataset.selectionBox = 'pdf-text';
      box.dataset.artifactElement = `pdf-text-${pageNumber}-${++blockIndex}`;
      box.dataset.selectionQuote = run.map((item) => item.text).join(' ');
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      boxContainer.appendChild(box);
    }
  }
}

function PageCanvas({ document, pageNumber, scale, fitWidth, availableWidth, rotation, scrollRoot, onElement, label, errorLabel, fallbackSize }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  fitWidth: boolean;
  availableWidth: number;
  rotation: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
  onElement: (element: HTMLDivElement | null) => void;
  label: string;
  errorLabel: string;
  fallbackSize: { width: number; height: number };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageError, setPageError] = useState(false);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const element = containerRef.current;
    const root = scrollRoot.current;
    if (!element || !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root, rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible || page) return;
    let cancelled = false;
    setPageError(false);
    void document.getPage(pageNumber).then((loadedPage) => {
      if (!cancelled) setPage(loadedPage);
    }).catch(() => { if (!cancelled) setPageError(true); });
    return () => { cancelled = true; };
  }, [document, page, pageNumber, visible]);

  const baseViewport = page?.getViewport({ scale: 1, rotation });
  const pageScale = fitWidth && baseViewport && availableWidth
    ? Math.max(0.25, availableWidth / baseViewport.width)
    : scale;

  useEffect(() => {
    if (!visible || !page) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let task: RenderTask | null = null;
    let textLayer: PdfTextLayer | null = null;
    let cancelled = false;
    setRendering(true);

    const viewport = page.getViewport({ scale: pageScale, rotation });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    void task.promise.then(() => {
      if (!cancelled) setRendering(false);
    }).catch((error: unknown) => {
      if (!cancelled && error instanceof Error && error.name !== 'RenderingCancelledException') setRendering(false);
    });
    const textContainer = textRef.current;
    const boxContainer = boxRef.current;
    if (textContainer && boxContainer) {
      textContainer.replaceChildren();
      boxContainer.replaceChildren();
      textContainer.style.width = `${viewport.width}px`;
      textContainer.style.height = `${viewport.height}px`;
      textContainer.style.setProperty('--scale-factor', String(pageScale));
      textContainer.style.setProperty('--user-unit', String(page.userUnit));
      textContainer.style.setProperty('--total-scale-factor', String(pageScale));
      void import('pdfjs-dist').then(async ({ TextLayer }) => {
        if (cancelled) return;
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: textContainer,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) buildPdfSelectionBoxes(textContainer, boxContainer, pageNumber);
      }).catch(() => undefined);
    }

    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
      boxContainer?.replaceChildren();
    };
  }, [page, pageScale, rotation, visible]);

  const width = baseViewport ? baseViewport.width * pageScale : fallbackSize.width;
  const height = baseViewport ? baseViewport.height * pageScale : fallbackSize.height;

  return (
    <div
      ref={(element) => { containerRef.current = element; onElement(element); }}
      style={{ width, height }}
      className="relative scroll-mt-4 bg-white shadow-md ring-1 ring-black/10"
      aria-label={label}
      data-page-number={pageNumber}
      data-artifact-element={`page-${pageNumber}`}
    >
      {visible && (
        <>
          {pageError
            ? <div className="flex h-full items-center justify-center px-4 text-xs text-destructive-foreground">{errorLabel}</div>
            : <><canvas ref={canvasRef} className="block max-w-none" /><div ref={textRef} className="talos-pdf-text-layer" /><div ref={boxRef} className="pointer-events-none absolute inset-0 z-[2]" />{rendering && <div className="absolute inset-0 animate-pulse bg-white" />}</>}
        </>
      )}
    </div>
  );
}

export function PdfViewer({ blob, name, onDownload }: PdfViewerProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const searchToken = useRef(0);
  const lastSearch = useRef('');
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [firstPage, setFirstPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [searchResultPage, setSearchResultPage] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    searchToken.current++;
    setDocument(null);
    setFirstPage(null);
    setError(false);
    setSearching(false);
    setNoResults(false);
    setSearchResultPage(null);
    setCurrentPage(1);
    setPageInput('1');
    void (async () => {
      try {
        const [pdfjs, workerModule, data] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
          blob.arrayBuffer(),
        ]);
        if (cancelled) return;
        const workerSrc = workerModule.default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        loadingTask = pdfjs.getDocument({ data });
        loaded = await loadingTask.promise;
        const loadedFirstPage = await loaded.getPage(1);
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        setDocument(loaded);
        setFirstPage(loadedFirstPage);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      searchToken.current++;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  useEffect(() => {
    const stage = scrollRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = scrollRef.current;
    if (!stage || !document) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const marker = stage.getBoundingClientRect().top + stage.clientHeight * 0.35;
      let page = 1;
      for (const [number, element] of pageElements.current) {
        if (element.getBoundingClientRect().top <= marker) page = number;
        else break;
      }
      setCurrentPage(page);
      setPageInput(String(page));
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    stage.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      stage.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [document, rotation, stageWidth, zoom, fitWidth]);

  const firstViewport = firstPage?.getViewport({ scale: 1, rotation });
  const fittedScale = firstViewport && stageWidth
    ? Math.max(0.25, stageWidth / firstViewport.width)
    : 1;
  const scale = fitWidth ? fittedScale : zoom;

  const goToPage = (page: number) => {
    const target = Math.min(Math.max(Math.round(page), 1), document?.numPages || 1);
    pageElements.current.get(target)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    setCurrentPage(target);
    setPageInput(String(target));
  };

  const applyPageInput = () => goToPage(Number(pageInput) || currentPage);

  const changeZoom = (next: number) => {
    setFitWidth(false);
    setZoom(Math.min(3, Math.max(0.25, next)));
  };

  const findNext = async () => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || !document || searching) return;
    const token = ++searchToken.current;
    const startOffset = lastSearch.current === needle ? 1 : 0;
    lastSearch.current = needle;
    setSearching(true);
    setNoResults(false);
    setSearchResultPage(null);
    try {
      for (let step = 0; step < document.numPages; step++) {
        const offset = startOffset + step;
        const number = ((currentPage - 1 + offset) % document.numPages) + 1;
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        if (searchToken.current !== token) return;
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .toLocaleLowerCase();
        if (text.includes(needle)) {
          setSearchResultPage(number);
          goToPage(number);
          return;
        }
      }
      setNoResults(true);
    } catch {
      // The worker rejects outstanding text requests when the file changes.
    } finally {
      if (searchToken.current === token) setSearching(false);
    }
  };

  const print = () => {
    const url = URL.createObjectURL(blob);
    const frame = window.document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.src = url;
    frame.onload = () => window.setTimeout(() => frame.contentWindow?.print(), 300);
    window.document.body.appendChild(frame);
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  if (error) {
    return <p className="px-4 py-6 text-center text-xs text-destructive-foreground">{t('preview.error')}</p>;
  }

  const loading = !document;
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40" role="region" aria-label={name}>
      <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-2 shadow-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Tooltip label={t('preview.previousPage')}>
          <Button variant="ghost-muted" size="icon-sm" onClick={() => goToPage(currentPage - 1)} disabled={loading || currentPage <= 1} aria-label={t('preview.previousPage')}><ChevronLeftIcon /></Button>
        </Tooltip>
        <div className="flex h-7 min-w-14 items-center justify-center gap-1 rounded-lg border bg-background px-2 text-xs leading-none tabular-nums shadow-xs">
          <input
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))}
            onBlur={applyPageInput}
            onKeyDown={(event) => { if (event.key === 'Enter') applyPageInput(); }}
            aria-label={t('preview.pageNumber')}
            style={{ width: `${Math.max(pageInput.length, 1)}ch` }}
            className="h-full min-w-0 bg-transparent p-0 text-center leading-none outline-none"
          />
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">{document?.numPages || '–'}</span>
        </div>
        <Tooltip label={t('preview.nextPage')}>
          <Button variant="ghost-muted" size="icon-sm" onClick={() => goToPage(currentPage + 1)} disabled={loading || currentPage >= (document?.numPages || 1)} aria-label={t('preview.nextPage')}><ChevronRightIcon /></Button>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-border" />
        <Tooltip label={t('preview.zoomOut')}>
          <Button variant="ghost-muted" size="icon-sm" onClick={() => changeZoom(scale - 0.1)} disabled={loading || scale <= 0.25} aria-label={t('preview.zoomOut')}><ZoomOutIcon /></Button>
        </Tooltip>
        <button type="button" onClick={() => changeZoom(1)} className="min-w-11 rounded-md px-1 py-1 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground">{Math.round(scale * 100)}%</button>
        <Tooltip label={t('preview.zoomIn')}>
          <Button variant="ghost-muted" size="icon-sm" onClick={() => changeZoom(scale + 0.1)} disabled={loading || scale >= 3} aria-label={t('preview.zoomIn')}><ZoomInIcon /></Button>
        </Tooltip>
        <Tooltip label={t('preview.fitWidth')}>
          <Button variant={fitWidth ? 'secondary' : 'ghost-muted'} size="icon-sm" onClick={() => setFitWidth(true)} disabled={loading} aria-label={t('preview.fitWidth')}><Maximize2Icon /></Button>
        </Tooltip>

        <div className="ml-auto flex items-center gap-1">
          <div className="relative hidden md:block">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => { searchToken.current++; setSearching(false); setQuery(event.target.value); setNoResults(false); setSearchResultPage(null); lastSearch.current = ''; }}
              onKeyDown={(event) => { if (event.key === 'Enter') void findNext(); }}
              placeholder={noResults ? t('preview.noResults') : t('preview.search')}
              aria-label={t('preview.search')}
              className={`h-7 w-28 rounded-lg border bg-background pl-7 pr-6 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${searchResultPage ? 'border-primary bg-primary/5' : ''}`}
            />
            <button type="button" onClick={() => void findNext()} disabled={!query.trim() || searching} aria-label={t('preview.findNext')} className="absolute right-0 top-0 flex size-7 items-center justify-center text-muted-foreground disabled:opacity-40">
              {searching ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <ChevronDownIcon className="size-3.5" />}
            </button>
            <span className="sr-only" aria-live="polite">{noResults ? t('preview.noResults') : searchResultPage ? t('preview.matchOnPage', { page: searchResultPage }) : ''}</span>
          </div>
          <Tooltip label={t('preview.rotate')}>
            <Button variant="ghost-muted" size="icon-sm" onClick={() => setRotation((value) => (value + 90) % 360)} disabled={loading} aria-label={t('preview.rotate')}><RotateCwIcon /></Button>
          </Tooltip>
          <Tooltip label={t('preview.print')}>
            <Button variant="ghost-muted" size="icon-sm" onClick={print} disabled={loading} aria-label={t('preview.print')}><PrinterIcon /></Button>
          </Tooltip>
          <Tooltip label={t('preview.download')}>
            <Button variant="ghost-muted" size="icon-sm" onClick={onDownload} aria-label={t('preview.download')}><DownloadIcon /></Button>
          </Tooltip>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scroll-smooth p-4">
        {loading && <div className="flex h-full items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" /></div>}
        <div className="flex min-w-max flex-col items-center gap-4">
          {document && firstViewport && Array.from({ length: document.numPages }, (_, index) => (
            <PageCanvas
              key={index}
              document={document}
              pageNumber={index + 1}
              scale={scale}
              fitWidth={fitWidth}
              availableWidth={stageWidth}
              rotation={rotation}
              scrollRoot={scrollRef}
              label={t('preview.pageLabel', { page: index + 1 })}
              errorLabel={t('preview.pageError')}
              fallbackSize={{ width: firstViewport.width * scale, height: firstViewport.height * scale }}
              onElement={(element) => { if (element) pageElements.current.set(index + 1, element); else pageElements.current.delete(index + 1); }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
