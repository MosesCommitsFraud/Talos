"""Extraction lanes: "auto" runs once the endpoint the lane needs is configured."""

from src.rag_config import lane_env, lane_mode, lane_status


def test_old_configs_map_true_to_on_and_everything_else_to_auto():
    assert lane_mode({"pdf_vlm_enabled": True}, "pdf_vlm") == "on"
    assert lane_mode({"pdf_vlm_enabled": False}, "pdf_vlm") == "auto"
    assert lane_mode({}, "video_asr") == "auto"
    assert lane_mode({"pdf_vlm_mode": "off", "pdf_vlm_enabled": True}, "pdf_vlm") == "off"


def test_auto_follows_the_configured_endpoints():
    bare = lane_status({}, env={})
    assert bare["video_asr"] == {"mode": "auto", "active": False, "waiting_for": "video_asr_url"}
    assert bare["pdf_vlm"]["waiting_for"] == "vlm_url"
    assert bare["code_lane"]["active"] is True

    cfg = {"video_asr_url": "http://asr/v1/audio/transcriptions", "vlm_url": "http://vlm/v1"}
    status = lane_status(cfg, env={})
    assert all(s["active"] for s in status.values())

    # Keyframes need transcription; without it they wait even with a VLM.
    frames = lane_status({"vlm_url": "http://vlm/v1"}, env={})["video_frames"]
    assert frames == {"mode": "auto", "active": False, "waiting_for": "video_asr"}


def test_endpoint_from_the_environment_counts_and_off_wins():
    env = {"VIDEO_ASR_URL": "http://asr"}
    assert lane_status({}, env=env)["video_asr"]["active"] is True
    assert lane_status({"video_asr_mode": "off"}, env=env)["video_asr"]["active"] is False
    # "on" without an endpoint still cannot run.
    assert lane_status({"pdf_vlm_mode": "on"}, env={})["pdf_vlm"]["active"] is False


def test_env_flags_for_the_ingest_gates():
    flags = lane_env({"vlm_url": "http://vlm", "code_lane_mode": "off"}, env={})
    assert flags == {
        "VIDEO_ASR_ENABLED": "",
        "PDF_VLM_ENABLED": "true",
        "CODE_LANE_ENABLED": "",
        "VIDEO_FRAMES_ENABLED": "",
    }


def test_settings_roundtrip_keeps_modes_and_keyframe_settings():
    from routes.rag_routes import RagPipelineConfig, _normalize, _public

    body = RagPipelineConfig(
        pdf_vlm_mode="off",
        video_asr_enabled=True,
        video_frames_mode="on",
        video_frames_interval_sec=5,
        video_frames_max=50,
    )
    stored = _normalize(body, {})
    assert stored["pdf_vlm_mode"] == "off" and stored["pdf_vlm_enabled"] is False
    assert stored["video_asr_mode"] == "on" and stored["video_asr_enabled"] is True
    assert stored["code_lane_mode"] == "auto"
    assert stored["video_frames_interval_sec"] == 5 and stored["video_frames_max"] == 50
    shown = _public(stored)
    assert shown["video_frames_mode"] == "on" and shown["video_frames_max"] == 50
    assert set(shown["lanes"]) == {"video_asr", "video_frames", "pdf_vlm", "code_lane"}
