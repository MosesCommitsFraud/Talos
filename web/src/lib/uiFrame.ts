import imageRuntime from 'html-to-image/dist/html-to-image.js?raw';
import exportBridge from './html-export-bridge.js?raw';
import kitCss from './ui-kit.css?raw';
import kitJs from './ui-kit.js?raw';
import { brand } from './brand';

/** Inline interactive answers (`render_ui`, see src/interactive_ui.py).
 *
 *  The model sends css / html / js / data; this module turns them into ONE
 *  self-contained document that is written into the `/api/ui-shell` frame. The
 *  same document is what "HTML herunterladen" saves, so the download behaves
 *  exactly like the inline copy (minus the host, whose absence the bridge stub
 *  tolerates).
 *
 *  Everything in the document is model-generated and untrusted. It runs in an
 *  iframe without allow-same-origin under a no-network CSP; messages coming
 *  back out are checked against the live frame's window and a fixed set of
 *  types before the app acts on them (see InlineUi.tsx). */

export interface UiSource {
  kind: string;
  label: string;
  ref?: string;
}

export interface UiPayload {
  title: string;
  initialHeight: number;
  placeholderMessages: string[];
  css: string;
  html: string;
  js: string;
  jsInit: string[];
  data?: unknown;
  sources: UiSource[];
  /** Library names the model asked for (see LIBRARIES). Optional: usage is
   *  also detected from the code. */
  libraries?: string[];
  /** Server id of this UI's registered data sources (src/ui_data.py). */
  uiId?: string;
  /** Public part of each declared data source: id, kind, typed params. */
  dataSources?: UiDataSource[];
  /** Image URL as written by the model → signed proxy URL on this instance. */
  images?: Record<string, string>;
}

export interface UiDataSource {
  id: string;
  kind: string;
  label: string;
  params: Record<string, unknown>;
}

export const MIN_UI_HEIGHT = 50;
export const MAX_UI_HEIGHT = 4000;

export function clampHeight(value: unknown, fallback = 360): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(MIN_UI_HEIGHT, Math.min(MAX_UI_HEIGHT, Math.round(n)));
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Narrow a widget payload off the wire / out of a persisted turn. */
export function readUiPayload(data: unknown): UiPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const html = str(d.html);
  if (!html.trim()) return null;
  const sources = Array.isArray(d.sources)
    ? d.sources.flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const o = s as Record<string, unknown>;
        const label = str(o.label);
        if (!label) return [];
        return [{ kind: str(o.kind) || 'illustrative', label, ...(str(o.ref) ? { ref: str(o.ref) } : {}) }];
      })
    : [];
  return {
    title: str(d.title),
    initialHeight: clampHeight(d.initialHeight),
    placeholderMessages: strList(d.placeholderMessages),
    css: str(d.css),
    html,
    js: str(d.js),
    jsInit: strList(d.jsInit),
    ...('data' in d ? { data: d.data } : {}),
    sources,
    libraries: strList(d.libraries),
    ...(typeof d.uiId === 'string' && /^[0-9a-f]{32}$/.test(d.uiId) ? { uiId: d.uiId } : {}),
    dataSources: Array.isArray(d.dataSources)
      ? d.dataSources.flatMap((x): UiDataSource[] => {
          if (!x || typeof x !== 'object') return [];
          const o = x as Record<string, unknown>;
          return typeof o.id === 'string'
            ? [{ id: o.id, kind: str(o.kind), label: str(o.label), params: (o.params && typeof o.params === 'object' ? o.params : {}) as Record<string, unknown> }]
            : [];
        })
      : [],
    images: d.images && typeof d.images === 'object'
      ? Object.fromEntries(Object.entries(d.images as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('/api/ui/img?'),
        ))
      : {},
  };
}

/* ── Libraries ──
 * Served by this instance from static/ui-vendor/ (scripts/vendor_ui_libs.py),
 * never from a public CDN. Names match LIBRARIES in src/interactive_ui.py.
 * `detect` picks a library up from the code when the model forgot to list it;
 * `cdn` recognises the CDN URL a model writes out of habit, so that tag is
 * swapped for the local copy instead of being blocked by the CSP. */
