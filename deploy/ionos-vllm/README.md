# vLLM auf IONOS über Tailscale an Talos anbinden

```
Intranet-Nutzer ──► Talos-Server ══ Tailscale ══► IONOS: tailscale + vLLM
                    (Tools, DB, RAG)               (nur Inferenz, Port 8000
                                                    nur im Tailnet erreichbar)
```

Talos akzeptiert nur private Endpoints (`_require_local_endpoint` in
`routes/model_routes.py`). Tailscale-IPs (`100.64.0.0/10`) zählen dazu.

Es läuft immer **ein** Modell. Die Einstellungen pro Modell liegen in
`models/<name>.yaml` (Schlüssel = `vllm serve`-Flags ohne `--`), umgeschaltet
wird mit `./run.sh <name>`. Ein eigenes Dockerfile ist nicht nötig, das
offizielle Image `vllm/vllm-openai` bringt alles mit.

## Welches Modell braucht wie viele GPUs?

| `models/…`           | Checkpoint                    | Gewichte  | Braucht      |
|----------------------|-------------------------------|-----------|--------------|
| `qwen3.8-27b`        | `Qwen/Qwen3.8-27B-FP8`        | ~31 GB    | 1× H200      |
| `qwen3.8-flash-next` | `Qwen/Qwen3.8-Flash-Next-FP8` | ~186 GB   | **2× H200**  |
| `glm-5.3-flash`      | `zai-org/GLM-5.3-Flash` (FP8) | ~330 GB   | **4× H200**  |

- Die **260 GB RAM** sind Arbeitsspeicher, die Modelle müssen in den
  **GPU-Speicher** (H200: 141 GB pro Karte). `nvidia-smi` zeigt, wie viele
  GPUs die VM hat.
- **Flash-Next:** vLLM lagert die 51-B-N-Gram-Tabelle automatisch in den RAM
  aus. Trotzdem bleiben ~125 GiB pro GPU, auf einer H200 ist dann kein Platz
  mehr für den KV-Cache.
- **GLM-5.3-Flash-NVFP4** (`nvidia/…`) läuft nur auf Blackwell (B200/GB200).
  Auf der H200 wird deshalb der offizielle FP8-Checkpoint verwendet.
- `run.sh` bricht ab, wenn das Modell mehr GPUs braucht als vorhanden.
- Plattenplatz für alle drei: **~550 GB** (Docker-Volume `hf-cache`).

## 1. IONOS-Server

Dateien auf den Server kopieren (vom Windows-Rechner aus):

```bash
scp -r deploy/ionos-vllm root@<server-ip>:/opt/
```

Auf dem Server:

```bash
cd /opt/ionos-vllm
chmod +x run.sh setup-host.sh
sudo ./setup-host.sh          # Treiber, Docker, NVIDIA Container Toolkit
sudo reboot                   # nur wenn das Skript es verlangt, danach nochmal ausführen
```

IONOS-Firewall:

| Port        | Richtung  | Zweck                                   |
|-------------|-----------|-----------------------------------------|
| 22/tcp      | eingehend | SSH (am besten auf eigene IP begrenzt)  |
| 41641/udp   | eingehend | Tailscale-Direktverbindung              |
| 8000        | —         | **nicht freigeben**                     |

Tailscale-Auth-Key erzeugen: [login.tailscale.com](https://login.tailscale.com/admin/settings/keys)
→ Settings → Keys → *Generate auth key*.

```bash
cp .env.example .env
nano .env                         # TS_AUTHKEY, VLLM_API_KEY (openssl rand -hex 32)
./run.sh download qwen3.8-27b     # oder ohne Namen: alle Modelle laden
./run.sh qwen3.8-27b              # starten
./run.sh logs                     # bereit bei "Application startup complete"
./run.sh test                     # eine Testanfrage direkt auf dem Server
docker compose exec tailscale tailscale ip -4   # → 100.x.y.z
```

Danach in der Tailscale-Admin-Konsole beim Gerät `talos-llm` **Disable key
expiry** setzen (oder Tags nutzen, siehe `.env.example`).

Modell wechseln: einfach `./run.sh glm-5.3-flash` usw. — der alte vLLM-Container
wird ersetzt, Tailscale läuft weiter, IP und API-Key bleiben gleich.

> Die **UUID und `href`** aus der IONOS-Konsole gehören zur IONOS-Cloud-API
> (Server per API starten/stoppen, z. B. um bei 3 €/h nachts abzuschalten).
> Für die Verbindung zu Talos werden sie nicht gebraucht.

## 2. Talos-Server

Tailscale **auf dem Host** installieren und mit demselben Account anmelden:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Läuft Talos in Docker, wird der Traffic der Container zu `100.x.y.z`
automatisch über das Tailscale-Interface des Hosts geroutet.

Test vom Talos-Host:

```bash
tailscale ping talos-llm         # sollte "via <ip>:41641" zeigen, nicht "via DERP"
curl -H "Authorization: Bearer <VLLM_API_KEY>" http://100.x.y.z:8000/v1/models
```

Im Talos-Container prüfen (Docker-DNS kennt MagicDNS-Namen nicht, deshalb die IP):

```bash
docker compose exec talos curl -s -H "Authorization: Bearer <VLLM_API_KEY>" http://100.x.y.z:8000/v1/models
```

## 3. Endpoint in Talos

Admin → Model Endpoints → neu:

- **Base URL:** `http://100.x.y.z:8000/v1`
- **API Key:** Wert von `VLLM_API_KEY`
- **Endpoint kind:** `local`
- **Supports tools:** an

Ein Endpoint reicht für alle drei Modelle. Nach `./run.sh <anderes-modell>`
die Modellliste des Endpoints aktualisieren, dann erscheint der neue Name
(`qwen3.8-27b`, `qwen3.8-flash-next`, `glm-5.3-flash`).

Die Qwen-Namen müssen „qwen“ enthalten — daran erkennt Talos die
Qwen-Sampling-Profile und den Reasoning-Effort-Regler (`src/llm_core.py`).

Messwerte für den Vergleich gehören in
`docs/benchmarks/Modelltest_Spark_vs_H200.xlsx`; die Startparameter für das
Blatt „Setups“ stehen in der jeweiligen `models/*.yaml`.

## Troubleshooting

- **Tool-Calls kommen als Text:** `tool-call-parser` in der YAML passt nicht
  zum Modell (Qwen3.8: `qwen3_coder`, GLM-5.3: `glm47`).
- **`needs N GPUs, this host has 1`:** siehe Tabelle oben — größere
  IONOS-Konfiguration nötig.
- **`via DERP` statt direkt:** UDP 41641 bei IONOS nicht offen, oder die
  Firmen-Firewall blockiert ausgehendes UDP. Funktioniert, ist aber langsamer.
- **OOM beim Start:** `max-model-len` oder `max-num-seqs` in der YAML senken.
- **Mehrere GPUs, CUDA-Init schlägt fehl:** Bei HGX-Systemen mit NVSwitch
  braucht der Host ggf. `nvidia-fabricmanager-<treiberversion>`
  (`nvidia-smi topo -m` zeigt `NV18` zwischen den GPUs).
- **Container startet neu, Healthcheck failt:** Gewichte laden noch —
  `./run.sh logs`. Vorher `./run.sh download` spart das beim Start.
