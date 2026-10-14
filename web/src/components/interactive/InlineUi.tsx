import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangleIcon,
  BrainIcon,
  CodeIcon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  GlobeIcon,
  MapIcon,
  ImageIcon,
  Maximize2Icon,
  SigmaIcon,
  SparklesIcon,
  UserIcon,
} from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { builtinView } from '@/lib/builtinViews';
import { toast } from '@/components/ui/toast';
import { Markdown } from '@/components/Markdown';
import { requestHtmlPng, savePreviewBlob } from '@/lib/htmlExport';
import {
  buildUiDocument,
  clampHeight,
  loadUiEnv,
  loadUiLibraries,
  type UiLibCode,
  readAppTheme,
  readUiPayload,
  safeExternalUrl,
  themeMessage,
  type UiPayload,
  type UiSource,
  type UiTheme,
  type UiEnv,
  uiLibraries,
  previewMessage,
} from '@/lib/uiFrame';
import { useChat } from '@/state/chat';
import type { WidgetProps } from '@/components/widgets/registry';

const SHELL_URL = '/api/ui-shell';

/** Every http(s) URL written literally anywhere in a UI's payload, normalised
 *  the way safeExternalUrl returns them. */
function literalLinks(ui: UiPayload): Set<string> {
  const text = [ui.html, ui.js, ...ui.jsInit, JSON.stringify(ui.data ?? null), ...ui.sources.map((s) => s.ref ?? '')].join('\n');
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) {
    const url = safeExternalUrl(m[0]);
    if (url) out.add(url);
  }
  return out;
}

/** Did the user just act on this page (a click or key press, including one
 *  inside a frame — activation propagates to ancestor frames)? Each gesture
 *  is honoured once: a second message riding the same click is refused, so a
 *  single click cannot send a burst of prompts. Without the API (old
 *  browsers) the answer is no — the safe default. */
let lastConsumed = 0;
function hostActivated(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (!ua?.isActive) return false;
  const now = Date.now();
  if (now - lastConsumed < 1500) return false;
  lastConsumed = now;
  return true;
}

