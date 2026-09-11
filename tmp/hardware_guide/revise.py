from pathlib import Path
p=Path('C:/DEV/Talos/tmp/hardware_guide/build.py')
s=p.read_text(encoding='utf-8')
a=s.index("page('4 Speicher")
b=s.index("page('9 Software")
s=s[:a]+'''page('4 Lokale Geschwindigkeit im Vergleich')
p('Veröffentlichte Fremdmessungen, keine eigenen Talos-Messungen. Die Werte beschreiben unterschiedliche Laufzeiten, Quantisierungen und Aufgaben; sie erlauben eine Größenordnung, aber keine kontrollierte Hardware-Rangliste.')
table(['Modell und Hardware','Gemessene Ausgabe','Testbedingungen und Quelle'],[
('Qwen3.6-35B · 1 Spark','67,4 t/s','Q4_K_M, llama-bench, ein Stream. [S20]'),
('Qwen3.8-27B · 1 GB10','24,7 t/s','vLLM mit MTP; Median aus sechs gemischten Aufgaben, davon drei deutsch. [S18]'),
('Qwen3.8-27B · AMD 395','14,0 / 30,6–36,0 t/s','Ohne / mit Greedy-MTP; ROCm FP4_FAST. Gewinn stark samplingabhängig. [S23]'),
('Qwen3.8-27B · M3 Ultra 256 GB','43,4 t/s','MLX 4 Bit, adaptives MTP, 8K Eingabe, Thinking aus; TTFT 24,7 s. [S24]'),
('Qwen3.8-27B · RTX PRO 6000','150 roh / 84 sichtbar t/s','Max-Q 300 W, NVFP4, vLLM mit MTP; Denk-Tokens erklären die Differenz. [S26]'),
('Qwen3.8-Flash-Next · 1 GB10','20,8–31,1 t/s','NVFP4, vLLM MTP 2; Prosa bis Code/Reasoning. [S18]'),
('Qwen3.8-Flash-Next · M3 Ultra','23,0 t/s','256 GB, MLX 4 Bit ohne MTP, 8K Eingabe; TTFT 9,4 s. [S24]'),
('DeepSeek-V4-Flash · 1 / 2 Sparks','ca. 14 / 38,5 t/s','1 Gerät: IQ2 + ds4; 2: gemischter offizieller Checkpoint, vLLM TP2 + MTP. [S20]'),
('GLM-5.3-Flash · 2 Sparks','19,6–30,3 t/s','NVFP4, vLLM MTP 5, Textmodus, Temperatur 0; Prosa bis strukturierte Ausgabe. [S21]'),
('GLM-5.3-Flash · 4 Sparks','31,6 t/s einzeln','NVFP4, vLLM TP4 + DFlash2, gemischte 4K-Prompts; TTFT 2,75 s. [S22]'),
('GLM-5.3-Flash · M3 Ultra','27,8 t/s','256 GB, MLX 4 Bit ohne MTP, 8K Eingabe; TTFT 22,8 s. [S24]')],[2.35,1.42,3.06],9.2)
h('Was sich daraus ableiten lässt')
p('Ein RTX-Server ist für schnelle Ausgabe ein plausibler Kandidat; ein Ultra bietet viel Speicher in einem Gerät. Zwei bis vier Sparks ermöglichen große Modelle mit dem vorhandenen NVIDIA-Stack. Vier Sparks liefern im GLM-Test bei vier parallelen Anfragen 64,1 t/s insgesamt, also etwa 16 t/s je Anfrage. Mehr Geräte bedeuten daher nicht proportional schnellere Einzelantworten. [S22]')
p('Für das volle GLM-5.3, M5 Ultra, PRO 495 und chinesische Plattformen liegt hier kein ausreichend dokumentierter, vergleichbarer lokaler Messwert vor. Die nächste Seite zeigt ergänzend unabhängige Modellbewertungen und API-Messungen von Artificial Analysis; deren Geschwindigkeiten sind keine Spark- oder RTX-Ergebnisse.')

page('5 Modellqualität mit Artificial Analysis')
p('Einheitliche Vergleichsbasis: Artificial Analysis Intelligence Index v4.2, abgerufen am 7. September 2026. Höher bedeutet besser im kombinierten Test; der Index ist keine Prozentquote richtiger Antworten. Ältere Indexversionen und Suchtreffer können andere Werte zeigen. [AA1–AA6]')
table(['Modell und Denkmodus','AA Index v4.2','AA API t/s','Lokale Einordnung'],[
('Qwen3.6-35B-A3B · Reasoning','26','124,9','Kompakter Einstieg auf einem Spark.'),
('Qwen3.8-27B · xhigh','41','47,2','Höherer Index bei kleiner Modellgröße; vorhandener Talos-Standard.'),
('Qwen3.8-Flash-Next','46','74,1','Mehr Qualität im Index; deutlich mehr Speicherbedarf.'),
('DeepSeek-V4-Flash 0731 · max','41','129,9','Hohe API-Ausgaberate; lokal auf zwei Sparks dokumentiert.'),
('GLM-5.3-Flash','46','56,1','Gleicher gerundeter Index wie Qwen Flash Next; auf zwei/vier Sparks gemessen.'),
('GLM-5.3 · max','49','77,7','Höchster Index dieser Auswahl; erheblich größere Hardware nötig.')],[2.13,.79,.86,3.05],9.5)
h('Der Vergleich in drei Aussagen')
p('Qwen3.8-27B erreicht hier 15 Indexpunkte mehr als Qwen3.6-35B-A3B. Qwen3.8-Flash-Next und GLM-5.3-Flash liegen jeweils fünf Punkte darüber. Das volle GLM-5.3 bringt weitere drei Punkte gegenüber den beiden Flash-Modellen; dieser Abstand ist gegen seinen viel größeren Speicherbedarf abzuwägen.')
p('DeepSeek-Flash und Qwen3.8-27B haben denselben gerundeten Index, unterscheiden sich aber bei Größe, Modalität und Einzelaufgaben. Der Gesamtwert allein bestimmt deshalb nicht das geeignete Talos-Modell. Ebenso bedeutet der gleiche Wert von Qwen Flash Next und GLM Flash keine identischen Fähigkeiten.')
p('AA misst die Ausgaberate der Anbieter-API beziehungsweise einen Median über Anbieter, falls keine eigene API vorhanden ist. Denkmodus, Wartezeit bis zur ersten Antwort und Anzahl der Denk-Tokens beeinflussen die tatsächlich erlebte Dauer. Die API-Werte dürfen nicht mit lokalen 4-Bit-Messungen zu einem Hardware-Ranking vermischt werden.')
h('Bedeutung für Talos')
p('Der Index bündelt zehn Prüfungen, unter anderem Wissensarbeit, Werkzeugnutzung, Coding und Dokumentenverständnis. Für Talos ergänzen korrekte Quellen, deutsche Antworten und erfolgreich ausgeführte Werkzeuge diese Orientierung. Die AA-Werte belegen nicht automatisch die Qualität eines lokalen NVFP4-, GGUF- oder MLX-Checkpoints. Ein größerer Indexabstand ist ein Auswahlhinweis, keine garantierte Verbesserung jeder einzelnen Aufgabe.')

''' +s[b:]
a=s.index("page('9 Software")
b=s.index("page('12 Terminologie")
s=s[:a]+'''page('6 So arbeitet die Software in Talos')
p('Der vorliegende Talos-Projektstand verbindet eine React-Oberfläche mit einem Python-Backend, getrennten Modellservern und Diensten für Dokumente und Werkzeuge. Die Tabelle zeigt die tatsächlich verwendete Software aus Compose-Datei, Abhängigkeiten, Architektur und Setup-Guide. [L1–L5]')
table(['Talos-Baustein','Verwendete Software','Konkrete Rolle'],[
('Oberfläche und Anwendung','React 19, TypeScript, Vite; FastAPI und Uvicorn','Weboberfläche; Backend steuert Chat, Dateien und Agentenschleife. Service talos-app, Port 7000.'),
('Chatmodell','vLLM; Qwen3.8-27B-NVFP4','Setup-Endpunkt 8000; Qwen3.6-35B-A3B-NVFP4 als Alternative. Talos verbindet sich über LLM_HOST(S).'),
('Suchmodelle','Qwen3-VL-Embedding-2B; Qwen3-VL-Reranker-2B','Separate Endpunkte 8001 und 8002: Suchvektoren erzeugen und Treffer neu sortieren.'),
('Dokumente und Suche','Docling, Haystack, FastEmbed; Qdrant','Dateien auslesen und zerlegen; dichte Vektorsuche plus BM25-Begriffsabgleich; Fundstellen für Antworten.'),
('Hintergrundverarbeitung','RQ und Redis-Client; Valkey 8','Service rag-redis verwendet Valkey. rag-ingest-worker verarbeitet Uploads außerhalb der Chat-Anfrage.'),
('Daten und Gedächtnis','SQLAlchemy mit SQLite/PostgreSQL; optional Chroma','Anwendungsdaten in SQL; Chroma für Memory-/Tool-Index laut Architektur. Dokumenten-RAG verwendet Qdrant.'),
('Web und Codearbeit','SearxNG; talos-sandbox','Websuche und separate Ausführungsumgebung. Sandbox im internen Netz, Compose-Limit 6 GB RAM und 4 CPUs.'),
('Werkzeuge und Sprache','Python MCP SDK; optional Qwen3-ASR-1.7B','MCP verbindet Tools und Daten. ASR-Endpunkt 8003 übernimmt optionale Transkription.')],[1.34,2.31,3.18],9.2)
h('Beispiel einer Dokumentenfrage in Talos')
p('Upload → RQ/Valkey → Ingest-Worker → Docling und Haystack → Embeddings → Qdrant. Anschließend: Frage aus React → FastAPI → hybride Suche mit Zugriffsf ilter → Reranker → relevante Textstellen zum Qwen-Modell → Antwort mit Quellen in der Oberfläche.'.replace('Zugriffsf ilter','Zugriffsfilter'))
h('MCP am konkreten Talos Aufbau')
p('Die Agentenschleife kann als MCP-Client externe Werkzeuge aufrufen. Umgekehrt bietet Talos unter /mcp einen eigenen Server mit stateless Streamable HTTP: externe Clients können freigegebene Dokumente, Skills und Webfunktionen lesen. Dazu gehören Scopes wie rag:read, skills:read und web:read. MCP vermittelt Werkzeugaufrufe; vLLM führt das Sprachmodell aus. [L3–L4, S27]')
p('Docker Compose betreibt die Talos-Dienste; die Modellendpunkte können auf dem Spark oder einem separaten RTX-Server liegen. Ein Hardwarewechsel am Modellserver ist deshalb möglich, ohne die gesamte Talos-Anwendung umzuziehen. Der Setup-Guide beschreibt die Endpunkte; daraus folgt keine Aussage, welche Dienste gerade aktiv laufen.')

page('7 Hardware Upgrades und ihre Wirkung')
p('Die Ausbaupfade beziehen sich auf zusätzliche oder ersetzte Hardware. Entscheidend ist der verbleibende Engpass: Modellkapazität, gleichzeitige Anfragen, Antworttempo oder Datenverarbeitung.')
table(['Hardware Upgrade','Nutzen','Grenzen und Voraussetzungen'],[
('Zweiter Spark','256 GB nomineller Gesamtspeicher; größeres verteiltes Modell oder zweiter unabhängiger Modellserver.','RAM wird nicht automatisch zusammengelegt. Im Cluster entstehen Netzwerkaufwand und Abhängigkeit vom zweiten Gerät.'),
('Ausbau auf vier Sparks','512 GB nominell; mehr Modell-/Cachekapazität oder mehrere parallele Modellinstanzen.','Geeignete schnelle Verkabelung und Topologie nötig. NVIDIA Cluster Assistant sieht vier Geräte mit Switch vor. [S2]'),
('Schnelles Clusternetz','Passende ConnectX-Verbindungen, DAC-/AOC-Kabel und gegebenenfalls RoCE-fähiger Switch.','Verteilte Inferenz profitiert von geringer Latenz und hoher Bandbreite. Normales 10-GbE ist kein gleichwertiger Ersatz für das schnelle Modellnetz.'),
('RTX PRO 6000 Blackwell ergänzen','96 GB schneller VRAM je Karte; zwei/vier Karten ergeben 192/384 GB verteilt.','CPU-PCIe-Lanes, P2P, Steckplatzabstand, Gehäuse, Netzteil und Kühlung für den Endausbau auslegen.'),
('RTX 6000 Ada durch Blackwell ersetzen','48 auf 96 GB je Karte; Bandbreite von 960 auf 1.792 GB/s und Blackwell-Rechenformate. [S4, S12]','Generationswechsel der GPU; Edition und Leistungsaufnahme prüfen. Eine zusätzliche Ada-Karte bietet nicht dieselben Formate.'),
('Mehr NVMe Speicher','Platz für Modelle, Dokumente, Indizes und parallele Modellstände; schnelleres Laden bei passender SSD.','Erhöht den GPU-Speicher nicht. Austauschbarkeit und Garantie beim konkreten GB10-OEM prüfen.'),
('Separater Talos Datenhost','Zusätzliche CPU, RAM und SSD für Upload, Indexierung, Datenbank und Sandbox; entlastet den Modellrechner.','Beispielplanung: 8–16 CPU-Kerne, 32–64 GB RAM, 1–2 TB NVMe. Last und Datenbestand bestimmen den tatsächlichen Bedarf.'),
('Apple oder AMD mit mehr Speicher','Ultra mit 256/512 GB oder AMD PRO 495 mit bis 192 GB als Kapazitätsausbau.','Integrierter Speicher meist beim Kauf festgelegt; praktisch Geräteersatz. M5 Ultra am Stichtag erst angekündigt. [S6, S9]')],[1.6,2.48,2.75],9.1)
h('Passender Ausbau nach Ziel')
p('Mehr parallele Qwen-Nutzer: zusätzlichen Modellrechner oder weitere RTX-Karte vorsehen. Größere Flash-Modelle: zwei Sparks, ein ausreichend großer Ultra oder einen Mehr-GPU-Server vergleichen. Kürzere Einzelantworten: RTX PRO 6000 anhand derselben Aufgaben gegen GB10 bewerten. Volles GLM-5.3: eigene große Speicherplattform planen; vier RTX-Karten mit 384 GB bieten bei etwa 375 GB reinen 4-Bit-Gewichten zu wenig Reserve.')

''' + s[b:]
s=s.replace("12 Terminologie", "8 Terminologie").replace("13 Terminologie", "9 Terminologie").replace("14 Terminologie", "10 Terminologie").replace("15 Quellen", "11 Quellen")
s=s.replace('Plattformvergleich Software Anforderungen und Erweiterungen','Plattformvergleich Software Leistung und Erweiterungen')
s=s.replace('Nachrichtenstand und Hardware → Speicherdimensionierung und Modelle → gemessene Geschwindigkeit und Qualität → Talos und MCP → Anforderungen und Upgrades → Glossar und Quellen.','Nachrichtenstand und Hardware → lokale Leistung und Artificial Analysis → Software in Talos → Hardware Upgrades → Glossar und Quellen.')
s=s.replace("for start in range(0,len(SOURCES),12):", """SOURCES += [
('AA1','Artificial Analysis Qwen3.6 35B A3B','https://artificialanalysis.ai/models/qwen3-6-35b-a3b','Reasoning; Index v4.2 und aktuelle API-Ausgaberate.'),
('AA2','Artificial Analysis Qwen3.8 27B','https://artificialanalysis.ai/models/qwen3-8-27b','xhigh; Index v4.2 und API-Messung; Methodenerklärung auf der Seite.'),
('AA3','Artificial Analysis Qwen3.8 Flash Next','https://artificialanalysis.ai/models/qwen3-8-flash-next','Index v4.2 und API-Ausgaberate.'),
('AA4','Artificial Analysis DeepSeek V4 Flash 0731','https://artificialanalysis.ai/models/deepseek-v4-flash','Reasoning max; aktueller Juli-Modellstand, Index v4.2.'),
('AA5','Artificial Analysis GLM 5.3 Flash','https://artificialanalysis.ai/models/glm-5-3-flash','Index v4.2 und API-Ausgaberate.'),
('AA6','Artificial Analysis GLM 5.3','https://artificialanalysis.ai/models/glm-5-3','Max; Index v4.2 und API-Ausgaberate. Alle AA-Werte sind dynamische Momentaufnahmen.')]
# Remove sources no longer cited after shortening the chapters.
SOURCES = [x for x in SOURCES if x[0] not in {'S14a','S14b','S14c','S17','S25'}]
for start in range(0,len(SOURCES),12):""")
s=s.replace("'[L4] docs/architecture/overview.md: FastAPI, React, Stores und Agentenablauf.'", "'[L4] docs/architecture/overview.md: FastAPI, React, Stores und Agentenablauf.','[L5] docs/architecture/rag-pipeline.md und web/package.json: konkrete Suchpipeline und Frontend-Abhängigkeiten.'")
s=s.replace('Hardware Software Modelle Anforderungen und Upgrades Stand September 2026','Hardware Software Modellvergleich und Hardware Upgrades Stand September 2026')
p.write_text(s,encoding='utf-8')
