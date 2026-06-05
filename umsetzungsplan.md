# Umsetzungsplan — Eigene Multi-User-AI-Plattform auf Basis von opencode

## 1. Zielbild

Eine selbstgehostete Web-Plattform mit eigenem Design, in der mehrere Nutzer
mit lokalen LLMs chatten, Dateien hochladen, Code ausführen lassen, eine
Wissensbasis (RAG) und eine SQL-Datenbank abfragen können. Kern ist **opencode**
als Agent-Engine, gebunden an euer lokales vLLM. Drei Schichten:

- **Du baust:** Frontend + Plattform (Auth, RBAC, Session-Manager, Persistenz, Analytics)
- **opencode liefert:** Agent, Datei-Tools, Code-Ausführung, Permissions, MCP-Anbindung — pro User isoliert
- **Bestehender Stack:** vLLM (qwen3-llm/-embed/-reranker), Qdrant, SQL Server — als Endpoints & MCP-Tools

---

## 2. Festgelegte Entscheidungen

- Basis ist **nicht** OWUI-Fork, sondern eigenes Frontend + Orchestrator um opencode.
- **Multi-User nach Open-Terminal-Muster:** ein Sandbox-Container, pro Web-User ein
  Linux-Konto + Home, Isolation über Unix-Rechte. Ein `opencode serve`-Prozess pro User.
- **Persistent pro User** (kein ephemer): Home bleibt erhalten, pro Chat ein eigenes Workdir darin.
- **Datei-Upload landet direkt im Workdir** — der Agent liest sie nativ. Keine Zwangsvektorisierung.
- **RAG ist opt-in:** nur „zur Wissensbasis hinzufügen" startet die Embedding-Pipeline.
- **Chat-Verlauf = Source of Truth in Postgres** (nicht im Sandbox-Filesystem). Dateien im Home-Volume.
- **Toggles** (Code-Ausführung an/aus, Web-Search an/aus) über opencode-Permissions/Agent-Config pro Session.
- **Alles in einem docker-compose-Stack.**
- Zielgruppe: **vertrauenswürdiges Team** → leichtes Isolationsmodell genügt (Upgrade-Pfad dokumentiert).

---

## 3. Tech-Stack (Empfehlung — anpassbar)

| Komponente | Empfehlung | Begründung |
|---|---|---|
| Frontend | **React**, dein Design | Streaming-Chat über SSE/WebSocket |
| Orchestrator/Backend | **Node/TypeScript** | nutzt `@opencode-ai/sdk` direkt, ein Ökosystem mit dem Frontend (Alternative: Python via HTTP-API) |
| App-Datenbank | **PostgreSQL** | echtes Multi-User, Verlauf, Analytics |
| Vektor-DB | **Qdrant** (Multitenancy-Mode) | bleibt; schnell, Dashboard, mandantenfähig |
| Modelle | vLLM: qwen3-llm / qwen3-embed / qwen3-reranker | bestehend, OpenAI-kompatibel |
| Sandbox | 1 Container, Linux-User pro Web-User, `opencode serve` pro User | Open-Terminal-Muster |
| MCP: RAG | Python-Server (qdrant-client + embed/rerank) | beste Libs für Vektor/Embedding |
| MCP: SQL | Python-Server (pymssql, **read-only**) | Text-to-SQL, sichere Leserechte |
| Web-Search | opencode built-in (Exa) | kein API-Key nötig, per Toggle |
| Monitoring | bestehendes Prometheus + Grafana | wiederverwenden |

---

## 4. Komponenten: bauen vs. übernehmen

**Du baust:** Frontend, Orchestrator/Session-Manager, Auth & RBAC, Postgres-Schema & Persistenz,
RAG-MCP, SQL-MCP, Analytics, das Sandbox-User-Management (Linux-User pro Web-User), Compose-Stack.

**Du übernimmst:** opencode (Engine + Agent + Tools + Permissions + Web-Search), vLLM, Qdrant,
Postgres, Prometheus/Grafana. Referenzen zum Abkupfern: `denysvitali/opencode-frontend`
(Frontend + Orchestrator), E2B-opencode-Template (opencode-in-Sandbox), Open-Terminal
(per-User-Linux-Account-Muster).

---

## 5. Umsetzung in Phasen

### Phase 0 — Fundament & Altlasten *(Tag 0–1)*
**Ziel:** Entscheidungen fix, Umgebung steht, kompromittierte Secrets weg.
- [ ] Tech-Stack final wählen (Frontend-Framework, Orchestrator-Sprache)
- [ ] Repo-Struktur anlegen: `frontend/ orchestrator/ mcp-rag/ mcp-sql/ sandbox/ compose/`
- [ ] **Geleaktes DB-Passwort rotieren** — der alte Wert steht im bisherigen Stack-Dokument und gilt als kompromittiert; neuen read-only-User mit neuem Secret anlegen
- [ ] vLLM-Endpoints (qwen3-llm/-embed/-reranker) als erreichbar verifizieren
- [ ] opencode lokal testen: OpenAI-kompatiblen Provider auf qwen3-llm zeigen lassen, `opencode serve`, ein Prompt durchlaufen
- **Fertig wenn:** opencode ruft qwen3-llm zuverlässig auf — inkl. eines Tool-Calls (kritisch, s. Risiken).

