"""Offline structural retrieval comparison; not a production quality benchmark.

Run from the repository root: python -m scripts.rag_structure_smoke_eval
Uses local Haystack BM25, synthetic evidence, and no model or network endpoint.
The fixed-width baseline is illustrative, not a recreation of historical Talos.
"""

import json
import time

from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_structure import assign_sections, expand_context, split_documents


def evaluate():
    chapters = []
    questions = []
    for topic in ("hydraulic", "thermal", "optical"):
        # The matching diagnostic and its necessary procedure span a boundary.
        lead = f"# {topic.title()}\n\n" + "Background. " * 250
        middle = f"Diagnostic {topic}marker: requires the following procedure.\n"
        evidence = f"Required {topic} procedure: isolate power and verify ZERO."
        chapters.append(lead + middle + "Details. " * 110 + evidence + "\n" + "Notes. " * 450)
        questions.append((f"{topic}marker", evidence))
    text = "\n\n".join(chapters)
    report = {}
    for mode in ("fixed_chars", "sections", "sections_with_neighbors"):
        if mode == "fixed_chars":
            docs = [
                Document(content=text[i : i + 4000], meta={"source": "manual.md"})
                for i in range(0, len(text), 4000)
            ]
        else:
            docs = split_documents([Document(content=text, meta={"source": "manual.md"})])
            assign_sections(docs)
        store = InMemoryDocumentStore()
        store.write_documents(docs)
        found, characters = 0, 0
        started = time.perf_counter()
        for query, evidence in questions:
            hits = store.bm25_retrieval(query, top_k=1)
            results = [{"id": d.id, "document": d.content, "metadata": d.meta} for d in hits]
            if mode == "sections_with_neighbors":
                expand_context(store, results, max_chars=12000, window=1)
            context = "\n".join(r.get("expanded") or r["document"] for r in results)
            found += evidence in context
            characters += len(context)
        report[mode] = {
            "questions": len(questions),
            "complete_evidence": found,
            "mean_context_chars": round(characters / len(questions)),
            "retrieval_ms_total": round(1000 * (time.perf_counter() - started), 2),
        }
    return report


if __name__ == "__main__":
    print(json.dumps(evaluate(), indent=2))
