#!/usr/bin/env python3
"""Spike: how does the VL embedding server accept image input?

Phase 0 of the RAG plan, and the gate for Phase 5 (pixel image lane). The exact
request shape for embedding an *image* differs by server — OpenAI-style
``/v1/embeddings`` with a base64 data URL vs. vLLM's ``/pooling`` endpoint — so
probe it before wiring the lane to it. Prints, for text and for an image, which
endpoint/shape returns a non-empty vector and its dimension.

Usage:
    python scripts/spike_vl_embed.py --url http://host:8004/v1/embeddings \
        --model qwen3-vl-embed --image tests/fixtures/screenshot.png
"""

from __future__ import annotations

import argparse
import base64
import mimetypes
from typing import Any, Dict, List, Optional

import httpx


def _vec_len(data: Dict[str, Any]) -> Optional[int]:
    """Pull an embedding vector length out of the common response shapes."""
    try:
        item = (data.get("data") or [{}])[0]
        emb = item.get("embedding") if isinstance(item, dict) else None
        if emb is None and isinstance(data.get("data"), list):
            emb = data["data"][0]  # bare-list pooling shape
        return len(emb) if emb else None
    except Exception:
        return None


def _try(url: str, payload: Dict[str, Any]) -> str:
    try:
        r = httpx.post(url, json=payload, timeout=60)
        r.raise_for_status()
        n = _vec_len(r.json())
        return f"OK dim={n}" if n else "200 but no vector found"
    except Exception as e:
        return f"FAIL {type(e).__name__}: {str(e)[:120]}"


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description="Probe a VL embedding endpoint for image input")
    ap.add_argument(
        "--url", required=True, help="Full embeddings URL, e.g. http://host:8004/v1/embeddings"
    )
    ap.add_argument("--model", default="")
    ap.add_argument("--image", required=True)
    args = ap.parse_args(argv)

    pooling_url = args.url.rsplit("/v1/", 1)[0] + "/pooling" if "/v1/" in args.url else args.url
    model = {"model": args.model} if args.model else {}

    mime = mimetypes.guess_type(args.image)[0] or "image/png"
    with open(args.image, "rb") as fh:
        data_url = f"data:{mime};base64,{base64.b64encode(fh.read()).decode()}"

    print(f"\nProbing {args.url}\n" + "-" * 60)
    print(
        f"  text   /v1/embeddings input=str        : {_try(args.url, {**model, 'input': 'a test query'})}"
    )
    print(
        f"  image  /v1/embeddings input=data_url    : {_try(args.url, {**model, 'input': data_url})}"
    )
    print(
        "  image  /v1/embeddings messages=image_url: "
        + _try(
            args.url,
            {
                **model,
                "messages": [
                    {
                        "role": "user",
                        "content": [{"type": "image_url", "image_url": {"url": data_url}}],
                    }
                ],
            },
        )
    )
    print(
        f"  image  /pooling      input=data_url     : {_try(pooling_url, {**model, 'input': data_url})}"
    )
    print("-" * 60)
    print("→ Wire VectorRAG._vl_embed to whichever line says OK.\n")


if __name__ == "__main__":
    main()
