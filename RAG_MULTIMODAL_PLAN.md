# Talos — Multimodal RAG Build Plan (Plan B / VL stack + `/rag` UI)

Status: proposal · Date: 2026-06-27 · Owner: Moritz

Goal: run the **Plan B** stack (Qwen3‑VL‑Embedding / VL‑Reranker / Qwen3‑ASR) and let
users **drag‑drop code, images/screenshots, and videos** into the RAG, searchable in
chat with proper citations (image previews + video deep‑links). Plus a **first‑class
`/rag` workspace** to replace the cramped admin Settings panel.

This is the Talos‑side companion to `Bauplan` (the Spark stack doc). It is grounded in
the current code, names exact files, and gives a **verification per phase**.

---

## 0. Architectural decisions (read first)

These resolve the open choices in the Bauplan against how Talos is actually built.

1. **Type‑router becomes native, not a monkeypatch.** The Bauplan proposes a
   `PYTHONPATH` `sitecustomize.py` monkeypatch on `VectorRAG._documents_for_file` to
   stay upgrade‑safe against a *vendored* Talos. But this **is** the Talos repo — we
   own it. We refactor `_documents_for_file` ([src/rag_vector.py:503](src/rag_vector.py:503))
   into a small dispatch table (`_LANES`) with one handler per modality. Cleaner,
   unit‑testable, no import‑hook fragility. *(The monkeypatch remains the documented
   path for anyone running a pinned Talos image on the Spark — see Appendix A.)*

2. **ASR runs as a sidecar microservice (`video-asr`)**, not in‑process. The worker
   POSTs the file bytes over HTTP and gets back `{segments:[{start,end,text}]}`. No
   shared volume needed (bytes go over the wire), heavy model stays out of the worker
   image, and it matches the existing "serving is separate" topology.

   **Requirement — ASR is opt‑in (Advanced only).** The default stack runs with
   **just embedding + reranker, exactly like today** — the heavy `video-asr` sidecar must
   **not** start by default. It is gated two ways: (a) a docker‑compose `profiles: ["asr"]`
   so plain `docker compose up` never launches it; (b) an **Advanced settings** toggle
   (`video_asr_enabled` + `video_asr_url` in `rag_pipeline`). The video lane only activates
   when that toggle is on **and** `VIDEO_ASR_URL` is set; otherwise AV files are simply not
   accepted (skipped with a clear "ASR disabled" message), and nothing about the current
   embedding/reranker flow changes. Turning Advanced/ASR off returns the stack to its
   present behavior with no leftovers.

3. **`/rag` is a dedicated full‑page view, not a new SPA router.** The web app has no
   react‑router and navigates via zustand state (`useUi`). We add a `view: 'chat' |
   'rag'` to `useUi`, a full‑screen `RagWorkspace` component, a sidebar entry + command
   palette action, and a cheap `#/rag` hash deep‑link (read on load). This gives a real,
   shareable URL **without** adopting a router or touching the chat layout.

   **Requirement — entry point is "Advanced settings" in Settings.** The RAG entry in the
   admin Settings nav must **route the user to `/rag`** (open the workspace via
   `setView('rag')` + close the dialog), surfaced as / grouped under **Advanced**. Settings
   no longer hosts the full RAG panel itself — it is the launch point into the dedicated
   page. (Sidebar + command‑palette entries are additional ways in, not the required one.)

   **Requirement — no regression.** The current RAG must keep working exactly as it does
   today. The `/rag` workspace **reuses the existing endpoints and config** (`/api/rag/*`,
   the `rag_pipeline` settings, `_apply_saved_rag_config`) — same data, same behavior,
   just a better surface. Existing config stays valid with no migration; chat retrieval,
   the ingest worker, and all current API contracts are unchanged. Everything new in this
   plan is additive and (Phases 3–6) opt‑in.

