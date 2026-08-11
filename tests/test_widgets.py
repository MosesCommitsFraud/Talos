"""Widget channel (src/widgets.py) and the first widget-emitting tool,
get_weather (src/weather.py)."""

import asyncio
import math

import pytest

from src import weather as weather_mod
from src.widgets import MAX_WIDGET_BYTES, WIDGET_TYPES, make_widget, sanitize_widget

# ── sanitize_widget ──


def test_valid_widget_round_trips():
    widget = sanitize_widget(make_widget("weather", {"current": {"temperature": 21.5}}))
    assert widget == {"type": "weather", "version": 1, "data": {"current": {"temperature": 21.5}}}


def test_unknown_type_is_dropped():
    assert sanitize_widget({"type": "definitely-not-registered", "data": {}}) is None


def test_non_dict_shapes_are_dropped():
    assert sanitize_widget(None) is None
    assert sanitize_widget("weather") is None
    assert sanitize_widget([{"type": "weather"}]) is None
    # data must be a dict — a component indexes into it by key
    assert sanitize_widget({"type": "weather", "data": [1, 2, 3]}) is None


def test_unserialisable_payload_is_dropped_not_raised():
    """The failure this exists to prevent: a payload that only blows up once it
    is being encoded into the SSE frame, taking the rest of the turn with it."""
    assert sanitize_widget(make_widget("weather", {"when": object()})) is None
    assert sanitize_widget(make_widget("weather", {"temp": float("nan")})) is None
    assert sanitize_widget(make_widget("weather", {"temp": math.inf})) is None


def test_oversized_payload_is_dropped():
    huge = {"filler": "x" * (MAX_WIDGET_BYTES + 1)}
    assert sanitize_widget(make_widget("weather", huge)) is None


def test_bad_version_falls_back_to_one():
    assert sanitize_widget({"type": "weather", "version": "2", "data": {}})["version"] == 1
    assert sanitize_widget({"type": "weather", "version": True, "data": {}})["version"] == 1
    assert sanitize_widget({"type": "weather", "version": 0, "data": {}})["version"] == 1
    assert sanitize_widget({"type": "weather", "version": 3, "data": {}})["version"] == 3


# ── weather helpers ──


def test_coordinate_parsing():
    assert weather_mod.parse_coordinates("52.52, 13.41") == (52.52, 13.41)
    assert weather_mod.parse_coordinates("-33.87;151.21") == (-33.87, 151.21)
    assert weather_mod.parse_coordinates("Berlin") is None
    # Out of range: a plausible-looking pair that would silently report the
    # weather somewhere else entirely.
    assert weather_mod.parse_coordinates("2024, 2025") is None


def test_wmo_codes_map_to_registered_condition_keys():
    for code in (0, 3, 45, 61, 75, 95, 99):
        key, label = weather_mod.describe_code(code)
        assert key in weather_mod._CONDITION_LABELS
        assert label
    # Unknown / malformed codes degrade instead of raising.
    assert weather_mod.describe_code(9999)[0] == "unknown"
    assert weather_mod.describe_code(None)[0] == "unknown"


def test_hourly_strip_starts_at_the_current_hour():
    times = [f"2026-08-11T{h:02d}:00" for h in range(24)]
    assert weather_mod._current_hour_index(times, "2026-08-11T14:00") == 14
    assert weather_mod._current_hour_index(times, None) == 0
    assert weather_mod._current_hour_index([], "2026-08-11T14:00") == 0


def _forecast_payload():
    hours = [f"2026-08-11T{h:02d}:00" for h in range(24)]
    return {
        "timezone": "Europe/Berlin",
        "current_units": {"temperature_2m": "°C", "wind_speed_10m": "km/h", "precipitation": "mm"},
        "current": {
            "time": "2026-08-11T14:00",
            "temperature_2m": 21.4,
            "apparent_temperature": 20.8,
            "relative_humidity_2m": 55,
            "wind_speed_10m": 12.0,
            "precipitation": 0.0,
            "weather_code": 3,
            "is_day": 1,
        },
        "hourly": {
            "time": hours,
            "temperature_2m": [15.0 + h * 0.2 for h in range(24)],
            "weather_code": [3] * 24,
            "precipitation_probability": [10] * 24,
        },
        "daily": {
            "time": ["2026-08-11", "2026-08-12"],
            "weather_code": [3, 61],
            "temperature_2m_max": [23.4, 19.8],
            "temperature_2m_min": [15.0, 13.2],
            "precipitation_probability_max": [20, 80],
            "sunrise": ["2026-08-11T05:52", "2026-08-12T05:54"],
            "sunset": ["2026-08-11T20:48", "2026-08-12T20:46"],
        },
    }


