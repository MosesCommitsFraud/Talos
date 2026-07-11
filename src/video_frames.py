"""Keyframe extraction from screen-recording videos (RAG keyframe lane).

Training recordings mix a shared desktop with webcam tiles of participants.
The shared screen is what should be indexed; the webcam regions are permanent
motion (they would flood any naive scene detector) and must never be stored.

Strategy: sample frames at a fixed interval, ask the vision model for the
bounding box of the shared-desktop region on a few probe frames (the caller
injects that as ``detect_region`` so this module stays HTTP-free), crop every
frame to that region, then detect scene changes on the cropped frames with a
plain global diff — with the facecams cropped away a slide flip or dialog
change is a clean spike. A temporal variance mask over a tile grid survives
only as fallback for when the VLM detections disagree.

CPU-only (PIL + numpy); heavy imports live inside functions like the rest of
the ingest code so importing the module stays cheap.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Normalized (x1, y1, x2, y2), each in [0, 1].
Box = Tuple[float, float, float, float]

# Tile grid for the variance-mask fallback (rows, cols).
_GRID = (9, 16)
# Mean-abs-diff (0–255 grayscale) above which two consecutive samples of a
# tile / a cropped frame count as "changed".
_TILE_DIFF_THRESH = 8.0
_SCENE_DIFF_THRESH = 4.0
# A tile changing in at least this fraction of consecutive samples is treated
# as permanent motion (facecam, animation) by the fallback mask.
_ACTIVE_FRAC = 0.5
# Consecutive changed samples counting as continuous motion (e.g. an embedded
# video playing) — such stretches fall back to ~1 keyframe per minute.
_MOTION_RUN = 3
# Region detection: probes, minimum agreeing detections, agreement IoU and
# minimum area of an accepted desktop box.
_REGION_PROBES = 5
_REGION_MIN_AGREE = 3
_REGION_IOU = 0.7
_REGION_MIN_AREA = 0.30
# Analysis resolution for the grayscale diff stack (full-res stays on disk).
_ANALYSIS_W = 320


def extract_keyframes(
    video_path: str,
    detect_region: Callable[[Any], Optional[Box]],
    interval_sec: int = 8,
    max_frames: int = 300,
    progress: Optional[Callable[[str, int, int], None]] = None,
) -> List[Tuple[float, Any]]:
    """Extract ``[(timestamp_sec, cropped PIL.Image), …]`` from a video.

    ``detect_region`` receives a full-res PIL image and returns the normalized
    box of the shared-desktop area (or None). ``progress(stage, done, total)``
    reports the ``frames_sample`` and ``frames_region`` stages. Best-effort:
    returns ``[]`` on any failure (no ffmpeg, decode errors, empty video).
    """
    import shutil as _shutil

    tmpdir = None
    try:
        import tempfile

        from PIL import Image

        interval_sec = max(1, int(interval_sec or 8))
        tmpdir = tempfile.mkdtemp(prefix="talos_vframes_")
        if progress:
            progress("frames_sample", 0, 1)
        paths = _sample_frames(video_path, interval_sec, tmpdir)
        if progress:
            progress("frames_sample", 1, 1)
        if len(paths) < 2:
            return []

        stack = _load_gray_stack(paths)

        # Desktop region: VLM probes first, variance-mask rectangle as fallback,
        # full frame as last resort.
        box = _detect_desktop_region(paths, stack, detect_region, progress=progress)
        if box is None:
            box = _fallback_region(stack)
        if box is None:
            box = (0.0, 0.0, 1.0, 1.0)
        logger.info(
            "video-frames: %s samples, desktop region %s for %s",
            len(paths),
            tuple(round(c, 3) for c in box),
            os.path.basename(video_path),
        )

        cropped = _crop_stack(stack, box)
        indices = _select_indices(_frame_diffs(cropped), interval_sec)

        out: List[Tuple[float, Any]] = []
        hashes: List[int] = []
        for idx in indices:
            with Image.open(paths[idx]) as img:
                crop = _crop_image(img.convert("RGB"), box)
            h = _dhash(crop)
            if any(_hamming(h, prev) <= 4 for prev in hashes):
                continue
            hashes.append(h)
            out.append((float(idx * interval_sec), crop))
            if len(out) >= max(1, int(max_frames or 300)):
                break
        return out
    except Exception as e:
        logger.warning("video-frames: extraction failed for %s: %s", video_path, e)
        return []
    finally:
        if tmpdir:
            _shutil.rmtree(tmpdir, ignore_errors=True)


def _sample_frames(video_path: str, interval_sec: int, tmpdir: str) -> List[str]:
    """One PNG every ``interval_sec`` seconds (≤1280px wide) via ffmpeg.

    Frame N's timestamp is ``N * interval_sec``. Returns [] when ffmpeg is
    missing — the keyframe lane then quietly yields nothing (ASR unaffected).
    """
    import glob
    import shutil
    import subprocess

    if not shutil.which("ffmpeg"):
        logger.warning("video-frames: ffmpeg not found, skipping keyframes")
        return []
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video_path,
        "-vf",
        f"fps=1/{interval_sec},scale='min(1280,iw)':-2",
        "-vsync",
        "vfr",
        os.path.join(tmpdir, "frame_%06d.png"),
    ]
    subprocess.run(cmd, check=True, timeout=float(os.getenv("VIDEO_FRAMES_FFMPEG_TIMEOUT", "1800")))
    return sorted(glob.glob(os.path.join(tmpdir, "frame_*.png")))


def _load_gray_stack(paths: List[str]):
    """Frames as a (T, H, W) float32 grayscale stack at analysis resolution."""
    import numpy as np
    from PIL import Image

    frames = []
    size = None
    for p in paths:
        with Image.open(p) as img:
            if size is None:
                ratio = _ANALYSIS_W / max(1, img.width)
                size = (_ANALYSIS_W, max(1, int(img.height * ratio)))
            frames.append(np.asarray(img.convert("L").resize(size), dtype=np.float32))
    return np.stack(frames)


# ---------------------------------------------------------------- region ----


def _detect_desktop_region(
    paths: List[str],
    stack,
    detect_region: Callable[[Any], Optional[Box]],
    progress: Optional[Callable[[str, int, int], None]] = None,
) -> Optional[Box]:
    """Ask the VLM for the shared-desktop box on a few probe frames.

    Probes are spread across the video, skipping near-black frames (title
    cards, screen off). Accepted only when enough detections agree — layout
    is assumed stable for the whole recording."""
    from PIL import Image

    probes = _pick_probe_indices(stack, _REGION_PROBES)
    boxes: List[Box] = []
    for n, idx in enumerate(probes):
        try:
            with Image.open(paths[idx]) as img:
                box = detect_region(img.convert("RGB"))
        except Exception as e:
            logger.warning("video-frames: region probe failed: %s", e)
            box = None
        if box is not None and _box_area(box) >= _REGION_MIN_AREA:
            boxes.append(box)
        if progress:
            progress("frames_region", n + 1, len(probes))
    return _aggregate_boxes(boxes)


def _pick_probe_indices(stack, samples: int) -> List[int]:
    """Frame indices at ~10/30/50/70/90% of the video, skipping near-black."""
    total = stack.shape[0]
    picked: List[int] = []
    for frac in [0.1 + i * 0.8 / max(1, samples - 1) for i in range(samples)]:
        idx = min(total - 1, int(frac * total))
        # Walk forward past near-black frames (mean luminance < 8).
        for cand in range(idx, min(total, idx + 5)):
            if float(stack[cand].mean()) >= 8.0:
                idx = cand
                break
        if idx not in picked:
            picked.append(idx)
    return picked


def _box_area(box: Box) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = _box_area(a) + _box_area(b) - inter
    return inter / union if union > 0 else 0.0


def _aggregate_boxes(boxes: List[Box]) -> Optional[Box]:
    """Median box of the detections, when enough of them agree with it."""
    import numpy as np

    if len(boxes) < _REGION_MIN_AGREE:
        return None
    med = tuple(float(v) for v in np.median(np.asarray(boxes, dtype=np.float64), axis=0))
    agree = sum(1 for b in boxes if _iou(b, med) >= _REGION_IOU)
    if agree < _REGION_MIN_AGREE or _box_area(med) < _REGION_MIN_AREA:
        return None
    x1, y1, x2, y2 = med
    return (max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2))


# -------------------------------------------------- variance-mask fallback ----


def _tile_diffs(stack):
    """(T-1, rows, cols) mean abs diff of consecutive samples per grid tile."""
    import numpy as np

    rows, cols = _GRID
    diff = np.abs(stack[1:] - stack[:-1])  # (T-1, H, W)
    h_bounds = np.linspace(0, diff.shape[1], rows + 1).astype(int)[:-1]
    w_bounds = np.linspace(0, diff.shape[2], cols + 1).astype(int)[:-1]
    summed = np.add.reduceat(np.add.reduceat(diff, h_bounds, axis=1), w_bounds, axis=2)
    h_sizes = np.diff(np.append(h_bounds, diff.shape[1]))
    w_sizes = np.diff(np.append(w_bounds, diff.shape[2]))
    return summed / (h_sizes[None, :, None] * w_sizes[None, None, :])


def _variance_mask(tile_diffs) -> "Any":
    """Bool (rows, cols): True where a tile is permanent motion (facecam)."""
    return (tile_diffs > _TILE_DIFF_THRESH).mean(axis=0) >= _ACTIVE_FRAC


def _fallback_region(stack) -> Optional[Box]:
    """Largest static rectangle of the variance mask, as a normalized box.

    Used when the VLM detections don't agree: crops at tile granularity, good
    enough to cut a corner facecam or a sidebar strip out of the picture."""
    mask = _variance_mask(_tile_diffs(stack))
    rect = _largest_static_rect(mask)
    if rect is None:
        return None
    r1, c1, r2, c2 = rect
    rows, cols = mask.shape
    if (r2 - r1) * (c2 - c1) < _REGION_MIN_AREA * rows * cols:
        return None
    return (c1 / cols, r1 / rows, c2 / cols, r2 / rows)


def _largest_static_rect(mask) -> Optional[Tuple[int, int, int, int]]:
    """Largest all-static rectangle (r1, c1, r2, c2) in a noise mask.

    Standard largest-rectangle-in-binary-matrix via per-row histograms of
    consecutive static cells and a monotonic stack per row."""
    rows, cols = mask.shape
    heights = [0] * cols
    best = None
    best_area = 0
    for r in range(rows):
        for c in range(cols):
            heights[c] = 0 if mask[r][c] else heights[c] + 1
        stack: List[int] = []
        for c in range(cols + 1):
            h = heights[c] if c < cols else 0
            while stack and heights[stack[-1]] >= h:
                top = stack.pop()
                height = heights[top]
                left = stack[-1] + 1 if stack else 0
                area = height * (c - left)
                if area > best_area:
                    best_area = area
                    best = (r - height + 1, left, r + 1, c)
            stack.append(c)
    return best


# ---------------------------------------------------------------- scenes ----


def _crop_stack(stack, box: Box):
    """Crop the analysis stack to the (normalized) desktop box."""
    h, w = stack.shape[1], stack.shape[2]
    x1, y1 = int(box[0] * w), int(box[1] * h)
    x2, y2 = max(x1 + 1, int(box[2] * w)), max(y1 + 1, int(box[3] * h))
    return stack[:, y1:y2, x1:x2]


def _frame_diffs(stack):
    """(T-1,) global mean abs diff between consecutive (cropped) samples."""
    import numpy as np

    return np.abs(stack[1:] - stack[:-1]).mean(axis=(1, 2))


def _select_indices(diffs, interval_sec: int) -> List[int]:
    """Frame indices worth keeping: the settled frame after each scene change.

    A run of ≥ ``_MOTION_RUN`` consecutive changed pairs is continuous motion
    (embedded video, scrolling) — such stretches yield interval keyframes
    (~1/min) instead of one per sample, so they can't flood the lane."""
    changed = [bool(d > _SCENE_DIFF_THRESH) for d in diffs]
    total = len(changed) + 1
    per_min = max(1, int(60 // max(1, interval_sec)))
    selected = [0]
    i = 1
    while i < total:
        if changed[i - 1]:
            j = i
            while j < total and changed[j - 1]:
                j += 1
            if j - i >= _MOTION_RUN:
                selected.extend(range(i, j, per_min))
            if j - 1 < total:
                selected.append(j - 1)  # first stable frame of the new scene
            i = j
        else:
            i += 1
    return sorted({idx for idx in selected if 0 <= idx < total})


def _crop_image(img, box: Box):
    """Crop a full-res PIL image to the normalized desktop box (a copy)."""
    x1 = int(box[0] * img.width)
    y1 = int(box[1] * img.height)
    x2 = max(x1 + 1, int(box[2] * img.width))
    y2 = max(y1 + 1, int(box[3] * img.height))
    return img.crop((x1, y1, x2, y2))


# ----------------------------------------------------------------- dedup ----


def _dhash(img, size: int = 8) -> int:
    """Difference hash: 64-bit gradient signature, robust to small noise."""
    import numpy as np
    from PIL import Image

    a = np.asarray(img.convert("L").resize((size + 1, size), Image.LANCZOS), dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return (
        int(np.packbits(bits).view(">u8")[0])
        if bits.size == 64
        else int(sum(1 << i for i, b in enumerate(bits) if b))
    )


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")