4. **Pixel image embedding is a gated spike.** Talos embeds text only. True VL pixel
   embedding needs a second Qdrant write path and a *verified* answer to "how does vLLM
   take multimodal embedding input." We do not build it until Phase 0 proves the API and
   an eval shows screenshot questions actually need it. Until then images ride the
   Docling‑OCR + VLM‑caption text spur (already works today).

5. **One unified chunk‑meta schema** across all lanes (Bauplan §5), carried end‑to‑end
   so citations can show image previews and `#t=` deep‑links.

Phase order (MVP first): **0 → 1 → 2 → 3 → 4**, then optional **5 → 6**.

---

## Phase 0 — Spike + eval harness (do this before touching models)

**Why:** every later "did it get better?" claim needs a baseline, and the pixel‑lane
decision hinges on an API fact we haven't verified.

Build:
- `scripts/rag_eval.py`: load 20–50 real Q→expected‑source pairs from
  `data/rag_eval.jsonl`, call `/api/rag/search`, compute **Recall@k** and MRR, print a
  table. No new deps (uses `httpx`, already present).
- A throwaway spike (`scripts/spike_vl_embed.py`) that probes the VL‑Embedding endpoint
  with **(a)** a text input and **(b)** an image input, over both `/v1/embeddings` and
  `/pooling`, and prints which one returns a vector + its dimension.

### ✅ Verification 0
```bash
# Baseline recall on the CURRENT (text 0.6B) stack — record the number.
python scripts/rag_eval.py --k 10        # → prints Recall@10, save it as the baseline

# Spike: confirm how vLLM accepts image embedding input (decides Phase 5 feasibility).
python scripts/spike_vl_embed.py --image tests/fixtures/screenshot.png
# PASS = exactly one of {/v1/embeddings, /pooling} returns a non-empty vector for an image.
```
Exit criteria: baseline Recall@10 written to `data/rag_eval.baseline.json`; the spike
prints a working image‑embedding call (or a definitive "not supported" → Phase 5 stays
text‑only).

---

## Phase 1 — Plan B config wiring + re‑index (mostly config)

VL‑Embedding‑8B has a **different vector dimension** than the 0.6B text embedder →
guaranteed Qdrant mismatch → must re‑index. Talos already detects this and tells the
admin to rebuild ([rag_vector.py:201](src/rag_vector.py:201)), so the code path exists.

Changes:
1. Point `embedding_url`/`embedding_model` and `rerank_url`/`rerank_model` at the VL
   services — **via the existing UI fields** (Settings → RAG, or the new `/rag` page).
   No code change: `_apply_saved_rag_config()` already maps these to env, and the worker
   snapshot already carries them.
2. **Bug to fix while here:** the worker `_ENV_MAP` ([rag_worker.py:33](src/rag_worker.py:33))
   omits `query_prefix → RAG_QUERY_PREFIX` (present in the app mapping at
   [rag_vector.py:99](src/rag_vector.py:99)). Add it so the ingest worker and search
   agree on the Qwen instruction prefix. Add the new multimodal env keys here too (Phase 3/5).
3. Re‑index: `rebuild_index()` (recreate collection) then re‑run ingest. Wire a **"Rebuild
   index"** button in the `/rag` page (calls a new `POST /api/rag/rebuild`, admin‑gated)
   so it's not a manual Qdrant operation.

### ✅ Verification 1
```bash
# Embedding endpoint reachable + dim is the VL dim (not 384 / not 1024-text).
curl -s -X POST $EMBEDDING_URL -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-vl-embed","input":"Testfrage"}' | jq '.data[0].embedding | length'

# Reranker reachable (Talos has a built-in probe):
curl -s -X POST localhost:7000/api/rag/test | jq '.reranker.ok'   # → true

# After rebuild + re-ingest, dim matches and docs are searchable:
curl -s 'localhost:7000/api/rag/search?q=test&k=5' | jq '.count'   # → > 0
python scripts/rag_eval.py --k 10                                   # → compare vs baseline
```
Exit criteria: `rag/test` green, dim equals the VL embedding dim, Recall@10 ≥ baseline.

---

## Phase 2 — `/rag` dedicated workspace UI

