/* Built-in views: the tool results that come with a picture — weather, news,
 * result tables — rendered as interactive UI, in the same sandboxed frame,
 * kit and card as every render_ui answer.
 *
 * The tools keep sending plain data (`weather`, `news`, `table` widgets, see
 * src/widgets.py); this module turns that data into a UI payload: a static
 * view script per type (./views/*.js) plus the data. Doing it here rather
 * than in the backend keeps every stored conversation rendering the same way
 * without a migration — an old turn's widget is just data too.
 */
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChevronDownIcon, CloudDrizzleIcon, CloudFogIcon, CloudHailIcon, CloudIcon, CloudLightningIcon, CloudMoonIcon,
  CloudRainIcon, CloudSnowIcon, CloudSunIcon, DropletsIcon, ExternalLinkIcon, MoonIcon, NewspaperIcon, SunIcon,
  SunriseIcon, SunsetIcon, WindIcon,
} from 'lucide-react';
import type { UiSource } from './uiFrame';
import weatherJs from './views/weather.js?raw';
import weatherCss from './views/weather.css?raw';
import newsJs from './views/news.js?raw';
import newsCss from './views/news.css?raw';
import tableJs from './views/table.js?raw';
import tableCss from './views/table.css?raw';

type Dict = Record<string, unknown>;
const asDict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export const BUILTIN_VIEW_TYPES = new Set(['weather', 'news', 'table']);

let iconCache: Record<string, string> | null = null;
/** Lucide icons as SVG markup — the same set the app uses, drawn in the frame. */
function icons(): Record<string, string> {
  if (iconCache) return iconCache;
  const svg = (Icon: ComponentType<{ size?: number; strokeWidth?: number }>) => renderToStaticMarkup(createElement(Icon, { size: 16, strokeWidth: 2 }));
  const map: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
    clear: SunIcon, 'mainly-clear': CloudSunIcon, 'partly-cloudy': CloudSunIcon, overcast: CloudIcon, fog: CloudFogIcon,
    drizzle: CloudDrizzleIcon, rain: CloudRainIcon, 'freezing-rain': CloudHailIcon, snow: CloudSnowIcon, 'snow-grains': CloudSnowIcon,
    showers: CloudRainIcon, 'snow-showers': CloudSnowIcon, thunderstorm: CloudLightningIcon, 'thunderstorm-hail': CloudLightningIcon,
    unknown: CloudIcon, 'night-clear': MoonIcon, 'night-mainly-clear': CloudMoonIcon, 'night-partly-cloudy': CloudMoonIcon,
    droplets: DropletsIcon, wind: WindIcon, sunrise: SunriseIcon, sunset: SunsetIcon, chevron: ChevronDownIcon,
    newspaper: NewspaperIcon, external: ExternalLinkIcon,
  };
  iconCache = Object.fromEntries(Object.entries(map).map(([k, Icon]) => [k, svg(Icon)]));
  return iconCache;
}

const lang = () => (typeof document !== 'undefined' && document.documentElement.lang) || navigator.language || 'de';
const de = () => lang().toLowerCase().startsWith('de');

/** A built-in widget as a UI payload (the shape readUiPayload takes), or null. */
export function builtinView(type: string, data: unknown): Record<string, unknown> | null {
  const d = asDict(data);
  switch (type) {
    case 'weather': {
      const loc = asDict(d.location);
      const place = asStr(loc.query) || asStr(loc.name) || [asStr(loc.name), asStr(loc.country)].filter(Boolean).join(', ');
      const days = Array.isArray(d.daily) ? d.daily.length : 0;
      return {
        title: place || (de() ? 'Wetter' : 'Weather'),
        initialHeight: 200 + Math.min(days, 16) * 34,
        html: '<div id="wx"></div>',
        css: weatherCss,
        js: weatherJs,
        jsInit: ['render()'],
        data: { ...d, __icons: icons(), __lang: lang() },
        sources: [{ kind: 'web', label: 'Open-Meteo', ref: 'https://open-meteo.com' }],
      };
    }
    case 'news': {
      const articles = Array.isArray(d.articles) ? d.articles : [];
      if (!articles.length) return null;
      const images = asDict(d.images);
      return {
        title: asStr(d.query) || (de() ? 'Nachrichten' : 'News'),
        initialHeight: 40 + articles.length * 92,
        html: '<div id="news"></div>',
        css: newsCss,
        js: newsJs,
        jsInit: ['render()'],
        data: { ...d, __icons: icons(), __lang: lang() },
        images,
        sources: [],
      };
    }
    case 'table': {
      const columns = Array.isArray(d.columns) ? d.columns : [];
      if (!columns.length) return null;
      const rows = Array.isArray(d.rows) ? d.rows.length : 0;
      const label = asStr(d.label) || asStr(d.title);
      return {
        title: label || (de() ? 'Ergebnis' : 'Result'),
        initialHeight: 90 + Math.min(rows, 10) * 33,
        html: '<div id="tb"></div>',
        css: tableCss,
        js: tableJs,
        jsInit: ['render()'],
        data: { ...d, __lang: lang() },
        // An answer table names its sources; a query result's source is the
        // query itself, shown in the work fold.
        sources: d.answer === true && Array.isArray(d.sources) ? (d.sources as UiSource[]) : [],
      };
    }
    default:
      return null;
  }
}
