"""net_trust.py

Deciding whether a request came from a network we are willing to trust.

Split out of `app.py` so the rule is testable without booting the application:
the decision gates an endpoint that answers *without a token* (`MCP_OPEN`, see
`app.py`), which makes it exactly the kind of check that should have tests of
its own rather than living inside a middleware closure.

The rule is deliberately narrow: judge the transport peer, never a header. A
forwarded request carries the proxy's address as its peer, so every tunnelled
visitor would look local — hence `client_in_networks` refuses outright when
forwarding headers are present. Restrict at the proxy, or issue a token.
"""

from __future__ import annotations

import ipaddress
import logging
import os
from typing import Iterable, List, Mapping, Optional

logger = logging.getLogger(__name__)

# Headers that prove a request was forwarded by a proxy or tunnel (cloudflared,
# nginx, Caddy, Tailscale Funnel, …).
PROXY_FORWARD_HEADERS = (
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "forwarded",
)

# Loopback plus the RFC1918 private ranges — "the office network" for a
# deployment that isn't reachable from outside it.
DEFAULT_PRIVATE_NETWORKS = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"


def parse_networks(raw: Optional[str]) -> List[ipaddress._BaseNetwork]:
    """Parse a comma-separated CIDR list, skipping (and logging) bad entries.

    An unparseable entry must not take the process down at import time, and it
    must not silently widen the allowance either — it is dropped, so a typo
    fails closed for that range.
    """
    out: List[ipaddress._BaseNetwork] = []
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            out.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            logger.warning("Ignoring unparseable network %r", item)
    return out


def mcp_open_networks() -> List[ipaddress._BaseNetwork]:
    """Where `POST /mcp` answers without a token. Empty with MCP_OPEN=false."""
    if os.getenv("MCP_OPEN", "true").lower() == "false":
        return []
    return parse_networks(os.getenv("MCP_OPEN_NETWORKS") or DEFAULT_PRIVATE_NETWORKS)


def client_in_networks(
    host: Optional[str],
    headers: Mapping[str, str],
    networks: Iterable[ipaddress._BaseNetwork],
) -> bool:
    """True when this peer address is inside one of `networks`.

    False when the request was forwarded (see module docstring), when there is
    no peer address, when the address doesn't parse, or when `networks` is
    empty — an empty allowance trusts nobody, which is the safe reading of a
    misconfigured list.
    """
    networks = list(networks)
    if not networks or not host:
        return False
    for header in PROXY_FORWARD_HEADERS:
        if headers.get(header):
            return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in networks)


# ---------------------------------------------------------------------------
# The code sandbox as a caller
# ---------------------------------------------------------------------------
# The app shares the internal sandbox network with the code sandbox so it can
# reach the sandbox daemon. The same route lets code running in a workspace
# call the app back, and that address sits inside the private ranges above, so
# it would count as "the local network" for token-free MCP. Nothing in the
# sandbox has any business calling the app, so its address is refused outright.

_SANDBOX_TTL_SECONDS = 30.0
_sandbox_cache: dict = {"at": None, "addrs": frozenset()}


def _sandbox_host() -> Optional[str]:
    from urllib.parse import urlparse

    url = os.getenv("TALOS_SANDBOX_URL", "http://talos-sandbox:7800")
    return urlparse(url).hostname or None


def _resolve_sandbox_addresses() -> frozenset:
    """The sandbox host's addresses, loopback left out.

    Loopback is dropped so a development setup that points TALOS_SANDBOX_URL at
    localhost does not lock the developer's own browser out. A name that does
    not resolve yields nothing: then there is no sandbox to come from.
    """
    import socket

    host = _sandbox_host()
    if not host:
        return frozenset()
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return frozenset()
    out = set()
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if not addr.is_loopback:
            out.add(str(addr))
    return frozenset(out)


async def sandbox_addresses() -> frozenset:
    """The sandbox's current addresses, re-resolved every 30 s.

    Its address changes when the container is recreated, so it is looked up
    rather than configured. The lookup runs in a thread: an unknown name can
    take seconds to fail, which must not stall the event loop.
    """
    import asyncio
    import time

    now = time.monotonic()
    at = _sandbox_cache["at"]
    if at is None or now - at > _SANDBOX_TTL_SECONDS:
        _sandbox_cache["addrs"] = await asyncio.to_thread(_resolve_sandbox_addresses)
        _sandbox_cache["at"] = now
    return _sandbox_cache["addrs"]


async def is_sandbox_peer(host: Optional[str]) -> bool:
    """Whether this transport peer is the code sandbox."""
    if not host:
        return False
    try:
        addr = str(ipaddress.ip_address(host))
    except ValueError:
        return False
    return addr in await sandbox_addresses()
