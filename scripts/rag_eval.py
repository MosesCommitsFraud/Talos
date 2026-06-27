#!/usr/bin/env python3
"""RAG eval harness — Recall@k / MRR over a JSONL question→expected-source set.

Phase 0 of the RAG plan: a baseline you measure *before* changing models, chunk
sizes, or adding the Phase 7/8 retrieval layers, so "did it get better?" is a
number, not a vibe.

Eval file (one JSON object per line; ``#`` lines and blanks ignored):

    {"q": "How do I rotate the API key?", "sources": ["api_keys.md"]}
    {"q": "Where is the sandbox timeout set?", "source": "docker-compose.yml"}

``sources`` (list) or ``source`` (single) are both accepted; a question counts as
a hit if any expected source appears in the top-k results (basename match).

Usage:
    python scripts/rag_eval.py --eval data/rag_eval.jsonl --base-url http://localhost:7000 --k 10
    python scripts/rag_eval.py ... --save-baseline data/rag_eval.baseline.json

Auth: ``/api/rag/search`` is admin-gated. Pass a logged-in session cookie via
``--cookie`` or the ``RAG_EVAL_COOKIE`` env (e.g. "talos_session=…").
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List

Fetch = Callable[[str, int], List[Dict[str, Any]]]


def load_eval(path: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(json.loads(line))
    return entries


def expected_sources(entry: Dict[str, Any]) -> List[str]:
    if entry.get("sources"):
        return [str(s) for s in entry["sources"]]
    if entry.get("source"):
        return [str(entry["source"])]
    return []


def source_matches(expected: str, result_name: str) -> bool:
    """Lenient match: exact, basename‑equal, or either basename contained in the
    other (results store a basename; eval files may give a path)."""
    if not expected or not result_name:
        return False
    e, r = expected.strip().lower(), str(result_name).strip().lower()
    eb, rb = e.rsplit("/", 1)[-1], r.rsplit("/", 1)[-1]
    return e == r or eb == rb or eb in r or rb in e


def hit_rank(expected_list: List[str], results: List[Dict[str, Any]]) -> int:
    """1‑based rank of the first result matching any expected source, else 0."""
    for i, res in enumerate(results, 1):
        name = res.get("filename") or res.get("source") or ""
        if any(source_matches(e, name) for e in expected_list):
            return i
    return 0


def recall_at_k(expected_list: List[str], results: List[Dict[str, Any]], k: int) -> float:
    return 1.0 if hit_rank(expected_list, results[:k]) else 0.0


def reciprocal_rank(expected_list: List[str], results: List[Dict[str, Any]]) -> float:
    rank = hit_rank(expected_list, results)
    return 1.0 / rank if rank else 0.0


def evaluate(entries: List[Dict[str, Any]], fetch: Fetch, k: int) -> Dict[str, Any]:
    rows: List[Dict[str, Any]] = []
    recall_sum = mrr_sum = 0.0
    n = 0
    for e in entries:
        exp = expected_sources(e)
        if not exp:
            continue
        results = fetch(e["q"], k)
        rank = hit_rank(exp, results)
        recall = 1.0 if 0 < rank <= k else 0.0
        rr = 1.0 / rank if rank else 0.0
        recall_sum += recall
        mrr_sum += rr
        n += 1
        rows.append({"q": e["q"], "expected": exp, "hit_rank": rank, "recall": recall})
    return {
        "n": n,
        "k": k,
        "recall_at_k": round(recall_sum / n, 4) if n else 0.0,
        "mrr": round(mrr_sum / n, 4) if n else 0.0,
        "rows": rows,
    }


def _http_fetch(base_url: str, cookie: str) -> Fetch:
    import httpx

    headers = {"Cookie": cookie} if cookie else {}
    base = base_url.rstrip("/")

    def fetch(q: str, k: int) -> List[Dict[str, Any]]:
        resp = httpx.get(
            f"{base}/api/rag/search", params={"q": q, "k": k}, headers=headers, timeout=60
        )
        resp.raise_for_status()
        return resp.json().get("results") or []

    return fetch


def _print_report(summary: Dict[str, Any]) -> None:
    print(f"\nRAG eval — {summary['n']} questions, k={summary['k']}\n" + "-" * 60)
    for row in summary["rows"]:
        mark = f"@{row['hit_rank']}" if row["hit_rank"] else "MISS"
        print(f"  [{mark:>5}] {row['q'][:64]}")
    print("-" * 60)
    print(f"  Recall@{summary['k']}: {summary['recall_at_k']:.3f}    MRR: {summary['mrr']:.3f}\n")


def main(argv: List[str] | None = None) -> Dict[str, Any]:
    ap = argparse.ArgumentParser(description="RAG eval: Recall@k / MRR over a JSONL set")
    ap.add_argument("--eval", default="data/rag_eval.jsonl")
    ap.add_argument("--base-url", default="http://localhost:7000")
    ap.add_argument("--cookie", default=os.getenv("RAG_EVAL_COOKIE", ""))
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--save-baseline", default="")
    args = ap.parse_args(argv)

    entries = load_eval(args.eval)
    summary = evaluate(entries, _http_fetch(args.base_url, args.cookie), args.k)
    _print_report(summary)
    if args.save_baseline:
        keep = {key: summary[key] for key in ("n", "k", "recall_at_k", "mrr")}
        Path(args.save_baseline).write_text(json.dumps(keep, indent=2))
        print(f"  baseline saved → {args.save_baseline}\n")
    return summary


if __name__ == "__main__":
    main()