export const VENDOR_PATH = '/static/ui-vendor/';
/** Signed image proxy (routes/ui_routes.py); render_ui rewrites web images to it. */
export const IMAGE_PROXY_PATH = '/api/ui/img';
interface Library { scripts?: string[]; styles?: string[]; module?: { url: string; global: string }; detect: RegExp; cdn: RegExp }
export const LIBRARIES: Record<string, Library> = {
  echarts: { scripts: ['echarts@5.5.1/echarts.min.js'], detect: /\becharts\.(init|graphic|use)\b/, cdn: /echarts/i },
  d3: { scripts: ['d3@7.9.0/d3.min.js'], detect: /\bd3\.[a-z]/, cdn: /\/d3(@[\d.]+)?\/|\/d3(\.min)?\.js/i },
  chartjs: { scripts: ['chart.js@4.4.4/chart.umd.js'], detect: /new\s+Chart\s*\(/, cdn: /chart\.js|chart\.umd/i },
  three: { module: { url: 'three@0.169.0/three.module.min.js', global: 'THREE' }, detect: /\bTHREE\./, cdn: /\/three(@[\d.]+)?\//i },
  leaflet: { scripts: ['leaflet@1.9.4/leaflet.js'], styles: ['leaflet@1.9.4/leaflet.css'], detect: /\bL\.(map|tileLayer|marker|circleMarker|polyline|geoJSON)\b|\btalos\.map\s*\(/, cdn: /leaflet/i },
  mermaid: { scripts: ['mermaid@11.15.0/mermaid.min.js'], detect: /\bmermaid\.(initialize|run|render)\b|class=["']mermaid["']/, cdn: /mermaid/i },
};
const CDN_TAG = /<(script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|esm\.sh|cdn\.skypack\.dev)\/[^"']*["'][^>]*>(?:\s*<\/script>)?/gi;

/** Libraries a UI needs: listed + detected in code + named by a CDN tag. */
export function uiLibraries(ui: Pick<UiPayload, 'html' | 'js' | 'jsInit' | 'libraries'>): string[] {
  const code = `${ui.html}\n${ui.js}\n${ui.jsInit.join('\n')}`;
  const cdnTags = ui.html.match(CDN_TAG) ?? [];
  return Object.keys(LIBRARIES).filter((name) => {
    const lib = LIBRARIES[name];
    return (ui.libraries ?? []).includes(name) || lib.detect.test(code) || cdnTags.some((tag) => lib.cdn.test(tag));
  });
}

/** Drop CDN tags for libraries served locally. Unknown CDN tags stay — the CSP
 *  blocks them and the resulting error is reported like any other. */
function stripCdnTags(html: string): string {
  return html.replace(CDN_TAG, (tag) => (Object.values(LIBRARIES).some((lib) => lib.cdn.test(tag)) ? '' : tag));
}

/* ── Environment ──
 * Fetched once per page load and shared by every frame. */
export interface UiMaps { enabled: boolean; tileUrl: string; attribution: string; maxZoom: number }
export interface UiEnv { fontCss: string; maps: UiMaps }
const NO_MAPS: UiMaps = { enabled: false, tileUrl: '', attribution: '', maxZoom: 19 };
let envPromise: Promise<UiEnv> | null = null;
export function loadUiEnv(): Promise<UiEnv> {
  envPromise ??= Promise.all([
    loadUiFontCss(),
    fetch('/api/ui/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg): UiMaps => {
        const m = cfg?.maps;
        return m && typeof m.tileUrl === 'string' && /^https:\/\//.test(m.tileUrl)
          ? { enabled: !!m.enabled, tileUrl: m.tileUrl, attribution: String(m.attribution ?? ''), maxZoom: Number(m.maxZoom) || 19 }
          : NO_MAPS;
      })
      .catch(() => NO_MAPS),
  ]).then(([fontCss, maps]) => ({ fontCss, maps }));
  return envPromise;
}

const tileOrigin = (url: string) => {
  try {
    const u = new URL(url.replace('{s}', 'a'));
    return url.includes('{s}') ? `https://*.${u.host.split('.').slice(1).join('.')}` : u.origin;
  } catch { return ''; }
};

/** Same policy as the /api/ui-shell route (ui_shell_csp in
 *  src/interactive_ui.py), repeated as a meta tag so a downloaded copy keeps it
 *  when opened on its own. */
function frameCsp(maps: UiMaps, standalone: boolean): string {
  // 'self' for the same reason as the server-side policy (proxies); a
  // downloaded copy opened from disk has no 'self', so it names the instance.
  const vendor = standalone ? window.location.origin + VENDOR_PATH : "'self'";
  const images = standalone ? ` ${window.location.origin}${IMAGE_PROXY_PATH}` : '';
  const tiles = maps.enabled && maps.tileUrl ? ` ${tileOrigin(maps.tileUrl)}` : '';
  return `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${vendor}; style-src 'unsafe-inline' ${vendor}; img-src data: blob: ${vendor}${images}${tiles}; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
}

/** Theme tokens the generated code styles itself with (named in the tool
 *  description and the interactive-answers skill — renaming one breaks every
 *  persisted UI that uses it). Values are read from the live app so a
 *  rebranded instance carries its colours into the frame. */
export interface UiTheme {
  dark: boolean;
  vars: Record<string, string>;
}

/** Series palettes — the same validated categorical palettes the dashboard
 *  scaffold uses (`_TOKENS` / `BRANDS` in sandbox/vendor/talos_dash.py), so an
 *  answer in the chat and a dashboard file of the same data wear the same
 *  colours. Eight fixed hues, fixed order, each mode stepped for its surface. */
const PALETTES: Record<string, { light: PaletteMode; dark: PaletteMode }> = {
  talos: {
    light: { s: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
      q: ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95'], good: '#0ca30c', warning: '#c98500', critical: '#d03b3b' },
    dark: { s: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
      q: ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#9ec5f4'], good: '#3fb68b', warning: '#fab219', critical: '#e66767' },
  },
  macs: {
    light: { s: ['#0785c0', '#2b4553', '#86bfe0', '#d9822b', '#2e8b78', '#8a97a3', '#a34a5b', '#1f4e79'],
      q: ['#e7f2f9', '#aed5ec', '#5aaedb', '#0785c0', '#0b4f75'], good: '#1d7f5f', warning: '#d9a21b', critical: '#c0392b' },
    dark: { s: ['#2a9fd8', '#c9d6df', '#5f86a0', '#e89a4a', '#48b39e', '#8a97a3', '#c9727f', '#9ccbea'],
      q: ['#0b3a55', '#0f5d87', '#1a86bf', '#5ab4e3', '#aed8f0'], good: '#3fb68b', warning: '#e5b53a', critical: '#e0645a' },
  },
};
interface PaletteMode { s: string[]; q: string[]; good: string; warning: string; critical: string }

/** The tokens generated code styles itself with. They are named in the tool
 *  description and the interactive-answers skill, and persisted UIs use them —
 *  add new ones freely, never rename or drop one.
 *
 *  Values come from the live app, so the frame matches the card it sits in
 *  (the frame background is transparent over `bg-card`) and a rebranded
 *  instance carries its colours in. */
export function readAppTheme(): UiTheme {
  const root = document.documentElement;
  const dark = root.classList.contains('dark');
  const css = getComputedStyle(root);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const palette = (PALETTES[brand.name.toLowerCase()] ?? PALETTES.talos)[dark ? 'dark' : 'light'];
  const bg = pick('--card', dark ? '#262628' : '#f6f6f6');
  const fg = pick('--strong', dark ? '#f5f5f5' : '#171717');
  const vars: Record<string, string> = {
    '--talos-bg': bg,
    '--talos-surface': `color-mix(in srgb, ${bg} ${dark ? 94 : 97}%, ${dark ? '#fff' : '#000'})`,
    '--talos-popover': pick('--popover', dark ? '#2a2a2c' : '#ffffff'),
    '--talos-fg': fg,
    '--talos-muted': pick('--muted-foreground', dark ? '#a3a3a3' : '#6b6b6b'),
    '--talos-border': pick('--border', dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.08)'),
    '--talos-border-strong': pick('--input', dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.12)'),
    '--talos-hover': pick('--accent', dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.04)'),
    '--talos-track': `color-mix(in srgb, ${fg} 14%, transparent)`,
    // Control tokens, mirroring the Tailwind classes of the app's own
    // controls (ui/button.tsx, ui/misc.tsx Switch + Input, EffortPicker).
    '--talos-input': pick('--input', dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.1)'),
    '--talos-input-fill': `color-mix(in srgb, ${pick('--input', 'rgba(255,255,255,.08)')} 30%, transparent)`,
    '--talos-input-fill-hover': `color-mix(in srgb, ${pick('--input', 'rgba(255,255,255,.08)')} 60%, transparent)`,
    '--talos-input-fill-soft': `color-mix(in srgb, ${pick('--input', 'rgba(255,255,255,.08)')} 20%, transparent)`,
    '--talos-ring': pick('--ring', '#3d87cb'),
    // The app's page colour: slider knobs, switch knobs and the pressed
    // segment sit on it (t3code's bg-background), not on the card.
    '--talos-page': pick('--background', dark ? '#1e1e20' : '#ffffff'),
    '--talos-muted-chip': pick('--muted', dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.04)'),
    '--talos-accent': pick('--primary', '#3d87cb'),
    '--talos-accent-fg': pick('--primary-foreground', '#ffffff'),
    '--talos-good': palette.good,
    '--talos-warning': palette.warning,
    '--talos-critical': palette.critical,
    // Older names, kept for UIs persisted before the palette tokens existed.
    '--talos-success': palette.good,
    '--talos-danger': palette.critical,
    '--talos-font': `"DM Sans", ${pick('--font-sans', 'system-ui, sans-serif').replace(/^"DM Sans",\s*/, '')}`,
    '--talos-mono': '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    '--talos-radius': '12px',
  };
  palette.s.forEach((c, i) => { vars[`--talos-chart-${i + 1}`] = c; });
  palette.q.forEach((c, i) => { vars[`--talos-seq-${i + 1}`] = c; });
  return { dark, vars };
}

/** The app's own typeface, embedded. The frame is an opaque origin with
 *  `font-src data:` only, so it cannot load /fonts itself — without this it
 *  falls back to the system font and looks foreign next to the chat. Fetched
 *  once per page load (the browser has it cached from the app already). */
let fontPromise: Promise<string> | null = null;
export function loadUiFontCss(): Promise<string> {
  fontPromise ??= fetch('/fonts/DMSans-Variable.woff2')
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, 'data:font/woff2;'));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .then((url) => `@font-face{font-family:"DM Sans";font-weight:300 800;font-style:normal;font-display:block;src:url(${url}) format("woff2")}`)
    .catch(() => '');
  return fontPromise;
}

/** `</script` inside an inline script ends it early; `<!--` can flip the
 *  parser into a different script state. Both are harmless once escaped. */
const scriptSafe = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const styleSafe = (code: string) => code.replace(/<\/(style)/gi, '<\\/$1');
const jsonForScript = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const themeCss = (theme: UiTheme) => `:root{${Object.entries(theme.vars).map(([k, v]) => `${k}:${v}`).join(';')};color-scheme:${theme.dark ? 'dark' : 'light'}}`;


/** Runs first inside the frame: data, the host bridge, error and size
 *  reporting, theme switching. Written as plain ES5-ish JS because it is
 *  injected verbatim. */
const BOOTSTRAP = `(function(){
var hosted = window.parent !== window;
function post(msg){ if (hosted) try { window.parent.postMessage(msg, '*'); } catch (e) {} }
window.__talosPhase = 'html';
function report(phase, message){ post({type:'talos:ui-error', phase: String(phase), message: String(message).slice(0, 500)}); }
window.addEventListener('error', function(e){
  // Chrome's benign "ResizeObserver loop …" notice is not a script error.
  if (e && /ResizeObserver loop/.test(String(e.message))) return;
  report(window.__talosPhase || 'runtime', (e && (e.message || (e.error && e.error.message))) || 'Script error'); });
window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; report(window.__talosPhase || 'runtime', (r && r.message) || r || 'Unhandled promise rejection'); });
// User activation: a follow-up prompt may only leave the frame in response to
// a real click/keypress, never on load or from a timer.
var lastGesture = 0;
['pointerdown','keydown','click'].forEach(function(t){ window.addEventListener(t, function(e){ if (e.isTrusted) lastGesture = Date.now(); }, true); });
function activated(){
  var ua = navigator.userActivation;
  if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
  return Date.now() - lastGesture < 3000;
}
window.talos = {
  data: window.TALOS_DATA,
  sendPrompt: function(text){
    if (!activated()) { report('bridge', 'sendPrompt needs a user click'); return false; }
    text = String(text == null ? '' : text).trim();
    if (!text) return false;
    post({type:'talos:ui-send-prompt', text: text.slice(0, 4000)}); return true;
  },
  openLink: function(url){
    if (!activated()) { report('bridge', 'openLink needs a user click'); return false; }
    post({type:'talos:ui-open-link', url: String(url || '').slice(0, 2000)}); return true;
  },
  // Fresh data from a source the answer declared (dataSources), with new
  // parameter values. Resolves with the source's result; rejects with a
  // message. Only in response to the user (a click, a slider, a select) —
  // the host runs it under the user's session.
  refresh: function(sourceId, params){
    return new Promise(function(resolve, reject){
      if (!hosted) { reject(new Error('Live data is only available inside Talos.')); return; }
      if (!activated() && Date.now() - lastGesture > 10000) { reject(new Error('refresh needs a user action')); return; }
      var id = 'r' + (++reqSeq);
      pending[id] = {resolve: resolve, reject: reject};
      post({type:'talos:ui-data-request', reqId: id, sourceId: String(sourceId || ''), params: params || {}});
    });
  },
  // The proxied, signed URL for an image the answer referenced (images from
  // the web cannot be loaded directly in here).
  img: function(url){ var map = window.TALOS_IMAGES || {}; return map[url] || url; },
  sources: (window.TALOS_CONFIG || {}).dataSources || []
};
var reqSeq = 0, pending = {};
window.addEventListener('message', function(e){
  if (e.source !== window.parent || !e.data || e.data.type !== 'talos:ui-data-response') return;
  var p = pending[e.data.reqId]; if (!p) return;
  delete pending[e.data.reqId];
  if (e.data.ok) p.resolve(e.data.data); else p.reject(new Error(String(e.data.error || 'Data source failed')));
});
// Links: the frame may not navigate itself or open windows (sandbox), so a
// click on an external link goes through the host — e.g. the map attribution.
document.addEventListener('click', function(e){
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href') || '';
  if (/^https?:/i.test(href)) { e.preventDefault(); window.talos.openLink(a.href); }
  else if (!/^#/.test(href)) e.preventDefault();
}, true);
window.alert = function(m){ report('runtime', 'alert() is not available: ' + m); };
window.confirm = function(){ return false; };
window.prompt = function(){ return null; };
var lastHeight = 0, scheduled = false;
function measure(){
  scheduled = false;
  var b = document.body, d = document.documentElement;
  if (!b) return;
  var h = Math.ceil(Math.max(b.scrollHeight, b.offsetHeight, d.offsetHeight));
  if (Math.abs(h - lastHeight) > 1) { lastHeight = h; post({type:'talos:ui-resize', height: h}); }
}
// rAF alone stalls while the page is not painted (background tab, hidden
// pane), which would leave the frame at its initial height; the timeout is the
// floor. measure() is idempotent, so whichever fires second is a no-op.
function schedule(){ if (!scheduled) { scheduled = true; requestAnimationFrame(measure); setTimeout(function(){ if (scheduled) measure(); }, 120); } }
window.__talosMeasure = schedule;
document.addEventListener('DOMContentLoaded', function(){
  if (window.ResizeObserver) { var ro = new ResizeObserver(schedule); ro.observe(document.documentElement); ro.observe(document.body); }
  schedule();
});
window.addEventListener('load', function(){ schedule(); if (!window.__talosDeferred) post({type:'talos:ui-ready'}); });
window.__talosReady = function(){ schedule(); post({type:'talos:ui-ready'}); };
// Control state travels to the host, so a rebuilt frame (the turn settling,
// full screen) comes back with the sliders where the user left them. Only
// form controls with an id; restored after the UI's own init, by setting the
// value and firing the events its handlers listen to.
var stateTimer = 0;
function controls(){ return Array.prototype.slice.call(document.querySelectorAll('input[id],select[id],textarea[id]')); }
function sendState(){
  var state = {};
  controls().forEach(function(el){
    if (el.type === 'checkbox' || el.type === 'radio') state[el.id] = {c: !!el.checked};
    else if (el.type !== 'file' && el.type !== 'password') state[el.id] = {v: String(el.value).slice(0, 500)};
  });
  post({type:'talos:ui-state', state: state});
}
['input','change'].forEach(function(t){ document.addEventListener(t, function(e){ if (!e.isTrusted) return; clearTimeout(stateTimer); stateTimer = setTimeout(sendState, 250); }, true); });
window.__talosApplyRestore = function(){
  var saved = window.__talosRestore; if (!saved) return;
  controls().forEach(function(el){
    var s = saved[el.id]; if (!s) return;
    if ('c' in s) { if (el.checked === s.c) return; el.checked = s.c; }
    else if ('v' in s) { if (el.value === s.v) return; el.value = s.v; }
    else return;
    try { el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); }
    catch (err) { report('restore', err && err.message); }
  });
};
// Preview while the model is still writing: the host posts the markup as it
// grows. No script of the UI runs in a preview.
window.addEventListener('message', function(e){
  if (e.source !== window.parent || !e.data || e.data.type !== 'talos:ui-preview') return;
  var css = document.getElementById('talos-user-css');
  if (css && typeof e.data.css === 'string' && css.textContent !== e.data.css) css.textContent = e.data.css;
  var root = document.getElementById('talos-root');
  if (root && typeof e.data.html === 'string') { root.innerHTML = e.data.html; schedule(); }
});
window.addEventListener('message', function(e){
  if (e.source !== window.parent || !e.data) return;
  if (e.data.type === 'talos:ui-theme' && typeof e.data.css === 'string') {
    var el = document.getElementById('talos-theme'); if (el) el.textContent = e.data.css;
    document.documentElement.dataset.theme = e.data.dark ? 'dark' : 'light';
    try { window.dispatchEvent(new CustomEvent('talos:theme', {detail: {dark: !!e.data.dark}})); } catch (err) {}
  }
});
})();`;

const NO_ENV: UiEnv = { fontCss: '', maps: NO_MAPS };

function absoluteImageSrcs(html: string): string {
  return html.replace(/(["'])\/api\/ui\/img\?/g, `$1${window.location.origin}/api/ui/img?`);
}

/** A downloaded copy opened from disk has no relative /api path to use. */
function absoluteImages(images: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(images ?? {}).map(([k, v]) => [k, window.location.origin + v]));
}

/** Markup that is still being written, made safe to show: no scripts (a
 *  preview never runs code), no half-written tag or entity at the end. The
 *  browser closes whatever elements are still open. */
export function partialHtml(html: string): string {
  let out = html.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '');
  out = out.replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, (m) => (/<\/style\s*>$/i.test(m) ? m : ''));
  const lt = out.lastIndexOf('<');
  if (lt > out.lastIndexOf('>')) out = out.slice(0, lt);
  return out.replace(/&[a-zA-Z0-9#]*$/, '');
}

export function previewMessage(css: string, html: string) {
  return { type: 'talos:ui-preview', css, html: partialHtml(html) };
}

/** Build the complete document for one UI.
 *
 *  Classic library scripts are parser-inserted by document.write, so they load
 *  and run in order before `js` — no loader logic needed. An ES-module library
 *  (three.js) runs only after the parser is done, so when one is in play the
 *  model's `js` and `jsInit` are held back as inert blocks and run, in order
 *  and in the global scope, once the module has set its global. */
export interface BuildOptions {
  standalone?: boolean;
  env?: UiEnv;
  /** A streaming preview: markup and styles only, no script of the UI; the
   *  host keeps posting the growing markup (`previewMessage`). */
  preview?: boolean;
  /** Control state from an earlier copy of this UI (see `talos:ui-state`). */
  restore?: Record<string, unknown> | null;
  /** Library code to embed (loadUiLibraries); null falls back to URLs. */
  libCode?: UiLibCode | null;
}

/* ── Embedded libraries ──
 * The host fetches the library files (same origin, browser-cached) and embeds
 * them in the document as JSON; the frame turns each into a blob: script. The
 * frame then needs no network at all for its code — it does not depend on how
 * a sandboxed (opaque) origin is matched against the CSP, a proxy in front of
 * Talos cannot get in the way, and a downloaded copy works on its own. */
export interface UiLibCode {
  styles: string[];
  scripts: string[];
  modules: Array<{ global: string; code: string }>;
}

const vendorCache = new Map<string, Promise<string | null>>();
function vendorText(path: string): Promise<string | null> {
  let hit = vendorCache.get(path);
  if (!hit) {
    hit = fetch(VENDOR_PATH + path)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    vendorCache.set(path, hit);
  }
  return hit;
}

/** Code of the libraries a UI uses; null when one could not be fetched (the
 *  document then falls back to <script src> tags). */
export async function loadUiLibraries(ui: UiPayload): Promise<UiLibCode | null> {
  const libs = uiLibraries(ui).map((name) => LIBRARIES[name]);
  if (!libs.length) return { styles: [], scripts: [], modules: [] };
  const origin = window.location.origin;
  const styles = await Promise.all(libs.flatMap((l) => l.styles ?? []).map(async (path) => {
    const css = await vendorText(path);
    // Relative url(images/…) in a stylesheet now living inline: point it at
    // the instance, where the files are.
    const dir = origin + VENDOR_PATH + path.slice(0, path.lastIndexOf('/') + 1);
    return css === null ? null : css.replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g, `url($1${dir}$2$1)`);
  }));
  const scripts = await Promise.all(libs.flatMap((l) => l.scripts ?? []).map(vendorText));
  const modules = await Promise.all(libs.flatMap((l) => (l.module ? [l.module] : [])).map(async (m) => {
    const code = await vendorText(m.url);
    return code === null ? null : { global: m.global, code };
  }));
  if ([...styles, ...scripts, ...modules].some((x) => x === null)) return null;
  return { styles: styles as string[], scripts: scripts as string[], modules: modules as UiLibCode['modules'] };
}

/** Runs the embedded libraries in order (classic scripts via blob: URLs,
 *  modules via import()), then the UI's own steps, then restore + ready. */
const LIB_LOADER = `(function(){
var phaseEls = document.querySelectorAll('script[type="text/x-talos"]');
function blobUrl(code){ return URL.createObjectURL(new Blob([code], {type: 'text/javascript'})); }
function classic(code){ return new Promise(function(ok, fail){ var s = document.createElement('script'); s.src = blobUrl(code); s.onload = ok; s.onerror = function(){ fail(new Error('library failed to load')); }; document.head.appendChild(s); }); }
async function run(){
  window.__talosPhase = 'libraries';
  var libs = document.querySelectorAll('script[type="application/x-talos-lib"]');
  for (var i = 0; i < libs.length; i++) {
    var el = libs[i], code = JSON.parse(el.textContent);
    if (el.dataset.global) { window[el.dataset.global] = await import(blobUrl(code)); }
    else await classic(code);
  }
  for (var j = 0; j < phaseEls.length; j++) {
    window.__talosPhase = phaseEls[j].dataset.phase;
    var s = document.createElement('script'); s.textContent = phaseEls[j].textContent; document.body.appendChild(s);
  }
  window.__talosPhase = 'restore'; window.__talosApplyRestore();
  window.__talosPhase = 'runtime';
}
run().catch(function(e){ window.dispatchEvent(new ErrorEvent('error', {message: String(e && e.message || e)})); })
  .then(function(){ window.__talosReady(); });
})();`;

/** JSON in a non-executing script element: the one form in which arbitrary
 *  code survives the HTML parser untouched (`<` is escaped, so no `</script>`
 *  or `<!--` can end or bend the element). */
const embedJson = (type: string, value: unknown, attrs = '') =>
  `<script type="${type}"${attrs}>${jsonForScript(value)}</script>`;

export function buildUiDocument(ui: UiPayload, theme: UiTheme, { standalone = false, env = NO_ENV, preview = false, restore = null, libCode = null }: BuildOptions = {}): string {
  const base = (standalone ? window.location.origin : '') + VENDOR_PATH;
  const libs = preview ? [] : uiLibraries(ui).map((name) => LIBRARIES[name]);
  const steps: Array<[string, string]> = [['js', ui.js], ...ui.jsInit.map((step, i): [string, string] => [`init ${i + 1}: ${step.slice(0, 80)}`, step])];
  const phaseTag = ([phase, code]: [string, string]) =>
    `<script type="text/x-talos" data-phase="${phase.replace(/["<&]/g, '')}">${scriptSafe(code)}</script>`;
  let head = '';
  let userCode: string;
  if (!libs.length) {
    // No library: everything runs in document order, synchronously.
    userCode = steps.map(([phase, code]) => `<script>window.__talosPhase=${JSON.stringify(phase)};</script>\n<script>${scriptSafe(code)}</script>`).join('\n')
      + `\n<script>window.__talosPhase='restore';window.__talosApplyRestore();window.__talosPhase='runtime';window.__talosMeasure&&window.__talosMeasure();</script>`;
  } else if (libCode) {
    // Embedded libraries: loaded by LIB_LOADER, then the UI's own steps.
    head = libCode.styles.map((css) => `<style>${styleSafe(css)}</style>`).join('\n');
    userCode = libCode.scripts.map((code) => embedJson('application/x-talos-lib', code)).join('\n') + '\n'
      + libCode.modules.map((m) => embedJson('application/x-talos-lib', m.code, ` data-global="${m.global.replace(/[^A-Za-z_$]/g, '')}"`)).join('\n') + '\n'
      + steps.map(phaseTag).join('\n')
      + `\n<script>window.__talosDeferred=true;</script>\n<script>${LIB_LOADER}</script>`;
  } else {
    // Fallback: the libraries by URL from this instance.
    head = libs.flatMap((l) => l.styles ?? []).map((path) => `<link rel="stylesheet" href="${base}${path}">`).join('\n')
      + '\n' + libs.flatMap((l) => l.scripts ?? []).map((path) => `<script src="${base}${path}"></script>`).join('\n');
    const modules = libs.flatMap((l) => (l.module ? [l.module] : []));
    userCode = modules.length
      ? steps.map(phaseTag).join('\n')
        + `\n<script>window.__talosDeferred=true;</script>\n<script type="module">${modules.map((m, i) => `import * as m${i} from ${JSON.stringify(base + m.url)}; window.${m.global} = m${i};`).join(' ')}
for (const s of document.querySelectorAll('script[type="text/x-talos"]')) { window.__talosPhase = s.dataset.phase; const run = document.createElement('script'); run.textContent = s.textContent; document.body.appendChild(run); }
window.__talosPhase = 'restore'; window.__talosApplyRestore();
window.__talosPhase = 'runtime'; window.__talosReady();</script>`
      : steps.map(([phase, code]) => `<script>window.__talosPhase=${JSON.stringify(phase)};</script>\n<script>${scriptSafe(code)}</script>`).join('\n')
        + `\n<script>window.__talosPhase='restore';window.__talosApplyRestore();window.__talosPhase='runtime';window.__talosMeasure&&window.__talosMeasure();</script>`;
  }
  const title = ui.title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  return `<!doctype html>
<html lang="de" data-theme="${theme.dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(env.maps, standalone)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${title || 'Talos'}</title>
${head}
<style id="talos-theme">${themeCss(theme)}</style>
<style>${env.fontCss}${styleSafe(kitCss)}${standalone ? 'html,body{background:var(--talos-bg)}#talos-root{max-width:1100px;margin:0 auto;padding:24px}' : ''}</style>
<style id="talos-user-css">${styleSafe(ui.css)}</style>
<script>window.TALOS_DATA=${jsonForScript(ui.data)};window.TALOS_CONFIG=${jsonForScript({ maps: env.maps, dataSources: ui.dataSources ?? [] })};window.TALOS_IMAGES=${jsonForScript(standalone ? absoluteImages(ui.images) : ui.images ?? {})};window.__talosRestore=${jsonForScript(restore)};</script>
<script>${BOOTSTRAP}</script>
<script>${scriptSafe(kitJs)}</script>
${standalone ? '' : `<script>${scriptSafe(imageRuntime)}</script>\n<script>${scriptSafe(exportBridge)}</script>`}
</head>
<body>
<div id="talos-root">
${preview ? partialHtml(ui.html) : standalone ? absoluteImageSrcs(stripCdnTags(ui.html)) : stripCdnTags(ui.html)}
</div>
${preview ? '' : userCode}
</body>
</html>`;
}

export function themeMessage(theme: UiTheme) {
  return { type: 'talos:ui-theme', css: themeCss(theme), dark: theme.dark };
}

/** Only https links leave the frame, and never to the app's own origin (a
 *  generated UI must not be able to drive the app through its own URLs). */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.origin === window.location.origin) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
