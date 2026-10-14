// Built-in view: news (tool `get_news`, src/news.py). Thumbnails come
// through the signed image proxy (talos.img); a click opens the article via
// the host, which only follows URLs that are in this payload.
const D = window.TALOS_DATA || {};
const de = (D.__lang || navigator.language || 'de').toLowerCase().startsWith('de');
const T = de
  ? { justNow: 'gerade eben', hours: (n) => `vor ${n} Std.`, days: (n) => (n === 1 ? 'gestern' : `vor ${n} Tagen`), hidden: (n) => `${n} ${n === 1 ? 'Treffer' : 'Treffer'} durch die Domain-Richtlinie ausgeblendet` }
  : { justNow: 'just now', hours: (n) => `${n} h ago`, days: (n) => (n === 1 ? 'yesterday' : `${n} days ago`), hidden: (n) => `${n} ${n === 1 ? 'result' : 'results'} hidden by the domain policy` };
const ICON = D.__icons || {};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const articles = Array.isArray(D.articles) ? D.articles : [];

function age(iso) {
  const then = Date.parse(iso || '');
  if (!isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 60) return T.justNow;
  if (minutes < 60 * 24) return T.hours(Math.round(minutes / 60));
  const days = Math.round(minutes / (60 * 24));
  if (days <= 7) return T.days(days);
  return new Date(then).toLocaleDateString(de ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function render() {
  // Rows keep a common left edge: if any article has a picture, all reserve the slot.
  const anyThumb = articles.some((a) => a.thumbnail);
  document.getElementById('news').innerHTML = articles.map((a, i) => {
    const src = a.thumbnail ? talos.img(a.thumbnail) : '';
    const proxied = src && src !== a.thumbnail;
    const meta = [a.source ? `<b>${esc(a.source)}</b>` : '', age(a.published)].filter(Boolean).join(' · ');
    return `<button type="button" class="nw-row" data-i="${i}">
      ${anyThumb ? `<span class="nw-thumb">${ICON.newspaper || ''}${proxied ? `<img src="${esc(src)}" alt="" loading="lazy" onload="this.classList.add('in')" onerror="this.remove()">` : ''}</span>` : ''}
      <span class="nw-body">
        <span class="nw-meta">${meta}<span class="nw-ext">${ICON.external || ''}</span></span>
        <span class="nw-title">${esc(a.title)}</span>
        ${a.snippet ? `<span class="nw-snip">${esc(a.snippet)}</span>` : ''}
      </span>
    </button>`;
  }).join('') + (D.hiddenByPolicy > 0 ? `<p class="t-note nw-hidden">${esc(T.hidden(D.hiddenByPolicy))}</p>` : '');
}

document.getElementById('news').addEventListener('click', (e) => {
  const row = e.target.closest('.nw-row');
  const a = row && articles[Number(row.dataset.i)];
  if (a && a.url) talos.openLink(a.url);
});
