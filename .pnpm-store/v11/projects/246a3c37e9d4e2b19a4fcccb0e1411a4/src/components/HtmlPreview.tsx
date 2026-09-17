import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeIcon, DownloadIcon, ExternalLinkIcon, EyeIcon, MonitorIcon, PanelRightIcon } from 'lucide-react';
import { htmlPreviewDocument, postPreviewTheme, requestHtmlPng, savePreviewBlob } from '@/lib/htmlExport';
import { Markdown } from './Markdown';

/** Whether the app itself is currently dark (applyTheme toggles .dark on <html>). */
function useAppDark(): boolean {
  const read = () => document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Width a downloaded page is typically opened at. "Wie im Browser" lays the
 *  page out at this width and scales it into the panel, so the preview shows
 *  the same arrangement as the file opened on its own; "An Panel anpassen" lets
 *  a responsive page reflow to the panel instead. */
const DESKTOP_WIDTH = 1366;
const PREVIEW_SHELL_URL = '/api/html-preview-shell';
const MODE_KEY = 'talos-html-preview-mode';
type FitMode = 'desktop' | 'panel';

function readMode(): FitMode {
  try { return localStorage.getItem(MODE_KEY) === 'panel' ? 'panel' : 'desktop'; } catch { return 'desktop'; }
}

function useBoxSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({width: 0, height: 0});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const {width, height} = entry.contentRect;
      setSize({width, height});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function HtmlPreview({text, url, name}: {text: string; url: string; name: string}) {
  const {t} = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [source, setSource] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setModeState] = useState<FitMode>(readMode);
  const setMode = (next: FitMode) => {
    setModeState(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* storage unavailable: session-only choice */ }
  };
  const box = useRef<HTMLDivElement>(null);
  const boxSize = useBoxSize(box);
  const scale = mode === 'desktop' && boxSize.width > 0 && boxSize.width < DESKTOP_WIDTH ? boxSize.width / DESKTOP_WIDTH : 1;
  const dark = useAppDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  // Theme is baked in only when the document itself changes; later switches
  // are posted to the live frame so charts keep their zoom/legend state.
  const srcDoc = useMemo(() => htmlPreviewDocument(text, darkRef.current), [text]);
  const srcDocRef = useRef(srcDoc);
  srcDocRef.current = srcDoc;
  // A new document gets a fresh shell: remounting the iframe reloads it.
  const frameKey = useMemo(() => {
    let h = 0;
    for (let i = 0; i < srcDoc.length; i += 97) h = (h * 31 + srcDoc.charCodeAt(i)) | 0;
    return `${srcDoc.length}:${h}`;
  }, [srcDoc]);
  // The page is not loaded as srcdoc: a srcdoc document inherits the app's CSP,
  // which allows only nonce'd scripts, so every chart script was blocked. The
  // shell route serves an empty document with the preview's own no-network CSP;
  // once it reports ready, the document is posted in and written there.
  const delivered = useRef('');
  const deliver = () => {
    const target = frame.current?.contentWindow;
    // Once per shell: the write itself fires another load event.
    if (!target || delivered.current === frameKey) return;
    delivered.current = frameKey;
    target.postMessage({type: 'talos:preview-html', html: srcDocRef.current}, '*');
    setReady(true);
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  useEffect(() => {
    // Whichever comes first: the shell's ready message or its load event (the
    // message can fire before this listener exists when the shell is cached).
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === 'talos:preview-shell-ready') deliverRef.current();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (target && ready) postPreviewTheme(target, dark);
  }, [dark, ready]);
  useEffect(() => {
    setReady(false); setBusy(false); setError(''); setSource(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [srcDoc, url]);
  const png = async () => {
    const target = frame.current?.contentWindow;
    if (!target || busy) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    try {
      const blob = await requestHtmlPng(target, controller.signal);
      savePreviewBlob(blob, name.replace(/\.html?$/i, '') + '.png');
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  const button = 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed';
  return <div className="flex h-full min-h-[32rem] flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-2 py-1" aria-label={t('preview.htmlActions')}>
      <button type="button" aria-pressed={!source} onClick={() => setSource(false)} className={button}><EyeIcon className="size-3.5" />{t('preview.htmlRendered')}</button>
      <button type="button" aria-pressed={source} onClick={() => setSource(true)} className={button}><CodeIcon className="size-3.5" />{t('preview.htmlSource')}</button>
      <button type="button" aria-pressed={mode === 'desktop'} disabled={source} onClick={() => setMode(mode === 'desktop' ? 'panel' : 'desktop')} className={button}
        title={t(mode === 'desktop' ? 'preview.fitPanelHint' : 'preview.fitDesktopHint')}>
        {mode === 'desktop' ? <MonitorIcon className="size-3.5" /> : <PanelRightIcon className="size-3.5" />}
        {t(mode === 'desktop' ? 'preview.fitDesktop' : 'preview.fitPanel')}
      </button>
      <button type="button" onClick={() => savePreviewBlob(new Blob([text], {type: 'text/html;charset=utf-8'}), name)} className={button}><DownloadIcon className="size-3.5" />{t('preview.downloadHtml')}</button>
      <button type="button" disabled={!ready || busy || source} onClick={png} className={button}><DownloadIcon className="size-3.5" />{t(busy ? 'preview.exportingPng' : 'preview.downloadPng')}</button>
      <a href={url} target="_blank" rel="noreferrer noopener" className={`${button} ml-auto`}><ExternalLinkIcon className="size-3.5" />{t('preview.openInTab')}</a>
    </div>
    {error && <p role="alert" className="px-3 py-2 text-xs text-destructive-foreground">{t('preview.pngError', {message: error})}</p>}
    {source && <div className="min-h-0 flex-1 overflow-auto p-4"><Markdown text={'```html\n' + text + '\n```'} /></div>}
    <div ref={box} className={`${source ? 'hidden' : 'block'} relative min-h-0 flex-1 overflow-hidden ${dark ? 'bg-background' : 'bg-white'}`}>
      <iframe key={frameKey} ref={frame} src={PREVIEW_SHELL_URL} title={name} onLoad={() => { pending.current?.abort(); pending.current = null; setBusy(false); deliver(); }}
        sandbox="allow-scripts allow-popups allow-downloads"
        className="absolute top-0 left-0 block border-0"
        style={scale < 1
          ? {width: DESKTOP_WIDTH, height: boxSize.height / scale, transform: `scale(${scale})`, transformOrigin: '0 0'}
          : {width: '100%', height: '100%'}} />
    </div>
  </div>;
}
