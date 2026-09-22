# Branding-Profile

Der Code bleibt Talos; welches Profil eine Instanz zeigt, entscheidet
`TALOS_BRAND=<ordner>` in der `.env` (ohne = `talos`).

```
branding/<profil>/
  brand.json        {"name": "..."}  → Tab-Titel, Sidebar, UI-Texte, System-Prompt
  logo-small.svg    quadratisch      → Favicon, Chat-Marker, Startseite
  logo-large.svg    breit            → Login-Screen, Sidebar-Kopf (statt Schriftzug)
```

Logos dürfen `.svg`, `.png`, `.webp`, `.jpg` oder `.ico` sein. Was fehlt, fällt auf
das Talos-Original zurück. Ein Ordner `data/branding/<profil>/` auf dem Host hat
Vorrang vor dem Repo (für Dateien, die nicht ins Repo sollen).

Änderungen greifen nach einem Neustart des Containers
(`docker compose up -d --build`).

Tipp für Light/Dark-Mode: SVG-Logos werden inline eingebunden. Flächen mit
`fill: currentColor` nehmen die Textfarbe des Themes an (siehe `macs/`).
