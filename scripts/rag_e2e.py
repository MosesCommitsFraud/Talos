#!/usr/bin/env python3
"""RAG end-to-end eval: real questions through the real agent loop.

``rag_eval.py`` only asks whether the right file comes back. This one runs a whole
turn (auto-injected context, the model's own tool calls, the final answer) and
reports what the turn cost next to whether the answer was right: rounds, tool calls,
tokens, seconds, and turns that searched without finding anything new.

Eval file (one JSON object per line; ``#`` lines and blanks ignored). Keep files
built from company documents out of the repository.

    {"q": "Wie öffne ich die Funktionen?", "must": ["Strg\\\\s*\\\\+?\\\\s*M"], "kind": "fakt"}
    {"q": "Welche Telefonnummer hat der Support?", "must": ["nicht hinterlegt"],
     "forbid": ["\\\\d{5,}"], "kind": "fehlt"}

Every ``must`` regex has to match the answer and no ``forbid`` regex may, both
case-insensitive.

Against a configured Talos environment (EMBEDDING_URL, RERANK_URL, QDRANT_URL, ...):

    python scripts/rag_e2e.py --eval evals.jsonl --endpoint http://host:8000/v1 --model qwen3-llm

With a throwaway in-memory index, touching no existing data:

    python scripts/rag_e2e.py --eval evals.jsonl --endpoint ... --model ... \\
        --memory-index --ingest manual.md --embedding-url http://host:8001/v1 \\
        --embedding-model qwen3-embed --rerank-url http://host:8002/v1/rerank \\
        --rerank-model qwen3-reranker

``--save run.json`` stores the rows, ``--compare base.json`` prints the difference.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

_THINK_RE = re.compile(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", re.IGNORECASE)
KNOWLEDGE_TOOLS = {"search_knowledge", "read_knowledge", "grep_knowledge", "list_knowledge"}


def load_eval(path: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            entries.append(json.loads(line))
    return entries


def visible_answer(text: str) -> str:
    return _THINK_RE.sub("", text or "").strip()


def is_correct(entry: Dict[str, Any], answer: str) -> bool:
    text = visible_answer(answer)
    if not text:
        return False
    if not all(re.search(p, text, re.IGNORECASE) for p in entry.get("must") or []):
        return False
    return not any(re.search(p, text, re.IGNORECASE) for p in entry.get("forbid") or [])


def parse_events(chunks: Iterable[str]) -> Dict[str, Any]:
    """What a turn did, from the SSE lines the agent loop yields."""
    answer = ""
    tools: List[Dict[str, Any]] = []
    rounds = 1
    metrics: Dict[str, Any] = {}
    for chunk in chunks:
        if not chunk.startswith("data: ") or chunk.startswith("data: [DONE]"):
            continue
        try:
            event = json.loads(chunk[6:])
        except json.JSONDecodeError:
            continue
        if "delta" in event and isinstance(event["delta"], str):
            answer += event["delta"]
        kind = event.get("type")
        if kind == "tool_start":
            tools.append({"tool": event.get("tool"), "command": str(event.get("command") or "")})
        elif kind == "agent_step":
            rounds = max(rounds, int(event.get("round") or 1))
        elif kind == "metrics":
            metrics = event.get("data") or {}
    return {"answer": answer, "tools": tools, "rounds": rounds, "metrics": metrics}


def row_for(
    entry: Dict[str, Any], parsed: Dict[str, Any], seconds: float, error: str = ""
) -> Dict[str, Any]:
    metrics = parsed.get("metrics") or {}
    tools = parsed.get("tools") or []
    answer = visible_answer(parsed.get("answer") or "")
    profile = metrics.get("round_profile") or []
    return {
        "q": entry["q"],
        "kind": entry.get("kind") or "",
        "ok": is_correct(entry, answer),
        "rounds": parsed.get("rounds") or 1,
        "tool_calls": len(tools),
        "knowledge_calls": sum(t.get("tool") in KNOWLEDGE_TOOLS for t in tools),
        "tools": [t.get("tool") for t in tools],
        "commands": [t.get("command") for t in tools],
        "input_tokens": int(metrics.get("input_tokens") or 0),
        "output_tokens": int(metrics.get("output_tokens") or 0),
        "tool_seconds": round(sum(float(r.get("tools_s") or 0) for r in profile), 2),
        "seconds": round(seconds, 2),
        "answer": answer,
        "error": error,
    }


def _mean(rows: List[Dict[str, Any]], key: str) -> float:
    return round(statistics.mean(r[key] for r in rows), 2) if rows else 0.0


def summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    kinds: Dict[str, List[int]] = {}
    for row in rows:
        counts = kinds.setdefault(row["kind"] or "-", [0, 0])
        counts[0] += bool(row["ok"])
        counts[1] += 1
    return {
        "n": len(rows),
        "correct": sum(bool(r["ok"]) for r in rows),
        "errors": sum(bool(r["error"]) for r in rows),
        "kinds": {k: f"{v[0]}/{v[1]}" for k, v in sorted(kinds.items())},
        "mean_rounds": _mean(rows, "rounds"),
        "max_rounds": max((r["rounds"] for r in rows), default=0),
        "mean_tool_calls": _mean(rows, "tool_calls"),
        "mean_knowledge_calls": _mean(rows, "knowledge_calls"),
        "mean_input_tokens": _mean(rows, "input_tokens"),
        "mean_output_tokens": _mean(rows, "output_tokens"),
        "mean_seconds": _mean(rows, "seconds"),
        "median_seconds": round(statistics.median(r["seconds"] for r in rows), 2) if rows else 0.0,
    }


def compare(base: Dict[str, Any], now: Dict[str, Any]) -> List[str]:
    lines = []
    for key in ("correct", "errors", "mean_rounds", "max_rounds", "mean_tool_calls",
                "mean_knowledge_calls", "mean_input_tokens", "mean_output_tokens",
                "mean_seconds", "median_seconds"):  # fmt: skip
        old, new = base.get(key, 0), now.get(key, 0)
        change = f" ({(new - old) / old:+.0%})" if old else ""
        lines.append(f"  {key:<22} {old:>10} -> {new:<10}{change}")
    return lines


def _print_report(rows: List[Dict[str, Any]], summary: Dict[str, Any]) -> None:
    print(f"\nRAG end-to-end, {summary['n']} questions\n" + "-" * 72)
    for row in rows:
        mark = "ok" if row["ok"] else "ERR" if row["error"] else "--"
        print(
            f"  [{mark:>3}] {row['rounds']}R {row['knowledge_calls']}K "
            f"{row['seconds']:6.1f}s  {row['q'][:52]}"
        )
    print("-" * 72)
    for key, value in summary.items():
        print(f"  {key:<22} {value}")
    wrong = [r for r in rows if not r["ok"]]
    if wrong:
        print("\nWrong answers:")
        for row in wrong:
            print(f"  - {row['q'][:70]}\n    {(row['error'] or row['answer'])[:300]!r}")


def _use_memory_index(args: argparse.Namespace) -> None:
    """Everything this run writes goes to a temp dir and an in-memory Qdrant."""
    scratch = tempfile.mkdtemp(prefix="rag_e2e_")
    os.environ["RAG_DATA_DIR"] = scratch
    os.environ["DATABASE_URL"] = f"sqlite:///{Path(scratch) / 'e2e.db'}"
    os.environ["QDRANT_URL"] = "memory"
    for name, env in (
        ("embedding_url", "EMBEDDING_URL"),
        ("embedding_model", "EMBEDDING_MODEL"),
        ("rerank_url", "RERANK_URL"),
        ("rerank_model", "RERANK_MODEL"),
        ("query_prefix", "RAG_QUERY_PREFIX"),
    ):
        value = getattr(args, name, "")
        if value:
            os.environ[env] = value


def _patch_store_to_memory() -> None:
    from src.rag_vector import VectorRAG

    def build(self, recreate: bool = False):
        from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

        return QdrantDocumentStore(
            location=":memory:",
            index=self.collection_name,
            embedding_dim=self._dim or 1024,
            use_sparse_embeddings=True,
            sparse_idf=True,
            recreate_index=recreate,
            return_embedding=False,
            wait_result_from_api=True,
        )

    VectorRAG._build_store = build


def _ingest(paths: List[str]) -> None:
    from src.rag_singleton import get_rag_manager

    rag = get_rag_manager()
    if not rag or not getattr(rag, "healthy", False):
        raise SystemExit("RAG is not available; check the embedding URL.")
    result = rag.index_files([(str(Path(p).resolve()), {}) for p in paths])
    if not result.get("success", True) or result.get("failed_count"):
        raise SystemExit(f"Ingest failed: {result}")
    print(f"Indexed {paths}: {result.get('message') or result}", file=sys.stderr)


async def _run_turn(entry: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    from src import agent_loop, citations
    from src.chat_processor import ChatProcessor
    from src.endpoint_resolver import build_chat_url, normalize_base

    session_id = f"e2e-{uuid.uuid4().hex[:12]}"
    citations.begin_turn(session_id)
    question = entry["q"]
    messages: List[Dict[str, Any]] = []
    started = time.time()
    chunks: List[str] = []
    try:
        if args.auto_inject:
            _, block = await asyncio.to_thread(
                ChatProcessor(None).retrieve, question, citation_session=session_id
            )
            if block:
                from src.prompt_security import untrusted_context_message

                messages.append(untrusted_context_message("retrieved documents", block))
        messages.append({"role": "user", "content": question})
        async for chunk in agent_loop.stream_agent_loop(
            build_chat_url(normalize_base(args.endpoint)),
            args.model,
            messages,
            headers={"Authorization": f"Bearer {args.api_key}"} if args.api_key else None,
            max_tokens=args.max_tokens,
            max_rounds=args.max_rounds,
            context_length=args.context_length,
            session_id=session_id,
            use_rag=True,
            reasoning=args.reasoning,
            tool_allowlist=KNOWLEDGE_TOOLS,
        ):
            chunks.append(chunk)
        error = ""
    except Exception as e:  # one bad turn must not lose the whole run
        error = f"{type(e).__name__}: {e}"
    return row_for(entry, parse_events(chunks), time.time() - started, error)


async def _run_all(entries: List[Dict[str, Any]], args: argparse.Namespace) -> List[Dict[str, Any]]:
    rows = []
    for index, entry in enumerate(entries, 1):
        row = await _run_turn(entry, args)
        rows.append(row)
        print(
            f"{index}/{len(entries)} {'ok' if row['ok'] else '--'} {row['rounds']}R "
            f"{row['seconds']:.1f}s {entry['q'][:60]}",
            file=sys.stderr,
            flush=True,
        )
    return rows


def main(argv: Optional[List[str]] = None) -> Dict[str, Any]:
    ap = argparse.ArgumentParser(description="RAG end-to-end eval through the agent loop")
    ap.add_argument("--eval", required=True)
    ap.add_argument("--endpoint", required=True, help="OpenAI-compatible base URL of the model")
    ap.add_argument("--model", required=True)
    ap.add_argument("--api-key", default=os.getenv("RAG_E2E_API_KEY", ""))
    ap.add_argument("--auto-inject", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--reasoning", action=argparse.BooleanOptionalAction, default=False)
    ap.add_argument("--max-rounds", type=int, default=12)
    ap.add_argument("--max-tokens", type=int, default=1500)
    ap.add_argument("--context-length", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0, help="only the first N questions")
    ap.add_argument("--memory-index", action="store_true")
    ap.add_argument("--ingest", nargs="*", default=[])
    ap.add_argument("--embedding-url", default="", dest="embedding_url")
    ap.add_argument("--embedding-model", default="", dest="embedding_model")
    ap.add_argument("--rerank-url", default="", dest="rerank_url")
    ap.add_argument("--rerank-model", default="", dest="rerank_model")
    ap.add_argument("--query-prefix", default="", dest="query_prefix")
    ap.add_argument("--save", default="")
    ap.add_argument("--compare", default="")
    args = ap.parse_args(argv)

    if args.memory_index:
        _use_memory_index(args)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    if args.memory_index:
        _patch_store_to_memory()
    if args.ingest:
        _ingest(args.ingest)

    entries = load_eval(args.eval)
    if args.limit:
        entries = entries[: args.limit]
    rows = asyncio.run(_run_all(entries, args))
    summary = summarize(rows)
    _print_report(rows, summary)
    if args.compare:
        base = json.loads(Path(args.compare).read_text(encoding="utf-8"))
        print(f"\nCompared with {args.compare}:")
        print("\n".join(compare(base.get("summary") or {}, summary)))
    if args.save:
        Path(args.save).write_text(
            json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    return summary


if __name__ == "__main__":
    main()
