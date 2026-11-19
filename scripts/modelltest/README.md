# Modelltest

Lässt einen festen Fragenkatalog gegen ein Modell in Talos laufen und trägt Metriken und
Bewertung in die Testmappe ein (Blatt „Ergebnisse“). Damit wurden K1, K2 und K4 getestet:
39 Fragen (Allgemein, Skills, AutoTS-Connector), je 3 Läufe.

| Datei | Wozu |
|---|---|
| `plan.json` | Die Fragen mit Folgefragen und Schaltern (Wissen, DB, Web, Deep Research, Anhang) |
| `harness.js` | Läuft im Browser-Tab von Talos, stellt die Fragen und sammelt die Metriken |
| `write_results.py` | Hängt die Läufe in der Excel-Mappe an |

## Ablauf

1. **Vorbereiten.** In Talos als Admin anmelden. Alle Bibliotheks-Skills einschalten. Das
   Memory des Testnutzers leeren (siehe Fallstricke). Das Skript hält beim Start selbst
   fest, womit getestet wird: Schrittlimit (`agent_max_rounds`), Prompt-Stil,
   abgeschaltete Skills und Tools, Memory-Einträge. `MT.setupNote()` gibt das als eine
   Zeile für das Blatt „Konfigurationen“ aus, `MT.status()` zeigt es mit an. Dort
   nachsehen, bevor die Läufe lange laufen.
2. **Starten.** In der Konsole des Talos-Tabs `harness.js` ausführen, dann:

   ```js
   MT.loadPlan(/* Inhalt von plan.json */)
   MT.start({ ep: '<Endpoint-ID>', model: '<Modellname>', tag: 'K3' })
   ```

   Je Frage und Lauf entsteht ein Chat „Modelltest K3 ALG-01 L1“. `MT.status()` zeigt den
   Stand. Nach einem Neuladen der Seite die Datei erneut ausführen und `MT.start` mit
   denselben Angaben aufrufen: Fertige Läufe werden übersprungen.
3. **Bewerten.** `await MT.batch(10)` gibt je Lauf Fragen, Tool-Aufrufe und Antworten aus,
   dazu den Grund, wenn ein Turn nicht normal endete. Die Bewertung von Hand in eine
   JSON-Datei schreiben und die Läufe mit `MT.graded([...])` abhaken:

   ```json
   { "ALG-01|1": { "U": "nein", "V": "ja", "W": "ja", "X": 0, "AB": 5, "AC": "nein",
                   "AD": "n.a.", "AG": 5, "AH": "Korrekt, 3 Sätze, kein Tool." } }
   ```

   Die Schlüssel sind die Spaltenbuchstaben des Blatts „Ergebnisse“.
4. **Eintragen.** Die Ausgabe von `MT.exportLines()` in eine Textdatei legen, Excel
   schließen, die Mappe sichern und dann:

   ```bash
   python write_results.py Talos_Modelltest.xlsx lines.txt grades.json K3 Moritz
   ```

   Braucht `openpyxl`. Das Skript hängt unten an und bricht ab, wenn es dieselben Läufe
   dieser Konfiguration schon gibt.

## Fallstricke aus den bisherigen Läufen

- **Schrittlimit.** Ist in Talos ein Schrittlimit gesetzt (auf dem Dev-System 20), endet
  ein Turn dort mit `rounds_exhausted`, ohne Abschlussantwort und oft ohne Dateiübergabe.
  In der Oberfläche steht dann „Weiter“, das Testskript drückt das nicht. Das traf 15 von
  351 Läufen und sieht in der Antwort wie ein Abbruch des Modells aus. `MT.batch` und
  `write_results.py` weisen es deshalb aus.
- **Memory.** Die Modelle legen während der Läufe Einträge im Nutzer-Memory an, und
  spätere Antworten richten sich danach. Vor jedem Test leeren, danach wieder. Das Skript
  vermerkt je Lauf, welchen Eintrag er angelegt hat („Memory neu: …“).
- **Setup ändert sich mitten im Test.** Beim K4-Test wurden zwei Skills nach einer Stunde
  abgeschaltet; die Läufe danach konnten sie nicht laden und wurden als „Skill nicht
  gelesen“ bewertet. Das Skript vergleicht deshalb vor jedem Lauf mit dem Stand beim
  Start und vermerkt Abweichungen („seit Teststart: Skill ausgeschaltet: …“). Die
  Vermerke stehen im Log, in `MT.exportLines()` und landen in der Bemerkung der Mappe.
  Ein solcher Lauf ist für die betroffene Frage nicht zu bewerten.
- **Lange Läufe.** Recherchen mit Hilfsagenten brauchen je Runde bis zu 25 Minuten; das
  ist Arbeit, kein Hängen. Shell und Python lagen in 616 Runden nie über 104 Sekunden.
  Abbrechen geht mit `fetch('/api/chat/stop/<Chat-ID>', { method: 'POST' })`, das Skript
  macht dann mit der Folgefrage weiter. Im Ergebnis vermerken.
- **Websuche.** Viele Suchen kurz hintereinander lassen SearXNG bei einzelnen Suchmaschinen
  auflaufen. Läufe mit Websuche von solchen Tagen sind nur eingeschränkt vergleichbar.
- **Neustart von Talos.** Das Skript wartet auf die Anmeldung und macht danach weiter. Der
  Stand liegt im `localStorage` des Tabs. Geht der verloren, lassen sich die Chats über
  ihren Namen wiederfinden (`/api/sessions`).
- **Nicht geprüft wird, was man nur sieht.** Diagramme, Karten und Mini-Apps sind anhand
  von Tool-Aufrufen und Antworttext bewertet, nicht am Bildschirm.