def test_widget_data_shape(monkeypatch):
    place = {"name": "Berlin", "country": "Germany", "admin": "Berlin"}
    data = weather_mod._build_widget_data(place, _forecast_payload())

    assert data["location"]["name"] == "Berlin"
    assert data["location"]["timezone"] == "Europe/Berlin"
    assert data["current"]["condition"] == "overcast"
    assert data["current"]["isDay"] is True
    # The strip starts at "now" (14:00), so 10 of the day's 24 hours remain.
    assert [h["time"] for h in data["hourly"]][0] == "2026-08-11T14:00"
    assert len(data["hourly"]) == 10
    assert data["daily"][1]["condition"] == "rain"
    assert data["daily"][1]["precipitationProbability"] == 80
    # The whole payload has to survive the boundary it is about to cross.
    assert sanitize_widget(make_widget("weather", data)) is not None


def test_short_series_do_not_raise():
    """Open-Meteo can return a variable shorter than the others when it is
    partially unavailable; the card should show gaps, not fail."""
    payload = _forecast_payload()
    payload["daily"]["temperature_2m_min"] = [15.0]  # one value for two days
    payload["hourly"]["precipitation_probability"] = []
    data = weather_mod._build_widget_data({"name": "Berlin"}, payload)
    assert data["daily"][1]["min"] is None
    assert data["hourly"][0]["precipitationProbability"] is None


def test_summary_carries_the_numbers_and_the_do_not_repeat_note():
    place = {"name": "Berlin", "country": "Germany"}
    data = weather_mod._build_widget_data(place, _forecast_payload())
    summary = weather_mod._summary(place, data)

    assert "Berlin, Germany" in summary
    assert "21.4°C" in summary
    assert "overcast" in summary
    assert "2026-08-12" in summary
    # Without this the model re-types the whole forecast under its own card.
    assert "already displayed to the user" in summary


def test_place_label_deduplicates_city_states():
    place = {"name": "Berlin", "admin": "Berlin", "country": "Germany"}
    assert weather_mod._place_label(place) == "Berlin, Germany"


# ── get_weather ──


def test_missing_location_is_an_error_not_a_lookup():
    result = asyncio.run(weather_mod.get_weather(location=""))
    assert result["exit_code"] == 1
    assert "location" in result["error"]


def test_get_weather_builds_output_and_widget(monkeypatch):
    async def _fake_geocode(name, language="en"):
        assert name == "Berlin"
        return {
            "name": "Berlin",
            "country": "Germany",
            "admin": "",
            "latitude": 52.52,
            "longitude": 13.41,
        }

    async def _fake_forecast(latitude, longitude, days):
        assert (latitude, longitude) == (52.52, 13.41)
        assert days == 7
        return _forecast_payload()

    monkeypatch.setattr(weather_mod, "geocode", _fake_geocode)
    monkeypatch.setattr(weather_mod, "_forecast", _fake_forecast)

    result = asyncio.run(weather_mod.get_weather(location="Berlin"))
    assert result["exit_code"] == 0
    assert "Berlin" in result["output"]
    assert result["widget"]["type"] == "weather"
    assert result["widget"]["data"]["current"]["temperature"] == 21.4


def test_coordinates_skip_geocoding(monkeypatch):
    async def _fail(*args, **kwargs):
        raise AssertionError("geocode must not be called when coordinates are given")

    async def _fake_forecast(latitude, longitude, days):
        assert (latitude, longitude) == (35.68, 139.69)
        return _forecast_payload()

    monkeypatch.setattr(weather_mod, "geocode", _fail)
    monkeypatch.setattr(weather_mod, "_forecast", _fake_forecast)

    result = asyncio.run(weather_mod.get_weather(location="35.68, 139.69"))
    assert result["exit_code"] == 0