/** Live app theme (applyTheme toggles .dark on <html>). */
function useAppTheme(): UiTheme {
  const [theme, setTheme] = useState(readAppTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readAppTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-brand'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Font and config every frame needs; fetched once per page load. */
function useUiEnv(): UiEnv | null {
  const [env, setEnv] = useState<UiEnv | null>(null);
  useEffect(() => {
    let alive = true;
    void loadUiEnv().then((e) => { if (alive) setEnv(e); });
    return () => { alive = false; };
  }, []);
  return env;
}

/** Mount the frame only once it comes near the viewport. A long chat can hold
 *  dozens of interactive answers; running all their scripts at once on load
 *  would make the whole page sluggish for answers nobody is looking at. Once
 *  mounted it stays mounted, so scrolling past does not reset what the user
 *  set on the sliders. */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    // The chat scrolls inside its own container, and with the implicit root an
    // element clipped by that container never intersects — rootMargin only
    // widens the viewport. Observing against the container makes the margin
    // actually preload the frames just above and below what is on screen.
    let root: HTMLElement | null = el.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { root, rootMargin: '600px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

interface FrameError { phase: string; message: string }

/** Control state per UI (slider values, switches …) reported by its frames.
 *  A UI is rebuilt more than once — when the turn settles and it moves above
 *  the answer, when it opens full screen — and the new copy picks up where the
 *  user left the old one. Lives for the page session only. */
const uiStates = new Map<string, Record<string, unknown>>();

/** talos.store per UI: kept in this browser (localStorage), so a todo list or
 *  a counter is still there after a reload. Keyed like uiStates. */
const STORE_PREFIX = 'talos:ui-store:';
function loadStore(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function saveStore(key: string, value: Record<string, unknown>) {
  try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* full or blocked: the view keeps working for this session */ }
}
const DOWNLOAD_TYPES: Record<string, string> = {
  csv: 'text/csv', json: 'application/json', md: 'text/markdown', txt: 'text/plain', ics: 'text/calendar', tsv: 'text/tab-separated-values', svg: 'image/svg+xml',
};

/** Identity of a UI across rebuilds: same markup, same script, same title. */
export function uiStateKey(ui: UiPayload): string {
  const text = `${ui.title}\u0000${ui.html}\u0000${ui.js}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

/** One sandboxed frame. The document is built once per payload; theme changes
 *  are posted into the live frame so the UI keeps its state.
 *
 *  `preview` is the streaming mode: the frame gets the markup written so far,
 *  without running any script, and is updated in place as more arrives. */
export function UiFrame({
  ui,
  fill = false,
  frameRef,
  onErrors,
  onReady,
  preview = false,
}: {
  ui: UiPayload;
  fill?: boolean;
  frameRef?: React.MutableRefObject<HTMLIFrameElement | null>;
  onErrors?: (errors: FrameError[]) => void;
  onReady?: () => void;
  preview?: boolean;
}) {
  const { t } = useTranslation();
  const theme = useAppTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(ui.initialHeight);
  const [ready, setReady] = useState(false);
  const [placeholder, setPlaceholder] = useState(0);
  const errors = useRef<FrameError[]>([]);
  const onErrorsRef = useRef(onErrors);
  onErrorsRef.current = onErrors;
  // The embedded font arrives asynchronously (once per page load); the
  // document waits for it rather than rendering twice.
  const env = useUiEnv();
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const stateKey = useMemo(() => (preview ? '' : uiStateKey(ui)), [ui, preview]);
  // A preview's document is built once, from the first snapshot; later markup
  // is posted into it rather than rebuilding (which would reload the frame on
  // every token).
  const firstUi = useRef(ui);
  const docUi = preview ? firstUi.current : ui;
  // Library code is embedded in the document (see loadUiLibraries), so it is
  // fetched before the document is built. `undefined` = still loading.
  const [libCode, setLibCode] = useState<UiLibCode | null | undefined>(preview ? null : undefined);
  useEffect(() => {
    if (preview) return;
    let alive = true;
    void loadUiLibraries(docUi).then((code) => { if (alive) setLibCode(code); });
    return () => { alive = false; };
  }, [docUi, preview]);
  // Baked with the theme current at build time; later switches are posted.
  const doc = useMemo(
    () => (env === null || libCode === undefined ? null : buildUiDocument(docUi, themeRef.current, {
      env,
      preview,
      libCode,
      restore: stateKey ? uiStates.get(stateKey) ?? null : null,
      store: stateKey ? loadStore(stateKey) : null,
    })),
    // The restore snapshot is read once per build on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docUi, env, preview, libCode],
  );
  const delivered = useRef(false);
  const shellReady = useRef(false);

  const deliver = () => {
    const target = frame.current?.contentWindow;
    if (!target || !doc || !shellReady.current || delivered.current) return;
    delivered.current = true;
    target.postMessage({ type: 'talos:ui-document', html: doc }, '*');
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  const stateKeyRef = useRef(stateKey);
  stateKeyRef.current = stateKey;
  const fillRef = useRef(fill);
  fillRef.current = fill;
  const writtenLinks = useRef(new Set<string>());
  writtenLinks.current = useMemo(() => literalLinks(ui), [ui]);
  const latestUi = useRef(ui);
  latestUi.current = ui;

  // Live data: the frame names a declared source and parameter values; the
  // request runs under the user's session (the frame has neither cookies nor
  // network) and the server only re-runs the stored spec. A newer request for
  // the same source cancels the older one — a dragged slider wants the last
  // value, not every value in between.
  const inflight = useRef(new Map<string, AbortController>());
  const refreshData = async (reqId: string, sourceId: string, params: unknown) => {
    const reply = (body: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage({ type: 'talos:ui-data-response', reqId, ...body }, '*');
    const current = latestUi.current;
    if (!current.uiId || !current.dataSources?.some((s) => s.id === sourceId)) {
      reply({ ok: false, error: `Unknown data source "${sourceId}".` });
      return;
    }
    inflight.current.get(sourceId)?.abort();
    const controller = new AbortController();
    inflight.current.set(sourceId, controller);
    try {
      const res = await fetch('/api/ui/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ uiId: current.uiId, sourceId, params: params && typeof params === 'object' ? params : {} }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) reply({ ok: false, error: typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}` });
      else reply({ ok: true, data: body.data });
    } catch (e) {
      if (controller.signal.aborted) reply({ ok: false, error: 'superseded' });
      else reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (inflight.current.get(sourceId) === controller) inflight.current.delete(sourceId);
    }
  };
  useEffect(() => () => { for (const c of inflight.current.values()) c.abort(); }, []);

  const sendPrompt = (text: string) => {
    const chat = useChat.getState();
    if (chat.streaming) { toast('interactive.busy'); return; }
    void chat.send(text);
  };
  const sendRef = useRef(sendPrompt);
  sendRef.current = sendPrompt;

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Opaque frames report origin "null"; the window identity is the check.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'talos:ui-shell-ready':
          // A ready message always comes from a FRESH shell (it stops
          // listening after the first document), so whatever an earlier load
          // received is gone — deliver again.
          shellReady.current = true;
          delivered.current = false;
          deliverRef.current();
          break;
        case 'talos:ui-resize':
          if (typeof msg.height === 'number') setHeight(clampHeight(msg.height));
          break;
        case 'talos:ui-ready':
          setReady(true);
          if (fillRef.current) frame.current?.contentWindow?.postMessage({ type: 'talos:ui-fill', fill: true }, '*');
          onReadyRef.current?.();
          break;
        case 'talos:ui-state':
          if (stateKeyRef.current && msg.state && typeof msg.state === 'object' && JSON.stringify(msg.state).length < 50_000) {
            uiStates.set(stateKeyRef.current, msg.state as Record<string, unknown>);
          }
          break;
        case 'talos:ui-store':
          if (stateKeyRef.current && msg.store && typeof msg.store === 'object' && !Array.isArray(msg.store) && JSON.stringify(msg.store).length <= 100_000) {
            saveStore(stateKeyRef.current, msg.store as Record<string, unknown>);
          }
          break;
        case 'talos:ui-copy':
          if (!hostActivated()) { toast('interactive.needsClick'); break; }
          if (typeof msg.text === 'string') {
            void navigator.clipboard.writeText(msg.text.slice(0, 200_000)).then(
              () => toast('interactive.copied'),
              () => toast('interactive.copyFailed'),
            );
          }
          break;
        case 'talos:ui-download': {
          if (!hostActivated()) { toast('interactive.needsClick'); break; }
          if (typeof msg.content !== 'string' || msg.content.length > 2_000_000) break;
          // Plain text formats only, named by the extension; never HTML or a
          // script the browser would run when opened.
          const name = (typeof msg.filename === 'string' ? msg.filename : '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'talos.txt';
          const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'txt').toLowerCase();
          const type = DOWNLOAD_TYPES[ext] ?? 'text/plain';
          savePreviewBlob(new Blob([ext === 'csv' ? `\ufeff${msg.content}` : msg.content], { type: `${type};charset=utf-8` }), DOWNLOAD_TYPES[ext] ? name : `${name}.txt`);
          break;
        }
        case 'talos:ui-error': {
          if (errors.current.length >= 10) break;
          const err = { phase: String(msg.phase ?? '').slice(0, 120), message: String(msg.message ?? '').slice(0, 500) };
          errors.current = [...errors.current, err];
          onErrorsRef.current?.(errors.current);
          break;
        }
        case 'talos:ui-send-prompt':
          // The "only after a click" rule is enforced HERE, not just by the
          // frame's bridge: the frame runs model-written code, which could
          // post this message itself on load. A click inside the frame
          // activates this page too (user activation propagates to ancestor
          // frames), so the host can check it independently of the frame.
          if (!hostActivated()) { toast('interactive.needsClick'); break; }
          if (typeof msg.text === 'string' && msg.text.trim()) sendRef.current(msg.text.trim().slice(0, 4000));
          break;
        case 'talos:ui-data-request': {
          const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 40) : '';
          const sourceId = typeof msg.sourceId === 'string' ? msg.sourceId.slice(0, 64) : '';
          if (reqId) void refreshData(reqId, sourceId, msg.params);
          break;
        }
        case 'talos:ui-open-link': {
          if (!hostActivated()) { toast('interactive.needsClick'); break; }
          const url = safeExternalUrl(msg.url);
          // Only links that were WRITTEN in the answer: a URL the frame put
          // together at runtime could carry the UI's data in its query string.
          if (url && writtenLinks.current.has(url)) window.open(url, '_blank', 'noopener,noreferrer');
          else toast('interactive.linkBlocked');
          break;
        }
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => { deliverRef.current(); }, [doc]);

  // Streaming: post the growing markup, at most every 120 ms. The frame keeps
  // its document; only the content of the root changes.
  const pendingPreview = useRef<number | null>(null);
  useEffect(() => {
    if (!preview || !ready) return;
    if (pendingPreview.current !== null) return;
    pendingPreview.current = window.setTimeout(() => {
      pendingPreview.current = null;
      const latest = latestUi.current;
      frame.current?.contentWindow?.postMessage(previewMessage(latest.css, latest.html), '*');
    }, 120);
  }, [preview, ready, ui.css, ui.html]);
  useEffect(() => () => { if (pendingPreview.current !== null) window.clearTimeout(pendingPreview.current); }, []);

  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (target && delivered.current) target.postMessage(themeMessage(theme), '*');
  }, [theme]);

  // Placeholder lines rotate while the frame loads (CDN libraries can take a
  // moment); the model wrote them in the user's language.
  const messages = ui.placeholderMessages.length ? ui.placeholderMessages : [t('interactive.loading')];
  useEffect(() => {
    if (ready || messages.length < 2) return;
    const id = window.setInterval(() => setPlaceholder((i) => (i + 1) % messages.length), 1800);
    return () => window.clearInterval(id);
  }, [ready, messages.length]);

  return (
    // A preview holds the height the model announced until its markup is
    // taller, so the card does not jump around while it fills in.
    <div className="relative" style={fill ? { height: '100%' } : { height: preview ? Math.max(height, ui.initialHeight) : height }}>
      <iframe
        ref={(el) => { frame.current = el; if (frameRef) frameRef.current = el; }}
        src={SHELL_URL}
        title={ui.title || t('interactive.title')}
        onLoad={() => { shellReady.current = true; deliverRef.current(); }}
        sandbox="allow-scripts"
        className="block size-full border-0 bg-transparent"
        style={{ colorScheme: theme.dark ? 'dark' : 'light' }}
      />
      {(!ready || (preview && !ui.html.trim())) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-muted/40">
          <span className="shimmer-text text-sm text-muted-foreground">{messages[placeholder % messages.length]}</span>
        </div>
      )}
    </div>
  );
}