### Phase 1 — Vertikaler Durchstich, Single-User *(Woche 1)*
**Ziel:** Die wertvollste Funktion zuerst beweisen — Datei im Workdir + Code-Ausführung, ohne Auth.
- [ ] Minimales Frontend: Chatfenster mit Antwort-Streaming, Datei-Upload-Button
- [ ] Orchestrator: startet einen `opencode serve`-Prozess, proxied Chat über SDK/HTTP, streamt Antworten
- [ ] Upload-Pfad: Orchestrator schreibt Datei ins Workdir, Pfad wird dem Agenten mitgeteilt
- [ ] Test: CSV hochladen → „analysiere diese Datei" → Agent liest sie und führt Code aus
- **Fertig wenn:** dein ursprüngliches Problem ist gelöst — Upload landet im Workdir, Agent liest & rechnet direkt, keine Vektorisierung.

### Phase 2 — Persistenz & Verlauf *(Woche 2)*
**Ziel:** Nichts geht verloren, alles in Postgres.
- [ ] Postgres-Schema anlegen (s. Abschnitt 6)
- [ ] opencode-Events/Messages mitstreamen → in `messages` schreiben (DB = Source of Truth)
- [ ] Pro Chat ein eigenes Workdir, Pfad am Chat-Datensatz
- [ ] Dateien im persistenten Home-Volume
- **Fertig wenn:** Sandbox neu starten/löschen → Verlauf bleibt vollständig in der DB.

