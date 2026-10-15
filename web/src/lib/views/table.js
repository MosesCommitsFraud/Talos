// Built-in view: a result table (query_sql, render_widget table). Sorts over
// the whole set, shows 10 rows until asked (then the rest in a box that
// scrolls, so a big result never makes the chat a wall of rows), exports CSV, and switches to a
// chart when the columns allow one (a label column + numeric columns).
const D = window.TALOS_DATA || {};
const de = (D.__lang || navigator.language || 'de').toLowerCase().startsWith('de');
const T = de
  ? { table: 'Tabelle', chart: 'Diagramm', csv: 'CSV', rows: (n) => `${n.toLocaleString('de-DE')} ${n === 1 ? 'Zeile' : 'Zeilen'}`, of: (s, n) => `${s.toLocaleString('de-DE')} von ${n.toLocaleString('de-DE')} Zeilen`, all: (n) => `Alle ${n.toLocaleString('de-DE')} anzeigen`, less: 'Weniger anzeigen', spill: (p) => `Vollständiges Ergebnis in ${p}`, by: 'nach' }
  : { table: 'Table', chart: 'Chart', csv: 'CSV', rows: (n) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'row' : 'rows'}`, of: (s, n) => `${s.toLocaleString('en-GB')} of ${n.toLocaleString('en-GB')} rows`, all: (n) => `Show all ${n.toLocaleString('en-GB')}`, less: 'Show less', spill: (p) => `Full result in ${p}`, by: 'by' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const columns = (Array.isArray(D.columns) ? D.columns : []).map(String);
const rows = (Array.isArray(D.rows) ? D.rows : []).filter(Array.isArray).map((r) => r.map((v) => (v === undefined ? null : v)));
const INITIAL = 10;
// A column is numeric only if every non-null value in it is a number.
const numeric = columns.map((_, c) => {
  let seen = false;
  for (const r of rows) { const v = r[c]; if (v == null) continue; seen = true; if (typeof v !== 'number') return false; }
  return seen;
});
const idLike = (n) => /^(id|nr|no|num|index|key|pk)$|_(id|nr|no|key)$|^(id|key)_/i.test(String(n).trim());
const labelCol = numeric.findIndex((n) => !n);
const valueCols = numeric.map((n, i) => (n ? i : -1)).filter((i) => i >= 0).sort((a, b) => idLike(columns[a]) - idLike(columns[b]));
const canChart = labelCol >= 0 && valueCols.length > 0 && rows.length >= 2;

let sort = null, expanded = false, view = 'table', valueCol = valueCols[0], chart = null;

// Nulls stay at the bottom in both directions.
function cmp(a, b, desc) {
  const ae = a == null, be = b == null;
  if (ae || be) return ae && be ? 0 : ae ? 1 : -1;
  const o = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return desc ? -o : o;
}
const sorted = () => (sort ? [...rows].sort((x, y) => cmp(x[sort.c], y[sort.c], sort.desc)) : rows);
const cell = (v, c) => (v == null ? '<span class="tb-null">NULL</span>' : numeric[c] ? talos.fmt.number(v, Number.isInteger(v) ? 0 : undefined) : esc(typeof v === 'object' ? JSON.stringify(v) : v));

function csv() {
  const q = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(q).join(','), ...sorted().map((r) => r.map(q).join(','))].join('\r\n');
}

function renderTable() {
  const all = sorted(), shown = expanded ? all : all.slice(0, INITIAL);
  const arrow = (c) => (sort && sort.c === c ? (sort.desc ? ' ↓' : ' ↑') : '');
  document.getElementById('tb-body').innerHTML = `<div class="t-scroll${expanded ? ' tb-box' : ''}"><table class="t-table tb">
    <thead><tr>${columns.map((n, c) => `<th class="${numeric[c] ? 'num' : ''}" data-sort="${c}" aria-sort="${sort && sort.c === c ? (sort.desc ? 'descending' : 'ascending') : 'none'}">${esc(n)}${arrow(c)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${r.map((v, c) => `<td class="${numeric[c] ? 'num' : ''}">${cell(v, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${all.length > INITIAL ? `<button type="button" class="t-btn ghost sm tb-more" data-act="${expanded ? 'less' : 'all'}">${expanded ? T.less : T.all(all.length)}</button>` : ''}`;
}

function renderChart() {
  const temporal = rows.slice(0, 8).every((r) => /^\d{4}([-./]\d{1,2})?([-./]\d{1,2})?/.test(String(r[labelCol] ?? '')));
  const pts = rows.filter((r) => typeof r[valueCol] === 'number');
  const opts = {
    categories: pts.map((r) => String(r[labelCol] ?? '')),
    series: [{ name: columns[valueCol], values: pts.map((r) => r[valueCol]) }],
    horizontal: !temporal && pts.length > 12 ? true : undefined,
  };
  const box = document.getElementById('tb-body');
  box.innerHTML = `${valueCols.length > 1 ? `<div class="t-chips" data-single id="tb-cols">${valueCols.map((c) => `<button data-value="${c}" aria-pressed="${c === valueCol}">${esc(columns[c])}</button>`).join('')}</div>` : ''}
    <p class="t-note tb-ctitle">${esc(columns[valueCol])} ${T.by} ${esc(columns[labelCol])}</p><div id="tb-chart"></div>`;
  chart = temporal ? talos.chart.line('#tb-chart', opts) : talos.chart.bar('#tb-chart', opts);
}

function render() {
  const total = Number(D.rowCount) || rows.length;
  const meta = [D.database ? `<b>${esc(D.database)}</b>` : '', rows.length < total ? T.of(rows.length, total) : T.rows(total)].filter(Boolean).join(' · ');
  document.getElementById('tb').innerHTML = `<div class="t-spread tb-head"><span class="t-note">${meta}</span><span class="t-row tb-tools">
      ${canChart ? `<div class="t-seg" id="tb-view"><button data-value="table" aria-pressed="${view === 'table'}">${T.table}</button><button data-value="chart" aria-pressed="${view === 'chart'}">${T.chart}</button></div>` : ''}
      <button type="button" class="t-btn ghost sm" data-act="csv">${T.csv}</button></span></div>
    <div id="tb-body"></div>
    ${D.spillPath ? `<p class="t-note">${esc(T.spill(D.spillPath))}</p>` : ''}`;
  view === 'chart' ? renderChart() : renderTable();
}

const root = document.getElementById('tb');
root.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const c = Number(th.dataset.sort);
    sort = !sort || sort.c !== c ? { c, desc: false } : sort.desc ? null : { c, desc: true };
    renderTable();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'all') { expanded = true; renderTable(); }
  if (act && act.dataset.act === 'less') { expanded = false; renderTable(); }
  if (act && act.dataset.act === 'csv') talos.download((D.label || 'ergebnis').replace(/[^\w.-]+/g, '_').slice(0, 60) + '.csv', csv());
});
root.addEventListener('talos:change', (e) => {
  if (e.target.id === 'tb-view') { view = e.detail.value; view === 'chart' ? renderChart() : renderTable(); }
  if (e.target.id === 'tb-cols') { valueCol = Number(e.detail.value); renderChart(); }
});
