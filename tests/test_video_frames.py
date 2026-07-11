"""Unit tests for the video keyframe helpers (src/video_frames.py).

Pure logic on synthetic numpy frames and PIL images — no ffmpeg, no network.
The VLM region detector is injected as a stub callable, matching how the
ingest lane wires it in.
"""

import numpy as np
import pytest
from PIL import Image

import src.video_frames as vf


def _stack(t=20, h=90, w=160, base=50.0):
    """A static grayscale stack; tests paint noise/scene changes onto it."""
    return np.full((t, h, w), base, dtype=np.float32)


# ── variance-mask fallback ──


def test_variance_mask_flags_noisy_facecam_region():
    rng = np.random.default_rng(0)
    stack = _stack()
    # Facecam: right ~quarter of the frame flickers on every sample.
    stack[:, :, 120:] += rng.uniform(0, 120, size=(20, 90, 40)).astype(np.float32)
    mask = vf._variance_mask(vf._tile_diffs(stack))
    rows, cols = mask.shape
    assert mask[:, cols - 2 :].all()  # noisy strip detected
    assert not mask[:, : cols // 2].any()  # static desktop stays unmasked


def test_fallback_region_excludes_facecam_strip():
    rng = np.random.default_rng(1)
    stack = _stack()
    stack[:, :, 120:] += rng.uniform(0, 120, size=(20, 90, 40)).astype(np.float32)
    box = vf._fallback_region(stack)
    assert box is not None
    x1, y1, x2, y2 = box
    assert x1 == 0.0 and y1 == 0.0 and y2 == 1.0
    assert x2 <= 120 / 160 + 1e-6  # crop ends before the noisy strip


def test_fallback_region_none_when_everything_moves():
    rng = np.random.default_rng(2)
    stack = _stack() + rng.uniform(0, 120, size=(20, 90, 160)).astype(np.float32)
    assert vf._fallback_region(stack) is None


def test_largest_static_rect_simple():
    mask = np.zeros((4, 4), dtype=bool)
    mask[:, 3] = True  # right column is noise
    assert vf._largest_static_rect(mask) == (0, 0, 4, 3)


# ── VLM region aggregation ──


def test_aggregate_boxes_median_of_agreeing_detections():
    boxes = [(0.0, 0.0, 0.75, 1.0), (0.01, 0.0, 0.74, 0.99), (0.0, 0.01, 0.76, 1.0)]
    box = vf._aggregate_boxes(boxes)
    assert box is not None
    assert box[2] == pytest.approx(0.75, abs=0.02)


def test_aggregate_boxes_rejects_disagreement_and_too_few():
    disagreeing = [(0.0, 0.0, 0.5, 0.5), (0.5, 0.5, 1.0, 1.0), (0.0, 0.5, 0.5, 1.0)]
    assert vf._aggregate_boxes(disagreeing) is None
    assert vf._aggregate_boxes([(0.0, 0.0, 1.0, 1.0)] * 2) is None  # < min agree


def test_detect_desktop_region_uses_injected_callable(tmp_path):
    paths = []
    for i in range(10):
        p = tmp_path / f"f{i}.png"
        Image.new("RGB", (160, 90), (90, 90, 90)).save(p)
        paths.append(str(p))
    stack = _stack(t=10)
    calls = []

    def detect(img):
        calls.append(img.size)
        return (0.0, 0.0, 0.8, 1.0)

    box = vf._detect_desktop_region(paths, stack, detect)
    assert box == (0.0, 0.0, 0.8, 1.0)
    assert len(calls) == vf._REGION_PROBES


# ── scene selection ──


def test_scene_change_selects_settled_frame():
    diffs = np.zeros(19, dtype=np.float32)
    diffs[9] = 30.0  # slide flip between samples 9 and 10
    assert vf._select_indices(diffs, interval_sec=8) == [0, 10]


def test_continuous_motion_falls_back_to_interval():
    diffs = np.full(19, 30.0, dtype=np.float32)  # e.g. embedded video playing
    got = vf._select_indices(diffs, interval_sec=8)
    per_min = max(1, 60 // 8)
    assert got[0] == 0
    # Interval keyframes, not one per sample.
    assert len(got) <= 2 + len(diffs) // per_min + 1


def test_static_video_keeps_only_first_frame():
    assert vf._select_indices(np.zeros(19, dtype=np.float32), interval_sec=8) == [0]


# ── crop + dedup ──


def test_crop_image_cuts_facecam_pixels():
    img = Image.new("RGB", (160, 90), (0, 0, 0))
    # "Facecam" in the right strip.
    for x in range(120, 160):
        for y in range(0, 30):
            img.putpixel((x, y), (255, 0, 0))
    crop = vf._crop_image(img, (0.0, 0.0, 0.75, 1.0))
    assert crop.size == (120, 90)
    assert crop.getextrema() == ((0, 0), (0, 0), (0, 0))  # no red survived


def test_dhash_dedup_distances():
    a = Image.new("L", (64, 64), 100)
    b = Image.new("L", (64, 64), 100)
    gradient = Image.frombytes(
        "L", (64, 64), bytes(bytearray((x * 4) % 256 for _ in range(64) for x in range(64)))
    )
    assert vf._hamming(vf._dhash(a), vf._dhash(b)) == 0
    assert vf._hamming(vf._dhash(a), vf._dhash(gradient)) > 4


# ── top-level behaviour ──


def test_extract_keyframes_best_effort_without_ffmpeg(monkeypatch, tmp_path):
    """No ffmpeg → no frames → [] (never raises)."""
    monkeypatch.setattr("shutil.which", lambda name: None)
    out = vf.extract_keyframes(str(tmp_path / "clip.mp4"), detect_region=lambda i: None)
    assert out == []


def test_extract_keyframes_reports_stages(monkeypatch, tmp_path):
    # Two "slides" with distinct structure (flat colors would dHash-collide).
    frames_dir_imgs = []
    for i in range(6):
        img = Image.new("RGB", (160, 90), (40, 40, 40))
        box = (10, 10, 60, 40) if i < 3 else (90, 50, 150, 85)
        img.paste((230, 230, 230), box)
        frames_dir_imgs.append(img)

    def fake_sample(video_path, interval_sec, tmpdir):
        paths = []
        for i, img in enumerate(frames_dir_imgs):
            p = f"{tmpdir}/frame_{i:06d}.png"
            img.save(p)
            paths.append(p)
        return paths

    monkeypatch.setattr(vf, "_sample_frames", fake_sample)
    stages = []
    out = vf.extract_keyframes(
        str(tmp_path / "clip.mp4"),
        detect_region=lambda img: (0.0, 0.0, 1.0, 1.0),
        interval_sec=8,
        progress=lambda stage, done, total: stages.append(stage),
    )
    assert "frames_sample" in stages and "frames_region" in stages
    # Two distinct scenes (color change at sample 3) → two keyframes.
    assert [ts for ts, _ in out] == [0.0, 24.0]
