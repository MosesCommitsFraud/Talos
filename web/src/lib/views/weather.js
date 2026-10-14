// Built-in view: weather (tool `get_weather`, src/weather.py). Runs inside the
// interactive-UI frame like any render_ui answer; data = the tool's payload
// plus `__icons` (condition → SVG markup) and `__lang`.
const D = window.TALOS_DATA || {};
const de = (D.__lang || navigator.language || 'de').toLowerCase().startsWith('de');
const T = de
  ? { today: 'Heute', feels: 'Gefühlt', feelsLike: 'Gefühlt {v}', precip: 'Niederschlag', wind: 'Wind', uv: 'UV-Index', sunrise: 'Sonnenaufgang', sunset: 'Sonnenuntergang', noHourly: 'Für diesen Tag gibt es keine Stundenwerte.', unknown: 'Unbekannter Ort',
      cond: { clear: 'Klar', 'mainly-clear': 'Überwiegend klar', 'partly-cloudy': 'Teilweise bewölkt', overcast: 'Bedeckt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', 'freezing-rain': 'Gefrierender Regen', snow: 'Schnee', 'snow-grains': 'Schneegriesel', showers: 'Schauer', 'snow-showers': 'Schneeschauer', thunderstorm: 'Gewitter', 'thunderstorm-hail': 'Gewitter mit Hagel', unknown: 'Unbekannt' } }
  : { today: 'Today', feels: 'Feels like', feelsLike: 'Feels like {v}', precip: 'Precipitation', wind: 'Wind', uv: 'UV index', sunrise: 'Sunrise', sunset: 'Sunset', noHourly: 'No hourly values for this day.', unknown: 'Unknown place',
      cond: { clear: 'Clear', 'mainly-clear': 'Mainly clear', 'partly-cloudy': 'Partly cloudy', overcast: 'Overcast', fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', 'freezing-rain': 'Freezing rain', snow: 'Snow', 'snow-grains': 'Snow grains', showers: 'Showers', 'snow-showers': 'Snow showers', thunderstorm: 'Thunderstorm', 'thunderstorm-hail': 'Thunderstorm with hail', unknown: 'Unknown' } };
const ICON = D.__icons || {};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round = (v) => (num(v) == null ? '–' : String(Math.round(v)));
// Open-Meteo stamps are local to the PLACE and carry no offset: slice, never parse.
const hourOf = (s) => String(s || '').slice(11, 16);
function weekday(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(de ? 'de-DE' : 'en-GB', { weekday: 'short', timeZone: 'UTC' });
}
function icon(cond, night, cls) {
  const key = night && ICON['night-' + cond] ? 'night-' + cond : ICON[cond] ? cond : 'unknown';
  return `<span class="wx-i ${cls || ''}" aria-hidden="true">${ICON[key] || ''}</span>`;
}
const pop = (v) => (num(v) == null || v < 10 ? '' : `<span class="wx-pop">${ICON.droplets || ''}${Math.round(v)}%</span>`);

const units = D.units || {}, cur = D.current || {}, loc = D.location || {};
const hourly = Array.isArray(D.hourly) ? D.hourly : [];
const daily = Array.isArray(D.daily) ? D.daily : [];
const deg = units.temperature || '°C';
let openDay = null;

function hourCells(list) {
  return list.map((h) => `<div class="wx-h"><span class="t-muted">${esc(hourOf(h.time))}</span>${icon(h.condition || 'unknown', false, 'sm')}<b>${round(h.temperature)}°</b>${pop(h.precipitationProbability)}</div>`).join('');
}

function detail(day) {
  const stat = (label, value) => (value == null ? '' : `<div><div class="t-note">${label}</div><div class="t-num">${value}</div></div>`);
  const n = (v, suffix) => (num(v) == null ? null : `${talos.fmt.number(Math.round(v * 10) / 10, 1)}${suffix}`);
  const hours = Array.isArray(day.hours) ? day.hours : [];
  return `<div class="wx-detail"><div class="wx-stats">${[
    stat(T.feels, num(day.apparentMin) != null && num(day.apparentMax) != null ? `${round(day.apparentMin)}–${round(day.apparentMax)}${esc(deg)}` : null),
    stat(T.precip, n(day.precipitation, ' ' + esc(units.precipitation || 'mm'))),
    stat(T.wind, n(day.wind, ' ' + esc(units.wind || 'km/h'))),
    stat(T.uv, n(day.uvIndex, '')),
    stat(T.sunrise, day.sunrise ? hourOf(day.sunrise) : null),
    stat(T.sunset, day.sunset ? hourOf(day.sunset) : null),
  ].join('')}</div>${hours.length ? `<div class="wx-strip">${hourCells(hours)}</div>` : `<p class="t-note">${T.noHourly}</p>`}</div>`;
}

function render() {
  const resolved = [loc.name, loc.country].filter(Boolean).join(', ');
  const asked = loc.query || loc.name || '';
  const subtitle = resolved && resolved.toLowerCase() !== String(asked).toLowerCase() ? resolved : '';
  const cond = cur.condition || 'unknown';
  // One scale for the whole week so the range bars compare between rows.
  const lows = daily.map((d) => num(d.min)).filter((v) => v != null);
  const highs = daily.map((d) => num(d.max)).filter((v) => v != null);
  const lo = lows.length ? Math.min(...lows) : 0, hi = highs.length ? Math.max(...highs) : 1, span = Math.max(hi - lo, 1);
  const first = daily[0] || {};
  const facts = [
    num(cur.wind) != null && `<span>${ICON.wind || ''}${round(cur.wind)} ${esc(units.wind || 'km/h')}</span>`,
    num(cur.humidity) != null && `<span>${ICON.droplets || ''}${round(cur.humidity)}%</span>`,
    first.sunrise && `<span>${ICON.sunrise || ''}${hourOf(first.sunrise)}</span>`,
    first.sunset && `<span>${ICON.sunset || ''}${hourOf(first.sunset)}</span>`,
  ].filter(Boolean).join('');
  document.getElementById('wx').innerHTML = `
    <div class="wx-now">${icon(cond, cur.isDay === false, 'lg')}
      <div class="wx-now-text">
        ${subtitle ? `<div class="t-note">${esc(subtitle)}</div>` : ''}
        <div class="wx-temp"><span class="t-num">${round(cur.temperature)}</span><small>${esc(deg)}</small><span class="t-muted">${esc(T.cond[cond] || T.cond.unknown)}</span></div>
        ${num(cur.apparent) != null ? `<div class="t-note">${T.feelsLike.replace('{v}', round(cur.apparent) + esc(deg))}</div>` : ''}
      </div>
    </div>
    ${facts ? `<div class="wx-facts">${facts}</div>` : ''}
    ${hourly.length ? `<div class="wx-strip">${hourCells(hourly)}</div>` : ''}
    ${daily.length ? `<div class="wx-days">${daily.map((d, i) => {
      const min = num(d.min), max = num(d.max);
      const left = min == null ? 0 : ((min - lo) / span) * 100;
      const width = min == null || max == null ? 0 : Math.max(((max - min) / span) * 100, 4);
      const open = openDay === d.date;
      return `<div class="wx-day${open ? ' open' : ''}"><button type="button" class="wx-row" data-day="${esc(d.date)}" aria-expanded="${open}">
        <span class="wx-wd">${i === 0 ? T.today : esc(weekday(d.date))}</span>${icon(d.condition || 'unknown', false, 'sm')}
        <span class="wx-popc">${pop(d.precipitationProbability)}</span>
        <span class="wx-min t-num">${round(min)}°</span>
        <span class="wx-bar"><i style="left:${left}%;width:${width}%"></i></span>
        <span class="wx-max t-num">${round(max)}°</span><span class="wx-chev">${ICON.chevron || ''}</span>
      </button>${open ? detail(d) : ''}</div>`;
    }).join('')}</div>` : ''}`;
}

document.getElementById('wx').addEventListener('click', (e) => {
  const row = e.target.closest('.wx-row');
  if (!row) return;
  openDay = openDay === row.dataset.day ? null : row.dataset.day;
  render();
});