def test_days_are_clamped(monkeypatch):
    seen = {}

    async def _fake_forecast(latitude, longitude, days):
        seen["days"] = days
        return _forecast_payload()

    monkeypatch.setattr(weather_mod, "_forecast", _fake_forecast)
    asyncio.run(weather_mod.get_weather(latitude=52.5, longitude=13.4, days=99))
    assert seen["days"] == weather_mod.MAX_DAYS
    asyncio.run(weather_mod.get_weather(latitude=52.5, longitude=13.4, days="nonsense"))
    assert seen["days"] == weather_mod.DEFAULT_DAYS


def test_unknown_place_is_reported(monkeypatch):
    async def _empty(name, language="en"):
        return {}

    monkeypatch.setattr(weather_mod, "geocode", _empty)
    result = asyncio.run(weather_mod.get_weather(location="Xyzzyville"))
    assert result["exit_code"] == 1
    assert "Xyzzyville" in result["error"]


# ── tool argument parsing ──


def test_bare_place_name_is_accepted(monkeypatch):
    from src import tool_implementations as tool_impl

    seen = {}

    async def _fake(location="", latitude=None, longitude=None, days=7, language="en"):
        seen.update(location=location, days=days)
        return {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(weather_mod, "get_weather", _fake)
    asyncio.run(tool_impl.do_get_weather("Freiburg im Breisgau"))
    assert seen["location"] == "Freiburg im Breisgau"


def test_json_arguments_are_accepted(monkeypatch):
    from src import tool_implementations as tool_impl

    seen = {}

    async def _fake(location="", latitude=None, longitude=None, days=7, language="en"):
        seen.update(location=location, latitude=latitude, longitude=longitude, days=days)
        return {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(weather_mod, "get_weather", _fake)
    asyncio.run(tool_impl.do_get_weather('{"location": "Tokyo", "days": 3}'))
    assert (seen["location"], seen["days"]) == ("Tokyo", 3)

    asyncio.run(tool_impl.do_get_weather('{"lat": 52.5, "lon": 13.4}'))
    assert (seen["latitude"], seen["longitude"]) == (52.5, 13.4)


# ── wiring ──


def test_get_weather_is_registered_end_to_end():
    from src.agent_tools import TOOL_TAGS
    from src.agent_loop import TOOL_SECTIONS
    from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_parsing import _TOOL_NAME_MAP
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    assert "get_weather" in TOOL_TAGS
    assert "get_weather" in {s["function"]["name"] for s in FUNCTION_TOOL_SCHEMAS}
    assert "get_weather" in BUILTIN_TOOL_DESCRIPTIONS
    assert "get_weather" in TOOL_SECTIONS
    # Whether a turn needs weather is a mid-answer judgement, same as web_search:
    # gating it behind retrieval means falling back to a scraped snippet.
    assert "get_weather" in ALWAYS_AVAILABLE
    assert _TOOL_NAME_MAP["weather"] == "get_weather"
    assert _TOOL_NAME_MAP["wetter"] == "get_weather"


def test_widget_payload_is_not_echoed_into_model_context():
    """`format_tool_result` dumps unhandled result keys as JSON. The widget must
    not be one of them: the model would read the forecast twice, once as prose
    and once as raw numbers."""
    from src.tool_execution import format_tool_result

    text = format_tool_result(
        "get_weather: Berlin",
        {
            "output": "Now: 21.4°C, overcast.",
            "widget": make_widget("weather", {"secret": "payload"}),
            "exit_code": 0,
        },
    )
    assert "21.4" in text
    assert "secret" not in text
    assert "widget" not in text


def test_weather_is_the_only_registered_widget_type_so_far():
    """Guards the registry contract: a type added here without a component in
    web/src/components/widgets/registry.tsx renders as nothing."""
    assert WIDGET_TYPES == frozenset({"weather"})


@pytest.mark.parametrize("tool", ["get_weather"])
def test_plan_mode_treats_it_as_read_only(tool):
    from src.tool_security import plan_mode_disabled_tools

    assert tool not in plan_mode_disabled_tools()
