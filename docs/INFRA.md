# Bestehende Infrastruktur (DGX Spark) — Referenz für Talos

Talos dockt an einen **bereits laufenden** Stack auf der DGX Spark an. Diese Datei hält
die Endpunkte und Eigenheiten fest, gegen die wir bauen. Quelle: bestehendes
„DGX Spark RAG Stack" Setup-Dokument.

> **Keine Secrets in dieser Datei.** Zugangsdaten ausschließlich in `.env` (gitignored).

## Host

- **Spark:** `192.168.10.91` — *aktuelle VPN-IP, kann wechseln.* Erreichbarkeit am
  2026-06-05 über VPN verifiziert.
- Plattform: **arm64 (aarch64)**, GB10 Grace Blackwell. → eigene Images für `linux/arm64`.

## Endpunkte (alle am 2026-06-05 erreichbar verifiziert ✅)

| Dienst        | URL (vom Dev-Laptop)              | served-model-name | Notiz |
|---------------|-----------------------------------|-------------------|-------|
| vLLM LLM      | `http://192.168.10.91:8000/v1`    | `qwen3-llm`       | Qwen3.6-35B-A3B-FP8 (MoE), `max_model_len 65536`, `max-num-seqs 8` |
| vLLM Embed    | `http://192.168.10.91:8001/v1`    | `qwen3-embed`     | Qwen3-Embedding-0.6B, `max_model_len 8192` |
| vLLM Reranker | `http://192.168.10.91:8002`       | `qwen3-reranker`  | Qwen3-Reranker-0.6B; **Rerank-Pfad `/v1/rerank`** (Jina-Style, kein OpenAI-Standard) |
| Qdrant        | `http://192.168.10.91:6333`       | —                 | v1.14.0; Dashboard `/dashboard` |
| OpenWebUI     | `http://192.168.10.91:3000`       | —                 | bestehendes UI (wird von Talos nicht genutzt) |
| Prometheus    | `http://192.168.10.91:9090`       | —                 | scrapet vLLM + Qdrant |
| Grafana       | `http://192.168.10.91:3001`       | —                 | anonymer Viewer aktiv (LAN) |
| Portainer     | `http://192.168.10.91:9000`       | —                 | Docker-Mgmt |

Auth: vLLM braucht keinen echten Key (`VLLM_API_KEY=not-needed`), der OpenAI-Client
erwartet aber irgendeinen nicht-leeren Wert.

## Tool-Calling (kritisch für opencode) — verifiziert ✅

LLM läuft mit `--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3`.
Direkter Test am 2026-06-05: sauberer `tool_calls`-Block mit korrekten Argumenten,
`finish_reason: tool_calls`, Reasoning getrennt. Das Modell-Risiko aus PLAN §10 ist damit
auf Endpoint-Ebene entschärft. Offen bleibt: opencode-Multi-Step-Loop gegen diesen Endpoint.

## SQL-Quelle (für mcp-sql)

- Server `192.168.10.16`, DB `devQM_macs_QM_Test`.
- Bisheriger Login `llm_reader` ist **KOMPROMITTIERT** (Klartext-Env, für alle Terminal-User
  lesbar). → neuen `db_datareader`-User + neues Passwort anlegen, alten droppen. Siehe PLAN §7.
- Treiber im Altstack: `pymssql`. **arm64-Verfügbarkeit für unseren mcp-sql prüfen.**

## RAG-Parameter im Altstack (zur Orientierung)

`RAG_TOP_K=20`, `RAG_TOP_K_RERANKER=5`, Hybrid-Search an. Embedding-Engine „openai" gegen
`:8001/v1`, Reranker gegen `:8002/v1/rerank`. Brauchbare Startwerte für unseren mcp-rag.

## Abgrenzung Alt-Stack ↔ Talos

Der Altstack nutzt **OpenWebUI + Open Terminal**. Talos ersetzt diese beiden durch eigenes
Frontend + Orchestrator + opencode-Sandbox, dockt aber an **dieselben** vLLM/Qdrant/SQL-Endpunkte
an. vLLM, Qdrant, Prometheus, Grafana werden **wiederverwendet**, nicht neu gebaut.