Replace the buried `RagPanel` with a real page. Reuse the existing panel's logic — don't
rewrite the API calls, just relocate and expand them.

Frontend (`web/src/`):
- `state/ui.ts`: add `view: 'chat' | 'rag'` + `setView`. On boot, read `location.hash`
  (`#/rag` → `'rag'`) and keep it synced (`history.replaceState`).
- `App.tsx`: when `view === 'rag'`, render `<RagWorkspace/>` full‑screen instead of the
  chat `<main>` (sidebar stays). Cheap, no router.
- `components/Sidebar.tsx`: add a **Knowledge / RAG** entry (DatabaseIcon) → `setView('rag')`.
- `components/CommandPalette.tsx`: add an "Open RAG" command.
- `components/rag/RagWorkspace.tsx` (new), with sections:
  - **Drop zone** — large drag‑and‑drop ("einfach reindroppen") posting to
    `personalUpload`; accepts code/img/video; shows per‑file modality chips.
  - **Library** — `fetchRagDocuments` grouped by `type` (code / doc / image / video),
    image rows show a thumbnail (Phase 4 asset endpoint), video rows show duration; delete
    per source.
  - **Ingest queue** — lift the live `fetchRagJobs`/`diag` view out of `RagPanel`.
  - **Search playground** — the existing `ragSearch` box, but render results as cards
    (snippet + score + modality + thumbnail/deeplink) instead of raw JSON.
  - **Pipeline config** — the existing config fields (collapsible "Advanced"), plus the
    new **Rebuild index** button.
- **Settings → Advanced → RAG** ([SettingsDialog.tsx:1653](web/src/components/SettingsDialog.tsx:1653)):
  replace the in‑dialog `RagPanel` render with a launcher — clicking the entry calls
  `setView('rag')` and closes the dialog (route to `/rag`). Group it under an **Advanced**
  label in the admin nav. The old `RagPanel` component logic is **moved into**
  `RagWorkspace`, not deleted‑and‑rewritten, so nothing about current behavior changes.
- **No regression (acceptance gate for this phase):** the workspace must reach feature
  parity with today's panel — same config fields read/written through `/api/rag/config`,
  same upload/reload/add‑directory/search/queue/indexed‑docs behavior — before the old
  panel is retired. Existing `rag_pipeline` settings load unchanged (no migration).

No backend change in this phase except `POST /api/rag/rebuild` (Phase 1).

### ✅ Verification 2 (preview tools)
- `preview_start`, navigate `/#/rag` → `preview_snapshot` shows the workspace (drop zone,
  library, queue, search).
- Open Settings → Advanced → RAG, `preview_click` the entry → `preview_snapshot` confirms
  the dialog closed and the `/rag` workspace is shown (Advanced‑settings → `/rag` routing).
- Parity check: every field/action from the old `RagPanel` is present and round‑trips
  through `/api/rag/config` (load a saved config, edit, save, reload — value persists).
- `preview_screenshot` of the page in light + dark (`preview_resize`) — confirm accent
  `#3d87cb`, no default‑shadcn look (per memory).
- Drag‑drop a `.png` via `preview_fill`/upload → `preview_network` shows
  `POST /api/personal/upload` 200 → queue row appears → library shows the file.
- `preview_console_logs` clean.

---

## Phase 3 — Type‑router + video lane (the core "videos in RAG" goal)

### 3a. Refactor `_documents_for_file` into a lane dispatch
In [src/rag_vector.py](src/rag_vector.py): replace the `if is_docling_format` branch with
a router that picks a handler by extension:
```
_documents_for_file(path, meta):
    ext = suffix(path)
    handler = self._lane_for(ext)     # av | code | docling | text
    docs = handler(path, meta)
    for d in docs: d.meta = {**SCHEMA_DEFAULTS, **meta, **d.meta}
    return docs
```
Handlers: `_lane_av` (3b), `_lane_docling` (existing Docling path), `_lane_text`
(existing splitter), `_lane_code` (Phase 6, falls back to `_lane_text` until built).
Add the AV extensions to `DEFAULT_FILE_EXTENSIONS` so dir‑ingest picks them up too.

