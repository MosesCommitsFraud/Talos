#!/usr/bin/env python3
"""Does the reranker put the obviously right passage first?

Sends a fixed set of unambiguous query/passage cases (German, English and mixed)
to a vLLM reranker, the same way ``VectorRAG._rerank`` does, and reports the order.
This is a smoke check on a dozen hand-written cases, not a benchmark.

It also answers the two questions that explain a bad result:

* Is the server applying the model's prompt template? For Qwen3 rerankers
  ``/v1/rerank`` should bill far more tokens per pair than query + passage alone.
  If the counts are equal, the server only concatenated the two texts.
* What would the scores be with the right prompt? ``--compare`` renders the prompt
  from the model card here and scores it through ``/pooling``, so the effect of a
  server fix can be measured without restarting anything.

Usage:
    python scripts/check_reranker.py --url http://host:8002/v1/rerank
    python scripts/check_reranker.py --url http://host:8002/v1/rerank --compare

Exit code: 0 if every case ranks the right passage first over ``/v1/rerank``,
1 if not, 2 if the server could not be queried.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Dict, List, NamedTuple, Optional
from urllib.parse import urlsplit

DEFAULT_MODEL = "qwen3-reranker"
DEFAULT_GATE = 0.30  # rerank_min_score default in routes/rag_routes.py

# Prompt from the Qwen3-VL-Reranker model card and vLLM's
# examples/pooling/score/template/qwen3_vl_reranker.jinja, including its missing
# space and line break between the instruction and "<Query>:".
INSTRUCTION = "Given a search query, retrieve relevant candidates that answer the query."
PROMPT = (
    "<|im_start|>system\n"
    "Judge whether the Document meets the requirements based on the Query and the "
    'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
    "<Instruct>: {instruction}<Query>:{query}\n"
    "<Document>:{document}<|im_end|>\n"
    "<|im_start|>assistant\n"
)


class Case(NamedTuple):
    query: str
    right: str
    wrong: List[str]


PIVOT = (
    "Eine Pivot-Tabelle fasst große Datenmengen zusammen und gruppiert sie nach frei "
    "wählbaren Zeilen und Spalten."
)

CASES: List[Case] = [
    # German
    Case(
        "Wie richte ich den Datentransfer nach Power BI ein?",
        "Den Datentransfer nach Power BI richten Sie unter Einstellungen > Export ein, "
        "indem Sie dort den Zielarbeitsbereich und den Zeitplan festlegen.",
        [
            "Für das Kartoffelgratin die Kartoffeln in dünne Scheiben schneiden und mit "
            "Sahne im Ofen backen.",
            "Die Datenart legt fest, ob ein Feld Text, Zahlen oder ein Datum enthält.",
        ],
    ),
    Case("Was ist eine Pivot?", PIVOT, ["12 45 78 90 33 21 67 54", "Bitte hier klicken."]),
    Case(
        "Was ist eine Pivot in macs?",
        PIVOT,
        ["12 45 78 90 33 21 67 54", "Die Kantine öffnet montags bis freitags um elf Uhr."],
    ),
    Case(
        "Wie hoch ist der Urlaubsanspruch pro Jahr?",
        "Alle Beschäftigten haben Anspruch auf 30 Tage bezahlten Urlaub im Kalenderjahr.",
        [
            "Reisekosten werden innerhalb von vier Wochen nach Einreichung erstattet.",
            "Der Drucker im zweiten Stock ist wegen Wartung außer Betrieb.",
        ],
    ),
    Case(
        "Wann wurde die Berliner Mauer gebaut?",
        "Die Berliner Mauer wurde im August 1961 errichtet.",
        [
            "Der Eiffelturm steht in Paris und wurde 1889 fertiggestellt.",
            "Bananen enthalten viel Kalium.",
        ],
    ),
    Case(
        "Wie setze ich mein Passwort zurück?",
        "Klicken Sie auf der Anmeldeseite auf „Passwort vergessen“ und folgen Sie dem "
        "Link in der E-Mail.",
        [
            "Das Firmenlogo darf nur in den freigegebenen Farben verwendet werden.",
            "Die Kantine öffnet montags bis freitags um elf Uhr.",
        ],
    ),
    # German, distractors on the same topic
    Case(
        "Wie exportiere ich einen Bericht als PDF?",
        "Öffnen Sie den Bericht und wählen Sie Datei > Exportieren > PDF.",
        [
            "Berichte können nach Datum und Abteilung gefiltert werden.",
            "Ein PDF-Dokument lässt sich mit jedem gängigen Reader öffnen.",
        ],
    ),
    # English
    Case(
        "What is the capital of France?",
        "The capital of France is Paris.",
        ["Bananas are yellow fruits rich in potassium.", "The Rhine flows through Germany."],
    ),
    Case(
        "How do I reverse a list in Python?",
        "Call list.reverse() to reverse a Python list in place, or use slicing with "
        "[::-1] to get a reversed copy.",
        [
            "The Pacific is the largest ocean on Earth.",
            "Preheat the oven to 200 degrees before baking the bread.",
        ],
    ),
    Case(
        "What causes rain?",
        "Rain forms when water vapour condenses into droplets in clouds that grow heavy "
        "enough to fall.",
        ["The stock exchange closes at five in the afternoon.", "Cats sleep for most of the day."],
    ),
    # Query and passage in different languages
    Case(
        "Wie viele Planeten hat unser Sonnensystem?",
        "Our solar system has eight planets orbiting the sun.",
        ["Bread is made from flour, water and yeast.", "The meeting was moved to Tuesday."],
    ),
    Case(
        "What is the boiling point of water?",
        "Wasser siedet auf Meereshöhe bei 100 Grad Celsius.",
        ["Die Hauptstadt von Spanien ist Madrid.", "Der Zug nach Hamburg fährt von Gleis 7."],
    ),
]


def post(url: str, payload: Dict, api_key: str = "") -> Dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, json.dumps(payload).encode("utf-8"), headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


class Reranker:
    def __init__(self, url: str, model: str, api_key: str = ""):
        parts = urlsplit(url)
        self.url = url
        self.base = f"{parts.scheme}://{parts.netloc}"
        self.model = model
        self.api_key = api_key

    def _post(self, url: str, payload: Dict) -> Dict:
        return post(url, {"model": self.model, **payload}, self.api_key)

    def scores_as_served(self, query: str, documents: List[str]) -> List[float]:
        """Scores from /v1/rerank, in the order of ``documents``."""
        results = self._post(self.url, {"query": query, "documents": documents})["results"]
        scores = [0.0] * len(documents)
        for item in results:
            scores[item["index"]] = float(item["relevance_score"])
        return scores

    def scores_with_template(self, query: str, documents: List[str]) -> List[float]:
        """Scores for the model-card prompt, rendered here and sent through /pooling."""
        prompts = [
            PROMPT.format(instruction=INSTRUCTION, query=query, document=document)
            for document in documents
        ]
        data = self._post(f"{self.base}/pooling", {"input": prompts, "task": "classify"})["data"]
        return [float(item["data"][0]) for item in sorted(data, key=lambda d: d["index"])]

    def token_count(self, text: str) -> int:
        return int(self._post(f"{self.base}/tokenize", {"prompt": text})["count"])

    def template_applied(self) -> Optional[bool]:
        """Compare billed tokens with the bare texts; None if the server won't say."""
        query, document = "What is the capital of France?", "The capital of France is Paris."
        try:
            usage = self._post(self.url, {"query": query, "documents": [document]})["usage"]
            bare = self.token_count(query) + self.token_count(document)
            return int(usage["prompt_tokens"]) > bare + 4
        except (urllib.error.URLError, KeyError, ValueError):
            return None


