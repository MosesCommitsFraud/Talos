"""Unit tests for RAG citation media derivation (image preview / video deeplink).

Pure metadata logic — no network or model deps.
"""

import importlib

cp = importlib.import_module("src.chat_processor")


def test_image_meta_gets_confined_asset_url():
    out = cp._citation_media(
        {
            "type": ".png",
            "filename": "diagram.png",
            "source": "/data/personal_uploads/global/diagram-ab12cd.png",
        }
    )
    assert out["modality"] == "image"
    assert out["image_url"].startswith("/api/personal/rag-asset?source=")
    # The stored path is URL-encoded (slashes escaped) so it round-trips as a query value.
    assert "%2F" in out["image_url"]


def test_image_meta_detected_by_filename_when_type_absent():
    out = cp._citation_media(
        {"filename": "shot.jpeg", "source": "/data/personal_uploads/global/shot.jpeg"}
    )
    assert out["modality"] == "image"


def test_video_meta_carries_timestamps_and_deeplink():
    out = cp._citation_media(
        {"modality": "video", "start": 12.4, "end": 38.9, "deeplink": "https://vid/x#t=12"}
    )
    assert out["modality"] == "video"
    assert out["start"] == 12.4 and out["end"] == 38.9
    assert out["deeplink"].endswith("#t=12")


def test_video_detected_by_extension():
    out = cp._citation_media({"type": ".mp4", "filename": "lesson.mp4", "source": "/x/lesson.mp4"})
    assert out["modality"] == "video"


def test_plain_document_has_no_media_fields():
    assert (
        cp._citation_media({"type": ".pdf", "filename": "manual.pdf", "source": "/x/manual.pdf"})
        == {}
    )
    assert cp._citation_media({}) == {}
