---
name: ui-maps
description: "Maps in interactive answers: locations, sites, routes and regions on OpenStreetMap with talos.map (markers, popups, lines, filters) or Leaflet for GeoJSON areas; tile-server rules and attribution. Use with interactive-answers whenever an answer has a geographic side."
requires-tools: render_ui
keywords: karte, karten, standorte, standort, orte, adressen, route, routen, regionen, geografisch, koordinaten, openstreetmap, map, maps, locations, sites, geographic
---

# Maps in interactive answers

Maps are built with `render_ui`. The frame has the Talos look and the map
helper preloaded; the tile server is configured by the admin (OpenStreetMap
by default).

## talos.map

```js
const map = talos.map('#map', {
  markers: [{ lat: 48.137, lng: 11.575, label: 'München', popup: '<b>Werk Süd</b><br>412 MA' }],
  lines: [{ points: [[48.137, 11.575], [52.52, 13.405]] }],   // optional routes
  height: 360,                       // center/zoom optional – fits the markers by default
});
map.update({ markers: [...] });       // e.g. after a filter changed
```

OpenStreetMap tiles. Their usage policy is built in: the attribution stays
visible (Talos also shows it under the view – never hide it), tiles load only
for what is on screen, the mouse wheel zooms only after a click. Coordinates
come from your own knowledge, the data or a web lookup – the frame cannot
geocode. Markers take `series` (0–7) for a palette colour.


## When a map helps

- Where things are relative to each other (sites, customers, incidents) – yes.
- One address or a single city – no; say it in text.
- Numbers per region without a spatial question – a bar chart is clearer.

## Getting coordinates

The frame cannot geocode. Use coordinates from the data (SQL columns, the
knowledge base), from a web lookup, or for well-known places from your own
knowledge (source kind `model`). Round to 4–5 decimals. If you cannot place
something reliably, leave it off the map and say so.

## Areas and custom layers (Leaflet)

For GeoJSON areas or a layer `talos.map` does not cover, list `leaflet` in
`libraries` and use the returned handle: `const m = talos.map('#map', {...});
L.geoJSON(D.areas, {style: {color: talos.color('--talos-chart-1'), weight: 1,
fillOpacity: .25}}).addTo(m.map);` – keep the tile layer and its attribution
that `talos.map` set up; never add a second tile server.

## Rules (tile usage policy)

- Never remove or hide the attribution.
- No prefetching or bulk loading of tiles; no tile URLs in your own code.
- Keep the map at a sensible size (`height` 300–480) and zoom level; the
  default fits all markers.

## Example – locations on a map

```json
{
  "title": "Standorte und Mitarbeitende",
  "initialHeight": 470,
  "placeholderMessages": ["Lade Karte …"],
  "css": "",
  "html": "<div class=\"t-stack\"><div class=\"t-spread\"><label class=\"t-toggle\"><input type=\"checkbox\" class=\"t-switch\" id=\"big\"> Nur Standorte ab 200 Mitarbeitenden</label><span class=\"t-note\" id=\"count\"></span></div><div id=\"map\"></div></div>",
  "js": "const D = window.TALOS_DATA;\nlet map;\nfunction render() {\n  const big = document.getElementById('big').checked;\n  const sites = D.sites.filter(s => !big || s.staff >= 200);\n  const markers = sites.map(s => ({ lat: s.lat, lng: s.lng, label: `${s.name}: ${talos.fmt.number(s.staff)} MA`, popup: `<b>${s.name}</b><br>${talos.fmt.number(s.staff)} Mitarbeitende`, radius: 5 + Math.sqrt(s.staff) / 3 }));\n  if (map) map.update({ markers }); else map = talos.map('#map', { markers, height: 380 });\n  document.getElementById('count').textContent = `${sites.length} von ${D.sites.length} Standorten`;\n}\ndocument.getElementById('big').addEventListener('change', render);",
  "jsInit": ["render()"],
  "data": {
    "sites": [
      {"name": "Hamburg", "lat": 53.551, "lng": 9.994, "staff": 340},
      {"name": "Berlin", "lat": 52.52, "lng": 13.405, "staff": 120},
      {"name": "Köln", "lat": 50.938, "lng": 6.96, "staff": 215},
      {"name": "Stuttgart", "lat": 48.776, "lng": 9.183, "staff": 95},
      {"name": "München", "lat": 48.137, "lng": 11.575, "staff": 412}
    ]
  },
  "sources": [
    {"kind": "sql", "label": "Standorte mit Mitarbeiterzahl", "ref": "dbo.standorte"},
    {"kind": "model", "label": "Koordinaten der Städte"}
  ]
}
```

