"""
weather.py — current conditions and forecast, via Open-Meteo.

Open-Meteo rather than a search: weather is the case where a `web_search` round
trip is strictly worse than an API call. The search returns a snippet scraped
off a page built for a different city on a different day, the model then has to
guess which numbers in it are current, and the user gets a paragraph. Here one
request returns typed numbers with their units, so the model can answer in a
sentence and the UI can draw the card.

No API key and no account — that is why this provider and not one of the
commercial ones; the free tier needs nothing configured, so the tool works on a
fresh install. Two calls: geocoding (name -> coordinates), then forecast.
Coordinates given directly skip the first.

The request goes out with ordinary TLS verification and does NOT use
`llm_verify()` — that override is scoped to LLM provider endpoints (see
src/tls_overrides.py). It also does not run through the web_fetch domain
policy: this is one pinned first-party API, not a URL the model chose.
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 15.0

DEFAULT_DAYS = 7
MAX_DAYS = 14
# One full day-and-night of hourly points. Enough for the card's strip and for
# "will it rain this evening"; more would cost context and card width for
# nothing.
HOURLY_POINTS = 24

# WMO 4677 weather codes -> (condition key, English label).
#
# The key is for the FRONTEND: it picks the icon and the translated wording, so
# the card reads German in a German UI without this module knowing which locale
# is active. The label is for the MODEL, in the summary text. Codes collapse
# into one key where the distinction is meteorological rather than visible
# (light/moderate/heavy drizzle all look like drizzle on a card); intensity
# survives in the label.
_WMO: Dict[int, Tuple[str, str]] = {
    0: ("clear", "clear sky"),
    1: ("mainly-clear", "mainly clear"),
    2: ("partly-cloudy", "partly cloudy"),
    3: ("overcast", "overcast"),
    45: ("fog", "fog"),
    48: ("fog", "depositing rime fog"),
    51: ("drizzle", "light drizzle"),
    53: ("drizzle", "moderate drizzle"),
    55: ("drizzle", "dense drizzle"),
    56: ("freezing-rain", "light freezing drizzle"),
    57: ("freezing-rain", "dense freezing drizzle"),
    61: ("rain", "slight rain"),
    63: ("rain", "moderate rain"),
    65: ("rain", "heavy rain"),
    66: ("freezing-rain", "light freezing rain"),
    67: ("freezing-rain", "heavy freezing rain"),
    71: ("snow", "slight snowfall"),
    73: ("snow", "moderate snowfall"),
    75: ("snow", "heavy snowfall"),
    77: ("snow-grains", "snow grains"),
    80: ("showers", "slight rain showers"),
    81: ("showers", "moderate rain showers"),
    82: ("showers", "violent rain showers"),
    85: ("snow-showers", "slight snow showers"),
    86: ("snow-showers", "heavy snow showers"),
    95: ("thunderstorm", "thunderstorm"),
    96: ("thunderstorm-hail", "thunderstorm with slight hail"),
    99: ("thunderstorm-hail", "thunderstorm with heavy hail"),
}


# Condition key -> English label for the summary text, derived from _WMO so the
# two can never drift. First label wins for keys that several codes share.
_CONDITION_LABELS: Dict[str, str] = {"unknown": "unknown conditions"}
for _code_key, _code_label in _WMO.values():
    _CONDITION_LABELS.setdefault(_code_key, _code_label)


def describe_code(code: Any) -> Tuple[str, str]:
    """(condition key, English label) for a WMO code. Unknown codes fall back to
    a neutral key the frontend renders with a generic icon rather than nothing."""
    try:
        key, label = _WMO[int(code)]
    except (KeyError, TypeError, ValueError):
        return "unknown", "unknown conditions"
    return key, label


_COORD_RE = re.compile(r"^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;/ ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


def parse_coordinates(text: str) -> Optional[Tuple[float, float]]:
    """"52.52, 13.41" -> (52.52, 13.41). None when it isn't a coordinate pair.

    Bounds are checked, so "10, 20" (a plausible pair) is accepted but a stray
    "2024, 2025" is not — a wrong-but-valid coordinate silently reports the
    weather in the ocean, which is worse than falling through to geocoding.
    """
    m = _COORD_RE.match(text or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon


async def geocode(name: str, language: str = "en") -> Dict[str, Any]:
    """Resolve a place name to coordinates. Returns {} when nothing matched."""
    import httpx

    params = {"name": name, "count": 1, "language": language or "en", "format": "json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.get(GEOCODE_URL, params=params)
        response.raise_for_status()
        payload = response.json()

    results = payload.get("results") or []
    if not results:
        return {}
    hit = results[0]
    return {
        "name": hit.get("name") or name,
        "country": hit.get("country") or "",
        "admin": hit.get("admin1") or "",
        "latitude": hit.get("latitude"),
        "longitude": hit.get("longitude"),
    }


async def _forecast(latitude: float, longitude: float, days: int) -> Dict[str, Any]:
    import httpx

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": (
            "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,"
            "precipitation,weather_code,wind_speed_10m"
        ),
        "hourly": "temperature_2m,weather_code,precipitation_probability",
        "daily": (
            "weather_code,temperature_2m_max,temperature_2m_min,"
            "precipitation_probability_max,sunrise,sunset"
        ),
        "forecast_days": days,
        # Everything comes back in the location's OWN local time. A forecast
        # labelled in UTC is unreadable ("18:00" is not 18:00 there) and the
        # card has no way to correct it after the fact.
        "timezone": "auto",
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.get(FORECAST_URL, params=params)
        response.raise_for_status()
        return response.json()


def _series(block: Dict[str, Any], key: str) -> List[Any]:
    values = block.get(key)
    return values if isinstance(values, list) else []


def _at(values: List[Any], index: int) -> Any:
    """Open-Meteo pads a missing reading with null rather than shortening the
    array, and a partly-unavailable variable can shorten it anyway. Index
    defensively — the card renders a gap, the whole forecast still arrives."""
    return values[index] if index < len(values) else None


def _current_hour_index(times: List[Any], now: Optional[str]) -> int:
    """Where 'now' sits in the hourly array, so the strip starts at the current
    hour instead of at midnight. Falls back to the start of the array."""
    if not now or not times:
        return 0
    stamp = str(now)[:13]  # "2026-08-11T14"
    for i, value in enumerate(times):
        if str(value)[:13] >= stamp:
            return i
    return 0


def _build_widget_data(place: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    current = payload.get("current") or {}
    hourly = payload.get("hourly") or {}
    daily = payload.get("daily") or {}
    units = payload.get("current_units") or {}

    hourly_times = _series(hourly, "time")
    hourly_temps = _series(hourly, "temperature_2m")
    hourly_codes = _series(hourly, "weather_code")
    hourly_pop = _series(hourly, "precipitation_probability")
    start = _current_hour_index(hourly_times, current.get("time"))

    hours: List[Dict[str, Any]] = []
    for i in range(start, min(start + HOURLY_POINTS, len(hourly_times))):
        key, _label = describe_code(_at(hourly_codes, i))
        hours.append(
            {
                "time": hourly_times[i],
                "temperature": _at(hourly_temps, i),
                "condition": key,
                "precipitationProbability": _at(hourly_pop, i),
            }
        )

    daily_dates = _series(daily, "time")
    daily_codes = _series(daily, "weather_code")
    daily_max = _series(daily, "temperature_2m_max")
    daily_min = _series(daily, "temperature_2m_min")
    daily_pop = _series(daily, "precipitation_probability_max")
    daily_sunrise = _series(daily, "sunrise")
    daily_sunset = _series(daily, "sunset")

    days: List[Dict[str, Any]] = []
    for i, date in enumerate(daily_dates):
        key, _label = describe_code(_at(daily_codes, i))
        days.append(
            {
                "date": date,
                "condition": key,
                "max": _at(daily_max, i),
                "min": _at(daily_min, i),
                "precipitationProbability": _at(daily_pop, i),
                "sunrise": _at(daily_sunrise, i),
                "sunset": _at(daily_sunset, i),
            }
        )

    current_key, _current_label = describe_code(current.get("weather_code"))
    return {
        "location": {
            "name": place.get("name") or "",
            "admin": place.get("admin") or "",
            "country": place.get("country") or "",
            "timezone": payload.get("timezone") or "",
        },
        "units": {
            "temperature": units.get("temperature_2m") or "°C",
            "wind": units.get("wind_speed_10m") or "km/h",
            "precipitation": units.get("precipitation") or "mm",
        },
        "current": {
            "time": current.get("time"),
            "temperature": current.get("temperature_2m"),
            "apparent": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "wind": current.get("wind_speed_10m"),
            "precipitation": current.get("precipitation"),
            "condition": current_key,
            "isDay": bool(current.get("is_day", 1)),
        },
        "hourly": hours,
        "daily": days,
    }


def _place_label(place: Dict[str, Any]) -> str:
    parts = [place.get("name") or "", place.get("admin") or "", place.get("country") or ""]
    # admin1 repeats the city for city-states ("Berlin, Berlin, Germany").
    seen: List[str] = []
    for part in parts:
        if part and part not in seen:
            seen.append(part)
    return ", ".join(seen)


def _summary(place: Dict[str, Any], data: Dict[str, Any]) -> str:
    """The model's copy of the answer: the same numbers as the card, as text.

    It is deliberately complete rather than a pointer at the widget. The model
    has to be able to answer "should I take a jacket" from context alone, and a
    persisted turn replayed into a later conversation carries this text, not the
    card.
    """
    current = data["current"]
    units = data["units"]
    lines = [f"Weather for {_place_label(place)} (local time {current.get('time') or 'n/a'})."]

    condition_label = _CONDITION_LABELS.get(current["condition"], current["condition"])
    now_bits = [f"{current.get('temperature')}{units['temperature']}"]
    if current.get("apparent") is not None:
        now_bits.append(f"feels like {current['apparent']}{units['temperature']}")
    now_bits.append(condition_label)
    if current.get("wind") is not None:
        now_bits.append(f"wind {current['wind']} {units['wind']}")
    if current.get("humidity") is not None:
        now_bits.append(f"humidity {current['humidity']}%")
    lines.append("Now: " + ", ".join(str(bit) for bit in now_bits) + ".")

    if data["daily"]:
        lines.append("Forecast:")
        for day in data["daily"]:
            pop = day.get("precipitationProbability")
            pop_text = f", {pop}% precipitation" if pop is not None else ""
            lines.append(
                f"  {day['date']}: {day.get('min')}–{day.get('max')}{units['temperature']}, "
                f"{_CONDITION_LABELS.get(day['condition'], day['condition'])}{pop_text}"
            )

    # Same contract as image_note on the image tools: the user is already
    # looking at this. Without the note the model reliably re-types the whole
    # forecast table underneath its own card.
    lines.append(
        "[A weather card with these numbers is already displayed to the user. "
        "Answer their actual question in a sentence or two — do not repeat the "
        "full forecast as a list or table.]"
    )
    return "\n".join(lines)


async def get_weather(
    location: str = "",
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    days: int = DEFAULT_DAYS,
    language: str = "en",
) -> Dict[str, Any]:
    """Current conditions plus an N-day forecast.

    Returns the tool-result shape: `output` for the model, `widget` for the UI,
    or `error` + a non-zero `exit_code`.
    """
    import httpx

    from src.widgets import make_widget

    try:
        days = int(days)
    except (TypeError, ValueError):
        days = DEFAULT_DAYS
    days = max(1, min(days, MAX_DAYS))

    place: Dict[str, Any] = {}
    if latitude is None or longitude is None:
        pair = parse_coordinates(location)
        if pair:
            latitude, longitude = pair
            place = {"name": f"{latitude:.4f}, {longitude:.4f}"}
        elif not (location or "").strip():
            return {
                "error": "get_weather needs a `location` (place name) or `latitude`+`longitude`.",
                "exit_code": 1,
            }
        else:
            try:
                place = await geocode(location.strip(), language=language)
            except httpx.TimeoutException:
                return {
                    "error": "Geocoding timed out — the weather service did not respond.",
                    "exit_code": 1,
                }
            except httpx.HTTPError as e:
                return {"error": f"Geocoding failed: {e}", "exit_code": 1}
            if not place:
                return {
                    "error": (
                        f"No place found for '{location.strip()}'. Try a fuller name "
                        "('Freiburg im Breisgau'), add the country, or pass coordinates."
                    ),
                    "exit_code": 1,
                }
            latitude, longitude = place["latitude"], place["longitude"]
    else:
        place = {"name": location.strip() or f"{float(latitude):.4f}, {float(longitude):.4f}"}

    try:
        payload = await _forecast(float(latitude), float(longitude), days)
    except httpx.TimeoutException:
        return {"error": "The weather service did not respond in time.", "exit_code": 1}
    except httpx.HTTPError as e:
        return {"error": f"Weather lookup failed: {e}", "exit_code": 1}
    except (TypeError, ValueError) as e:
        return {"error": f"Invalid coordinates: {e}", "exit_code": 1}

    data = _build_widget_data(place, payload)
    return {
        "output": _summary(place, data),
        "widget": make_widget("weather", data),
        "exit_code": 0,
    }
