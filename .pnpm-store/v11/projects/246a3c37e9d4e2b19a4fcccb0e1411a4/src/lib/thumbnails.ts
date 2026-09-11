/** Thumbnails for file tiles (attachments, artifact cards).
 *
 *  A tile is 56–168px wide; the file behind it can be a 12 MP photo or a 40-page
 *  PDF. Handing the full file to an <img> means a full-resolution decode per
 *  tile on every mount, and a PDF tile means downloading and parsing the whole
 *  document — with a strip of them that lands as visible jank while scrolling.
 *
 *  So each tile is downscaled once to a small data URL and kept in a module-level
 *  cache: remounting a tile (scroll, re-render, reopening a session) is then a
 *  cheap <img> of a few KB. Work starts only when the tile is near the viewport,
 *  runs at most two at a time, and shares one pdf.js worker across all PDFs. */

import { useEffect, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { previewKind } from '@/lib/files';

/** Rendered thumbnails, keyed by source URL + box size. Bounded and LRU-ish:
 *  entries are a few KB each, but a long session shouldn't grow without end. */
const CACHE_LIMIT = 150;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function remember(key: string, dataUrl: string) {
  cache.delete(key);
  cache.set(key, dataUrl);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** At most two thumbnails in flight: decoding and PDF rasterising are the
 *  expensive part, and a screenful of tiles starting at once is what makes the
 *  scroll stutter. */
const LANES = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function lane<T>(run: () => Promise<T>): Promise<T> {
  if (active >= LANES) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** One pdf.js worker for every thumbnail, instead of one per document. */
let workerPromise: Promise<{ pdfjs: typeof import('pdfjs-dist'); worker: PDFWorker }> | null = null;

function pdfRuntime() {
  workerPromise ??= (async () => {
    const [pdfjs, workerUrl] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
    return { pdfjs, worker: new pdfjs.PDFWorker() };
  })();
  return workerPromise;
}

function devicePixels(size: number): number {
  return Math.ceil(size * Math.min(window.devicePixelRatio || 1, 2));
}

function encode(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/webp', 0.82);
}

/** Cover-crop `source` into a `width`×`height` canvas — a letterboxed page or
 *  photo at tile size is mostly empty box, so scale past the box and crop. */
function cover(source: CanvasImageSource, sw: number, sh: number, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('no 2d context');
  const scale = Math.max(width / sw, height / sh);
  const cw = width / scale;
  const ch = height / scale;
  context.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, width, height);
  return encode(canvas);
}

async function imageThumb(url: string, width: number, height: number): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    // Already tile-sized (icons, small generated images): re-encoding would
    // cost more than it saves, so let the browser load the file itself.
    if (bitmap.width <= width && bitmap.height <= height) return url;
    return cover(bitmap, bitmap.width, bitmap.height, width, height);
  } finally {
    bitmap.close();
  }
}

async function pdfThumb(url: string, width: number, height: number): Promise<string> {
  const [{ pdfjs, worker }, res] = await Promise.all([
    pdfRuntime(),
    fetch(url, { credentials: 'same-origin' }),
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  let task: PDFDocumentLoadingTask | null = null;
  try {
    task = pdfjs.getDocument({ data, worker });
    const doc: PDFDocumentProxy = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.max(width / base.width, height / base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('no 2d context');
    // A PDF page is transparent where it is blank; without this it rasterises
    // onto black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return cover(canvas, canvas.width, canvas.height, width, height);
  } finally {
    // Destroys the document only: pdf.js tears down a worker here just when it
    // created one itself, and ours is passed in and shared.
    if (task) void task.destroy();
  }
}

function build(url: string, name: string, mime: string | undefined, width: number, height: number): Promise<string> {
  const kind = previewKind(name, mime);
  if (kind === 'pdf') return lane(() => pdfThumb(url, width, height));
  return lane(() => imageThumb(url, width, height));
}

/** Deduplicated across tiles: the same file shown twice renders once. */
function thumbnail(key: string, url: string, name: string, mime: string | undefined, width: number, height: number): Promise<string> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = inflight.get(key);
  if (!pending) {
    pending = build(url, name, mime, width, height)
      .then((dataUrl) => {
        remember(key, dataUrl);
        return dataUrl;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

export interface Thumbnail {
  /** Attach to the tile's box — generation waits until it is near the viewport. */
  ref: (node: HTMLElement | null) => void;
  /** Data URL once rendered; undefined while pending. */
  src?: string;
  /** Nothing renderable came back (offline, encrypted PDF, exotic image). */
  failed: boolean;
}

/** A downscaled face for `url`, generated lazily and cached across mounts. */
export function useThumbnail(url: string, name: string, mime: string | undefined, width: number, height: number): Thumbnail {
  const boxWidth = devicePixels(width);
  const boxHeight = devicePixels(height);
  const key = `${url}|${boxWidth}x${boxHeight}`;
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [src, setSrc] = useState<string | undefined>(() => cache.get(key));
  const [failed, setFailed] = useState(false);

  // A different file (or a resized box) starts over from whatever is cached.
  useEffect(() => {
    setSrc(cache.get(key));
    setFailed(false);
  }, [key]);

  useEffect(() => {
    if (!node || cache.has(key)) return;
    let cancelled = false;
    const start = () => {
      thumbnail(key, url, name, mime, boxWidth, boxHeight).then(
        (dataUrl) => { if (!cancelled) setSrc(dataUrl); },
        () => { if (!cancelled) setFailed(true); },
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => { cancelled = true; };
    }
    // Ahead of the viewport, so a tile is usually ready by the time it arrives.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        start();
      },
      { rootMargin: '300px' },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [node, key, url, name, mime, boxWidth, boxHeight]);

  return { ref: setNode, src, failed };
}