### 3b. `video-asr` sidecar — **opt‑in, off by default**
- New service `services/video_asr/` — a small FastAPI app: `POST /transcribe`
  (multipart file + `language`) → runs Qwen3‑ASR‑1.7B + ForcedAligner, chunks >20 min,
  returns `{segments:[{start,end,text}]}`. Dockerfile pins the model dir as a volume.
- `docker-compose.yml`: add `video-asr` under **`profiles: ["asr"]`** so plain
  `docker compose up` never starts it — the default stack stays embedding + reranker only.
  It launches only with `docker compose --profile asr up` (or `COMPOSE_PROFILES=asr`). Add
  `VIDEO_ASR_URL` to `talos-app` and `rag-ingest-worker` env (harmless when unset/disabled).
- **Settings → Advanced** toggle: `video_asr_enabled` (bool) + `video_asr_url` in the
  `rag_pipeline` config; bridged to env in `_apply_saved_rag_config` + the worker
  `_ENV_MAP` (alongside the `query_prefix` fix from Phase 1).
- `_lane_av` **activates only when** `video_asr_enabled` is true **and** `VIDEO_ASR_URL` is
  set. When active: POST the file, build one `Document` per segment with
  `meta.modality='video'`, `meta.start/end`, and a `deeplink` when a `video_url` is known
  (UI uploads have none → timestamps still stored as "from minute X"). When **inactive**:
  AV extensions are not added to the accepted set, so an AV file is skipped with a clear
  "ASR disabled — enable it in Advanced settings" error in the queue, and the
  embedding/reranker path is completely untouched.
- The `/rag` UI hides the video drop‑zone affordance (or shows it disabled with that hint)
  while ASR is off, so the feature is invisible in the default configuration.

### ✅ Verification 3
```bash
# Default stack does NOT start ASR (gating works):
docker compose up -d && docker compose ps --services | grep -qv video-asr && echo "asr off ✓"
# Embedding+reranker still healthy with ASR off (no regression):
curl -s -X POST localhost:7000/api/rag/test | jq '.ok'         # → true
# With ASR off, an AV upload is cleanly refused, not crashed:
#   drop clip.mp4 in /rag → queue row = failed "ASR disabled", other ingests unaffected.

# Now enable the profile + the Advanced toggle:
docker compose --profile asr up -d
pytest tests/test_rag_lanes.py -k "router_picks_av or router_picks_docling or av_lane_skips_when_disabled"
curl -s -F file=@tests/fixtures/clip.mp4 -F language=German \
  $VIDEO_ASR_URL | jq '.segments | length'        # → > 0, each has start/end/text
# End-to-end: drop clip.mp4 in /rag → queue completes →
curl -s 'localhost:7000/api/rag/search?q=<phrase spoken in clip>&k=3' \
  | jq '.results[0]'                                # → hit with start/end in metadata
```
Exit criteria: default `up` runs without `video-asr` and `rag/test` is green; with ASR
off an AV file fails gracefully without affecting other ingests; with `--profile asr` +
toggle on, a spoken phrase is retrievable with `start/end` metadata.

---

## Phase 4 — Citations: image previews + video deep‑links (close the loop)

So a found image/video actually *shows* in the answer.

Backend:
- **Asset endpoint** `GET /api/rag/asset?source=...` (admin/ACL‑gated) that streams an
  indexed image/file from the uploads dir — files there are login‑gated today, which the
  Bauplan flags as a problem for `<img>` rendering. This endpoint is the controlled,
  ACL‑checked way to expose them. Mount alongside the existing `/api/generated-image`
  pattern ([ai_interaction.py:1958](src/ai_interaction.py:1958)).
