from pathlib import Path
p=Path('C:/DEV/Talos/tmp/hardware_guide/build.py')
s=p.read_text(encoding='utf-8')
s=s.replace('September_2026_ueberarbeitet.docx','September_2026_Cowork.docx')
a=s.index("h('Relevante Aufgabenbenchmarks')")
b=s.index("page('6 So arbeitet",a)
s=s[:a]+'''h('Dokumentenerstellung und professionelle Aufgaben')
p('GDPval-AA v2 bewertet reale Berufsaufgaben mit Werkzeugen und Webzugriff; die Ergebnisse werden blind paarweise verglichen. AA-Briefcase untersucht komplexe Wissensarbeit mit Tabellen, Präsentationen und Memos und berücksichtigt fachliche Erfüllung, Analyse und Darstellung. Beide berichten Elo-Werte, keine Prozentquoten. [AA7–AA8]')
table(['Modell','GDPval AA v2 Elo','AA Briefcase Elo'],[
('Qwen3.6-35B-A3B · Reasoning','993 ±14','—'),
('Qwen3.8-27B · xhigh','—','—'),
('Qwen3.8-Flash-Next','1.650 ±17','—'),
('DeepSeek-V4-Flash 0731 · max','1.470 ±15','1.259 −7/+7'),
('GLM-5.3-Flash','1.671 ±16','—'),
('GLM-5.3 · max','1.678 ±16','1.515 −8/+9')],[3.03,1.9,1.9],9.5)
p('Momentaufnahme der aktuellen AA-Leaderboards vom 7. September; ± beziehungsweise −/+ zeigt das dort ausgewiesene Unsicherheitsintervall. — bedeutet: für genau diesen Modell-/Denkmodus hier kein verifizierter Einzelwert. Für Qwen 27B ist beispielsweise ein Wert ohne Reasoning sichtbar; er wird nicht dem xhigh-Modus zugeschrieben.')
p('GLM-5.3 und GLM-Flash liegen bei GDPval nur sieben Elo-Punkte auseinander; ihre Intervalle überlappen deutlich. Daraus lässt sich kein klarer Vorteil des wesentlich größeren Modells für Dokumentenarbeit ableiten. Qwen Flash Next liegt nahe an beiden. AA-Briefcase zeigt dagegen einen deutlichen Abstand zwischen GLM-5.3 und DeepSeek-Flash.')
p('AA-API-Geschwindigkeiten oben sind keine lokalen Hardwaremessungen. Die Qualität eines lokalen 4-Bit-Checkpoints und seiner Talos-Werkzeuge muss zur jeweiligen Modellbewertung passen.')

page('Wissen Recherche und Büroarbeit im Vergleich')
p('Für Talos zählen vollständige Arbeitsabläufe: Informationen finden, Quellen verstehen, Aussagen prüfen und daraus ein brauchbares Dokument erstellen. Die folgenden Werte stammen aus derselben Qwen-Vergleichstabelle; CoWorkBench ist ausdrücklich ein interner Anbietertest. Höher ist besser. [S14]')
table(['Benchmark und Schwerpunkt','Qwen 27B','Qwen Flash Next','DeepSeek Flash 0731'],[
('CoWorkBench · längere Büroaufgaben','70,7','73,9','45,1'),
('JobBench · berufliche Aufgaben','33,4','55,7','41,3'),
('Toolathlon Verified · Werkzeugabläufe','67,1','73,5','70,3'),
('IFBench · präzise Vorgaben einhalten','79,5','81,3','79,2'),
('HLE ohne Tools · breites schwieriges Wissen','30,8','35,9','33,8'),
('GPQA Diamond · wissenschaftliches Fachwissen','89,2','91,7','90,8')],[3.08,1.05,1.35,1.35],9.5)
p('Qwen Flash Next verbessert JobBench gegenüber Qwen 27B um 22,3 Punkte; bei CoWorkBench beträgt der Abstand nur 3,2 Punkte. DeepSeek liegt bei Toolathlon nahe an Qwen Flash Next, im internen CoWorkBench aber deutlich zurück. Das spricht für eine Auswahl nach Arbeitsaufgabe statt nach allgemeinem Modellrang.')
h('Welche Tests welchen Teil der Arbeit abdecken')
table(['Aufgabe','Passende Benchmarks und Bedeutung'],[
('Dokumente erstellen','AA-Briefcase und GDPval-AA: fertige Arbeitsergebnisse bewerten, einschließlich Qualität der Analyse und Präsentation. [AA7–AA8]'),
('Tabellen analysieren','AA-AnalystAgent: Zahlen aus Tabellen und Dokumenten herleiten. pass^5 verlangt fünf korrekte Wiederholungen, nicht nur einen erfolgreichen Versuch. [AA12]'),
('In Dokumenten recherchieren','AA-LCR v1.1: Informationen aus langen Texten verbinden. GDP.pdf: berufliche Dokumente verstehen und detaillierte Kriterien erfüllen. Das ist noch keine Bewertung des fertigen Word-Layouts. [AA9–AA10]'),
('Wissen zuverlässig nutzen','AA-Omniscience prüft Faktenwissen und Halluzinationen. HLE und GPQA ergänzen anspruchsvolles Wissen, messen aber keine aktuelle Webrecherche. [AA11, S14]'),
('Mehrstufige Arbeit erledigen','CoWorkBench, JobBench und Toolathlon bewerten längere Aufgaben beziehungsweise Werkzeuge; IFBench prüft genaue Ausgabevorgaben. [S14]')],[1.72,5.11],9.5)
p('Für AA-LCR, GDP.pdf, AA-Omniscience und AA-AnalystAgent wird hier kein nicht verifizierter Zielmodellwert ergänzt. Bei Webrecherche bleiben Aktualität, belastbare Quellen und korrekte Belege entscheidend; ein Wissensscore allein belegt das nicht. In Talos verbindet erst das Zusammenspiel aus Suche, Dokumentenverarbeitung, Modell und Dateierstellung diese Fähigkeiten.')
p('Coding bleibt eine ergänzende Fähigkeit: DeepSWE 1.1 nennt für Qwen 27B / Qwen Flash Next / DeepSeek Flash / GLM Flash / GLM groß die Werte 42,2 / 58,7 / 54,4 / 63,4 / 66,9. Anbieter verwenden unterschiedliche Agentenrahmen; daraus folgt keine Rangfolge für Büroarbeit. [S14–S16]')

''' +s[b:]
s=s.replace("# Remove sources no longer cited after shortening the chapters.","""SOURCES += [
('AA7','Artificial Analysis GDPval AA v2','https://artificialanalysis.ai/evaluations/gdpval-aa','Aktuelles Elo-Leaderboard und Berufsaufgaben; Werte können sich bei neuen Vergleichen ändern.'),
('AA8','Artificial Analysis AA Briefcase','https://artificialanalysis.ai/evaluations/aa-briefcase','Wissensarbeit, Memos, Tabellen und Präsentationen; aktuelle Elo-Werte und Unsicherheitsintervalle.'),
('AA9','Artificial Analysis Long Context Reasoning','https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning','Informationen aus langen Dokumenten extrahieren, verknüpfen und zusammenführen.'),
('AA10','Artificial Analysis GDP pdf','https://artificialanalysis.ai/evaluations/gdp-pdf','Detailliertes Verständnis professioneller Dokumente; keine reine Layoutbewertung.'),
('AA11','Artificial Analysis Omniscience','https://artificialanalysis.ai/evaluations/omniscience','Faktenwissen und Halluzinationen in unterschiedlichen Wissensgebieten.'),
('AA12','Artificial Analysis AnalystAgent','https://artificialanalysis.ai/evaluations/aa-analyst-agent','Quantitative Arbeit mit Dokumenten und Tabellen; pass^5 misst Erfolg in allen fünf Versuchen.')]
# Remove sources no longer cited after shortening the chapters.""")
p.write_text(s,encoding='utf-8')