const SOURCE_ICONS: Record<string, typeof DatabaseIcon> = {
  sql: DatabaseIcon,
  knowledge: FileTextIcon,
  web: GlobeIcon,
  calculated: SigmaIcon,
  model: BrainIcon,
  illustrative: SparklesIcon,
  user: UserIcon,
};

/** Provenance, drawn by the host — never by the generated HTML, which could
 *  claim any source it liked. */
/** The tile server's attribution as plain text (the configured value may be
 *  HTML, which the host does not render). */
const plainText = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
};

export function SourceBar({ sources, map, inCard = false }: { sources: UiSource[]; map?: boolean; inCard?: boolean }) {
  const { t } = useTranslation();
  const env = useUiEnv();
  // A map's attribution is a condition of the tile server's usage policy, so
  // the host shows it whenever the UI uses the map library — regardless of
  // what the generated code does with Leaflet's own attribution control.
  const tiles = map && env?.maps.enabled ? env.maps : null;
  if (!sources.length && !tiles) return null;
  return (
    <div className={`flex min-w-0 items-center gap-x-3 overflow-hidden text-[11px] leading-5 text-muted-foreground ${inCard ? 'border-t-[0.5px] border-foreground/15 px-4 py-1.5' : 'mt-2'}`}>
      {sources.length > 0 && <span className="shrink-0 font-medium">{t('interactive.sources')}</span>}
      {sources.map((s, i) => {
        const Icon = SOURCE_ICONS[s.kind] ?? SparklesIcon;
        const link = s.ref ? safeExternalUrl(s.ref) : null;
        const label = (
          <>
            <Icon className="size-3 shrink-0" />
            <span className="sr-only">{t(`interactive.kind.${s.kind}`, { defaultValue: s.kind })}: </span>
            <span className="truncate">{s.label}</span>
          </>
        );
        return link ? (
          <a key={i} href={link} target="_blank" rel="noreferrer noopener" title={s.ref}
            className="inline-flex min-w-0 max-w-[24rem] shrink items-center gap-1 hover:text-foreground hover:underline">{label}</a>
        ) : (
          <span key={i} title={[t(`interactive.kind.${s.kind}`, { defaultValue: s.kind }), s.ref].filter(Boolean).join(' · ')}
            className={`inline-flex min-w-0 max-w-[24rem] shrink items-center gap-1 ${s.kind === 'illustrative' ? 'italic' : ''}`}>{label}</span>
        );
      })}
      {tiles && (tiles.osm ? (
        <>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener"
            className="inline-flex shrink-0 items-center gap-1 hover:text-foreground hover:underline">
            <MapIcon className="size-3 shrink-0" />
            {t('interactive.osmAttribution')}
          </a>
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer noopener"
            className="shrink-0 hover:text-foreground hover:underline">{t('interactive.osmFixTheMap')}</a>
        </>
      ) : (
        <span className="inline-flex items-center gap-1"><MapIcon className="size-3 shrink-0" />{plainText(tiles.attribution)}</span>
      ))}
    </div>
  );
}