- `chat_processor` ([chat_processor.py:396](src/chat_processor.py:396)): carry
  `image_url`/`video_url`/`deeplink`/`modality`/`start`/`end` into `rag_sources` and into
  the injected `rag_content`. Extend the system‑prompt rule: *"If a retrieved section has
  an `image_url`, embed it as `![caption](url)` using only URLs from retrieved sections."*
  Validate emitted URLs against the retrieved chunks server‑side (anti‑hallucination), and
  **enforce ACL before context injection** (Bauplan checklist).
- Extend `RagSource` (backend dict + `web/src/api/types.ts`) with the new optional fields.

Frontend:
- `components/RagSources.tsx`: render an image thumbnail when `image_url` is set, and a
  clickable `#t=` deep‑link / "ab Minute X" label when `modality==='video'`.

### ✅ Verification 4
```bash
# Asset endpoint is ACL-gated and streams bytes:
curl -s -o /dev/null -w '%{http_code}' 'localhost:7000/api/rag/asset?source=<indexed.png>'  # 200 as admin
# (unauthenticated / non-owner → 401/403)
```
- Preview: ask a question whose answer is an indexed screenshot → `preview_snapshot` shows
  the image rendered inline; a video answer shows a deep‑link chip.
- Hallucination guard: unit test that a model‑emitted `image_url` not in the retrieved set
  is stripped.

---

## Phase 5 — Pixel image lane (Plan B's real differentiator) — GATED on Phase 0

Only if the Phase 0 spike proved a working image‑embedding API **and** eval shows
screenshot questions underperform on the text spur.

- New `_lane_image_pixel`: send the image to the VL‑embedding endpoint, write the vector
  **directly to Qdrant** (bypassing the text `OpenAIDocumentEmbedder`), with OCR text
  kept as the sparse/BM25 side. This is the "eigener Vektor‑Schreibpfad."
- Likely a **second collection** (`talos_rag_visual`) since the visual vectors differ in
  dimension/space from text; search fans out to both and merges by rerank.

### ✅ Verification 5
```bash
python scripts/rag_eval.py --k 10 --subset screenshots   # → beats Phase 1 text-spur number
```
Exit criteria: measurable Recall@10 gain on the screenshot subset; if not, **don't ship
it** (keep text spur, per Bauplan "nicht over‑engineeren").

---

## Phase 6 — Code lane (tree‑sitter) — optional

- `_lane_code`: tree‑sitter AST chunks by function/class (not char count), optional
  LLM one‑line summary embedded alongside; meta `language/symbol/imports`.
- Verification: `pytest tests/test_rag_lanes.py -k code_chunks_by_symbol` (a 3‑function
  file → 3 chunks, each tagged with its symbol), then an eval delta on code questions.

---

## Unified chunk‑meta schema (carried by every lane)

`type` · `source` · `url` · `title` · `hierarchy` · `image_url` · `image_caption` ·
`video_url` · `start` · `end` · `deeplink` · `modality` · `language` · `permissions` ·
`content_hash` · `indexed_at`. Defined once as `SCHEMA_DEFAULTS` in `rag_vector.py`,
merged in `_documents_for_file`, surfaced in `rag_sources` and citations.

---

## Risk / rollback

- **Re‑index is destructive** (collection recreate). Gate the Rebuild button behind a
  confirm; it only drops the vector store, not uploaded files (they persist in
  `talos-uploads` and can be re‑ingested).
- **KV‑cache pressure** (Bauplan §2 warning): if VL models run alongside the LLM, lower
  `--gpu-memory-utilization` and check `GPU KV cache size` in the vLLM log — infra, not
  Talos code.
- Each phase is independently shippable and reverts cleanly; Phases 5–6 are opt‑in.

---

## Appendix A — Upgrade‑safe monkeypatch (deployed‑Spark only)

For a pinned/vendored Talos image where editing source is undesirable, the Bauplan's
`./patches/sitecustomize.py` + `talos_video_lane.py` on `PYTHONPATH` reproduce the video
lane by patching `VectorRAG._documents_for_file` at import. Use this **instead of** the
Phase 3a refactor only in that deployment; the native refactor is preferred in‑repo.