def report(title: str, score, gate: float) -> int:
    """Print one result table and return how many cases ranked wrongly."""
    print(f"\n{title}")
    print(f"{'':2} {'right':>6} {'best wrong':>10} {'gap':>7}  query")
    misses = below_gate = above_gate = 0
    gaps: List[float] = []
    for case in CASES:
        scores = score(case.query, [case.right, *case.wrong])
        right, best_wrong = scores[0], max(scores[1:])
        gap = right - best_wrong
        gaps.append(gap)
        missed = right <= best_wrong
        misses += missed
        below_gate += right < gate
        above_gate += best_wrong >= gate
        mark = "x " if missed else "ok"
        print(f"{mark} {right:6.3f} {best_wrong:10.3f} {gap:+7.3f}  {case.query}")
    total = len(CASES)
    print(f"Right passage first: {total - misses}/{total}, mean gap {sum(gaps) / total:+.3f}")
    print(
        f"At gate {gate:.2f}: right passage dropped in {below_gate}/{total} cases, "
        f"a wrong passage let through in {above_gate}/{total}"
    )
    return misses


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url", required=True, help="e.g. http://host:8002/v1/rerank")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key", default="")
    parser.add_argument(
        "--gate", type=float, default=DEFAULT_GATE, help="rerank_min_score to evaluate"
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        help="also score the model-card prompt through /pooling",
    )
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    reranker = Reranker(args.url, args.model, args.api_key)
    try:
        applied = reranker.template_applied()
        state = {True: "yes", False: "NO, query and passage are only concatenated", None: "unknown"}
        print(f"Server applies a prompt template on /v1/rerank: {state[applied]}")
        misses = report("/v1/rerank as served", reranker.scores_as_served, args.gate)
        if args.compare:
            report("Model-card prompt via /pooling", reranker.scores_with_template, args.gate)
    except (urllib.error.URLError, KeyError, ValueError) as error:
        print(f"Could not query the reranker: {error}", file=sys.stderr)
        return 2
    return 1 if misses else 0


if __name__ == "__main__":
    sys.exit(main())