### Phase 3 — Multi-User & Auth *(Woche 3–4)*
**Ziel:** Mehrere Nutzer, isoliert, einfaches Org-Setup.
- [ ] Auth: Login/Sessions; erster Start legt Admin-Account an („Org-Setup")
- [ ] Rollen/RBAC (Admin/User), optional pro-Modell-Zugriff
- [ ] Sandbox: pro Web-User Linux-User + Home anlegen, `opencode serve` als dieser User starten, Orchestrator routet pro User
- [ ] Secrets **pro User-Prozess** scopen, nicht als Container-Env
- [ ] Idle-Cleanup für opencode-Prozesse einplanen
- **Fertig wenn:** zwei Nutzer arbeiten gleichzeitig, getrennt, mit eigenem persistentem Workspace.

### Phase 4 — Tools: RAG, SQL, Web *(Woche 5–6)*
**Ziel:** Wissensbasis, DB-Abfragen, Web-Suche — als opt-in Tools.
- [ ] RAG-MCP-Server: wrappt Qdrant + qwen3-embed + qwen3-reranker, Tool `search_knowledge`
- [ ] Knowledge-Base-Ingest (async): nur bei „zur Wissensbasis hinzufügen" → chunk/embed/index. Chat-Uploads gehen **nicht** automatisch ins RAG
- [ ] SQL-MCP-Server (read-only, neues Secret): Schema-Discovery + SELECT
- [ ] Web-Search über opencodes built-in Exa-Tool, per Toggle
- [ ] Toggles (Code/Web) → opencode-Agent/Permission-Config pro Session generieren
- **Fertig wenn:** Nutzer kann pro Chat RAG/SQL/Web ein-/ausschalten; Knowledge-Base läuft getrennt vom Chat-Upload.

### Phase 5 — Analytics & Admin *(Woche 7)*
**Ziel:** Sichtbarkeit + Verwaltung.
- [ ] `analytics_events` aus opencode-Events füllen (Token-Verbrauch, Tool-Calls, Dauer pro User/Chat)
- [ ] Analytics-Views im Frontend **oder** bestehendes Grafana auf Postgres + vLLM-Metriken
- [ ] Admin-Panel: Nutzerverwaltung, Modell-Connection, globale Parameter
- **Fertig wenn:** Admin sieht Nutzung pro User und kann Nutzer/Parameter verwalten.

### Phase 6 — Härtung & Deployment *(Woche 8)*
**Ziel:** Ein Stack, sicher, betreibbar — als arm64-Stack auf der Spark.
- [ ] Alle eigenen Images für **`linux/arm64`** bauen (s. Abschnitt 8) — sonst „exec format error" auf der Spark
- [ ] Ein docker-compose-Stack: `frontend, orchestrator, postgres, sandbox, vllm-llm/-embed/-reranker, qdrant, mcp-rag, mcp-sql, prometheus, grafana`
- [ ] opencode-Server **nie exponieren** — nur intern, hinter Orchestrator/Auth
- [ ] Ressourcen-Limits pro User-Prozess, Netzwerk-Egress der Sandbox einschränken
- [ ] Backups (Postgres + Home-Volume), Monitoring wiederverwenden
- [ ] Upgrade-Pfad dokumentieren: bei untrusted Nutzern → Container-pro-User-Orchestrator
- **Fertig wenn:** `docker compose up -d` bringt die Plattform hoch; Security-Checkliste erfüllt.

---

## 6. Datenmodell (Postgres, Skizze)

- `users` — `id, email, password_hash, role, created_at`
- `chats` — `id, user_id, title, workspace_path, created_at`
- `messages` — `id, chat_id, role, content, tool_calls (jsonb), tokens, created_at`
- `knowledge_collections` — `id, owner_id, qdrant_collection, name, created_at`
- `analytics_events` — `id, user_id, chat_id, type, tokens, duration_ms, created_at`

Workspace-Pfad lebt am `chats`-Datensatz; das User-Home wird über `users` referenziert.
Der Chat-Verlauf liegt in `messages` (DB), die Dateien im Home-Volume — zwei getrennte Stores.

---

## 7. Sicherheit (Pflicht)

- **DB-Passwort rotieren** (kompromittiert, s. Phase 0).
- opencode-Server **nicht** ins Netz hängen — nur internes Netz, Auth macht dein Orchestrator.
- Secrets **pro User-Prozess** scopen, nie als container-weite Env-Var (sonst sieht sie jeder User).
- SQL-Zugriff strikt read-only (`db_datareader`), eigenes Secret.
- Isolationsmodell bewusst: Unix-Rechte trennen Dateien, **nicht** Kernel/Netzwerk/Pakete — nur für
  vertrauenswürdige Nutzer. Für untrusted/echte Mandanten: Container-pro-User-Orchestrator.
- Sandbox-Egress einschränken; Ressourcen-Limits gegen Noisy-Neighbor.

---

## 8. Packaging & Build für DGX Spark (arm64)

Die DGX Spark ist **ARM64 (aarch64)**, GB10 Grace Blackwell. amd64-only-Images
sterben dort mit „exec format error". Konsequenzen:

- Alle eigenen Images (React, Orchestrator, MCP-Server, Sandbox) für `linux/arm64` bauen.
  App-Layer ist nicht GPU-gebunden → arm64-Base-Images (node, python, nginx) bauen problemlos.
- GPU/Modell-Layer ist über die bestehenden vLLM-Images schon gelöst — nicht neu bauen.
- Zwei Build-Wege:
  - **Cross-Build** auf dem Dev-Rechner: `docker buildx` + QEMU, Ziel `--platform linux/arm64`.
  - **Nativ auf der Spark** (einfachster Weg für die Integrationsphase): per SSH bauen, kein QEMU nötig.
- „Installieren als Docker-Image" = ein **docker-compose-Stack aus arm64-Images**, der an die
  bereits laufenden vLLM/Qdrant-Endpunkte andockt — kein Monolith-Image.
- Vor dem Deploy jede Dependency auf arm64-Verfügbarkeit prüfen (kein amd64-only-Wheel/Binary).

---

## 9. Entwicklungs-Workflow

Du entwickelst auf dem (amd64-)Arbeitslaptop und testest mit einem eigenen Dev-Docker-Stack,
der an dieselben, bereits laufenden Endpunkte (vLLM/Qdrant auf der Spark) andockt:

- **Echte Endpunkte über Netz:** HTTP ist arch-agnostisch — im Dev-Stack die **Spark-IP** eintragen
  (nicht `localhost`, das wäre der Container selbst). Dann brauchst du keinen Platzhalter und testest
  gegen das echte qwen3-llm.
- **Schneller innerer Loop:** Dev-Compose mit Bind-Mounts + Hot-Reload (Dev-Server statt Prod-Build).
  Noch schneller: Orchestrator + React nativ auf dem Laptop, nur die Sandbox in Docker.
- **Arch-Falle:** Laptop = amd64, Spark = arm64. Lokal laufende Images laufen **nicht** ungeändert
  auf der Spark. Auslieferbare Images separat per `docker buildx --platform linux/arm64` bauen —
  und arm64 **früh** testen, damit fehlende arm64-Dependencies nicht erst am Ende auffallen.
- **Finaler Test:** der arm64-Stack auf der Spark selbst.

---

## 10. Risiken & offene Entscheidungen

- **Modell-Qualität:** opencode lebt vom Tool-Calling — qwen3-llm muss zuverlässig Tools aufrufen.
  In Phase 0 früh testen; Fallback ist opencodes JSON-Tool-Call-Modus.
- **Ressourcen bei vielen Usern:** jeder `opencode serve`-Prozess hält Kontext → Idle-Cleanup nötig.
- **arm64-Dependencies:** früh prüfen, dass alle Build-Abhängigkeiten arm64-Builds haben.
- **Offen:** Orchestrator-Sprache (Empfehlung TS), Analytics in eigenem UI vs. Grafana.

---

## 11. Empfohlene Reihenfolge

Phase 0 + 1 zuerst und isoliert beweisen — **bevor** Auth und Multi-User dazukommen.
Der vertikale Durchstich (Datei landet im Workdir, Agent rechnet direkt) ist der Kern
und genau dein bisheriger Schmerzpunkt. Steht der, ist der Rest Plattform-Arbeit
auf einem bewiesenen Fundament.
