import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeIcon, DownloadIcon, ExternalLinkIcon, EyeIcon } from 'lucide-react';
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

export function HtmlPreview({text, url, name}: {text: string; url: string; name: string}) {
  const {t} = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [source, setSource] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dark = useAppDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  // Theme is baked in only when the document itself changes; later switches
  // are posted to the live frame so charts keep their zoom/legend state.
  const srcDoc = useMemo(() => htmlPreviewDocument(text, darkRef.current), [text]);
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
      <button type="button" onClick={() => savePreviewBlob(new Blob([text], {type: 'text/html;charset=utf-8'}), name)} className={button}><DownloadIcon className="size-3.5" />{t('preview.downloadHtml')}</button>
      <button type="button" disabled={!ready || busy || source} onClick={png} className={button}><DownloadIcon className="size-3.5" />{t(busy ? 'preview.exportingPng' : 'preview.downloadPng')}</button>
      <a href={url} target="_blank" rel="noreferrer noopener" className={`${button} ml-auto`}><ExternalLinkIcon className="size-3.5" />{t('preview.openInTab')}</a>
    </div>
    {error && <p role="alert" className="px-3 py-2 text-xs text-destructive-foreground">{t('preview.pngError', {message: error})}</p>}
    {source && <div className="min-h-0 flex-1 overflow-auto p-4"><Markdown text={'```html\n' + text + '\n```'} /></div>}
    <iframe ref={frame} srcDoc={srcDoc} title={name} onLoad={() => { pending.current?.abort(); pending.current = null; setBusy(false); setReady(true); }}
      sandbox="allow-scripts allow-popups allow-downloads"
      className={`${source ? 'hidden' : 'block'} min-h-0 w-full flex-1 border-0 ${dark ? 'bg-background' : 'bg-white'}`} />
  </div>;
}