/** Data sources of the widgets in a turn (interactive views, answer tables),
 *  de-duplicated — they join the knowledge and web sources in the row under
 *  the answer instead of taking room inside each card. */
export function widgetSources(widgets: Array<{ type: string; data: unknown } | null | undefined>): UiSource[] {
  const out: UiSource[] = [];
  const seen = new Set<string>();
  for (const w of widgets) {
    if (!w) continue;
    const list = w.type === 'ui' ? readUiPayload(w.data)?.sources : readUiPayload(builtinView(w.type, w.data))?.sources;
    for (const s of list ?? []) {
      const key = `${s.kind}|${s.label}|${s.ref ?? ''}`;
      if (!seen.has(key)) { seen.add(key); out.push(s); }
    }
  }
  return out;
}

/** One chip per data source, styled like the knowledge-source chips. A long
 *  list shows its first few and a "+N" chip that unfolds the rest. */
const CHIPS_FOLDED = 4;
export function DataSourceChips({ sources }: { sources: UiSource[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const chip = 'inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-[11px] text-muted-foreground';
  const folded = !all && sources.length > CHIPS_FOLDED + 1;
  const shown = folded ? sources.slice(0, CHIPS_FOLDED) : sources;
  return (
    <>
      {shown.map((s, i) => {
        const Icon = SOURCE_ICONS[s.kind] ?? SparklesIcon;
        const link = s.ref ? safeExternalUrl(s.ref) : null;
        const title = [t(`interactive.kind.${s.kind}`, { defaultValue: s.kind }), s.ref].filter(Boolean).join(' · ');
        const body = (
          <>
            <Icon className="size-3 shrink-0" />
            <span className={`truncate ${s.kind === 'illustrative' ? 'italic' : ''}`}>{s.label}</span>
          </>
        );
        return link ? (
          <a key={i} href={link} target="_blank" rel="noreferrer noopener" title={title}
            className={`${chip} transition-colors hover:border-border hover:bg-accent hover:text-foreground`}>{body}</a>
        ) : (
          <span key={i} title={title} className={chip}>{body}</span>
        );
      })}
      {folded && (
        <button type="button" onClick={() => setAll(true)}
          className={`${chip} tabular-nums transition-colors hover:border-border hover:bg-accent hover:text-foreground`}
          title={sources.slice(CHIPS_FOLDED).map((s) => s.label).join(', ')}>
          +{sources.length - CHIPS_FOLDED}
        </button>
      )}
    </>
  );
}

const fileBase = (title: string) =>
  (title || 'talos-ui').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '-').slice(0, 60) || 'talos-ui';

/** `ui` widget: a model-built interactive answer, inline in the chat.
 *  `onReady` lets a streamed draft keep its preview up until this copy has
 *  actually drawn (UiDraftView). */
export function InlineUi({ data, onReady }: WidgetProps & { onReady?: () => void }) {
  const { t } = useTranslation();
  const ui = useMemo(() => readUiPayload(data), [data]);
  const usesMap = useMemo(() => !!ui && uiLibraries(ui).includes('leaflet'), [ui]);
  const [boxRef, near] = useNearViewport<HTMLDivElement>();
  const [full, setFull] = useState(false);
  const [source, setSource] = useState(false);
  const [errors, setErrors] = useState<FrameError[]>([]);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);

  if (!ui) return null;

  const downloadHtml = async () => {
    const doc = buildUiDocument(ui, readAppTheme(), { standalone: true, env: await loadUiEnv(), libCode: await loadUiLibraries(ui) });
    savePreviewBlob(new Blob([doc], { type: 'text/html;charset=utf-8' }), `${fileBase(ui.title)}.html`);
  };
  const downloadPng = async () => {
    const target = frame.current?.contentWindow;
    if (!target || busy) return;
    setBusy(true);
    try {
      const blob = await requestHtmlPng(target, new AbortController().signal);
      savePreviewBlob(blob, `${fileBase(ui.title)}.png`);
    } catch (e) {
      toast('interactive.pngFailed', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const button = 'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';
  const sourceText = [
    ui.css && '```css\n' + ui.css + '\n```',
    '```html\n' + ui.html + '\n```',
    ui.js && '```javascript\n' + ui.js + '\n```',
    ui.jsInit.length > 0 && '```javascript\n' + ui.jsInit.join('\n') + '\n```',
    ui.data !== undefined && '```json\n' + JSON.stringify(ui.data, null, 2).slice(0, 20000) + '\n```',
  ].filter(Boolean).join('\n\n');

  return (
    // Claude's card for an interactive answer: one hairline card (the same as
    // the table, weather and news widgets) with a quiet title line whose
    // actions show on hover, and the view. Its sources join the row under the
    // answer (widgetSources); only a map's attribution stays here.
    <div ref={boxRef} className="group/ui relative rounded-xl border-[0.5px] border-foreground/15 bg-card px-4 pt-2 pb-3 dark:border-foreground/12">
      <div className="mb-1 flex min-h-8 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{ui.title}</span>
        {errors.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-warning" title={errors.map((e) => `${e.phase}: ${e.message}`).join('\n')}>
            <AlertTriangleIcon className="size-3.5" />{t('interactive.errors', { count: errors.length })}
          </span>
        )}
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/ui:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" className={button} aria-pressed={source} onClick={() => setSource((v) => !v)} title={t('interactive.source')} aria-label={t('interactive.source')}>
          <CodeIcon className="size-3.5" />
        </button>
        <button type="button" className={button} onClick={downloadHtml} title={t('interactive.downloadHtml')} aria-label={t('interactive.downloadHtml')}>
          <DownloadIcon className="size-3.5" />
        </button>
        <button type="button" className={button} disabled={!near || busy || source} onClick={downloadPng} title={t('interactive.downloadPng')} aria-label={t('interactive.downloadPng')}>
          <ImageIcon className="size-3.5" />
        </button>
        <button type="button" className={button} onClick={() => setFull(true)} title={t('interactive.fullscreen')} aria-label={t('interactive.fullscreen')}>
          <Maximize2Icon className="size-3.5" />
        </button>
        </span>
      </div>
      {source && (
        <div className="max-h-[32rem] overflow-auto rounded-lg bg-muted/40 px-3 py-2 text-xs"><Markdown text={sourceText} /></div>
      )}
      <div className={source ? 'hidden' : ''}>
        {near
          ? <UiFrame ui={ui} frameRef={frame} onErrors={setErrors} onReady={onReady} />
          : <div style={{ height: ui.initialHeight }} />}
      </div>
      {errors.length > 0 && !source && (
        <details className="py-1 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none">{t('interactive.errorDetails')}</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {errors.map((e, i) => <li key={i}><span className="text-warning">{e.phase}</span> — {e.message}</li>)}
          </ul>
        </details>
      )}
      <SourceBar sources={[]} map={usesMap} />
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent title={ui.title || t('interactive.title')} className="h-[90vh] max-h-[90vh] w-[min(1400px,96vw)]">
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 bg-card px-5 py-4">{full && <UiFrame ui={ui} fill />}</div>
            <SourceBar sources={ui.sources} map={usesMap} inCard />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
