"""Code in a workspace must not reach past its own workspace.

Three ways out were open: the daemon's own API (over loopback, with the key the
daemon handed to user code in its environment), the app's token-free MCP
endpoint (the sandbox's address counted as the local network), and the shared
uploads volume (covered in docker-compose.yml, not testable here).
"""

import asyncio

from starlette.requests import Request

from core import net_trust
from sandbox import sandboxd


def _request(client, server=("172.20.0.2", 7800), path="/users/u/workspaces/c/exec"):
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [],
            "client": client,
            "server": server,
        }
    )


def test_loopback_caller_is_local():
    assert sandboxd._is_local_caller(_request(("127.0.0.1", 50000)))
    assert sandboxd._is_local_caller(_request(("::1", 50000)))


def test_caller_on_the_containers_own_address_is_local():
    # Code connecting to the container's own sandbox-net address: the peer is
    # the very address it connected to.
    assert sandboxd._is_local_caller(_request(("172.20.0.2", 50000)))


def test_the_app_on_sandbox_net_is_not_local():
    assert not sandboxd._is_local_caller(_request(("172.20.0.3", 50000)))


def test_missing_or_odd_peer_is_not_local():
    assert not sandboxd._is_local_caller(_request(None))
    assert not sandboxd._is_local_caller(_request(("testclient", 50000)))


def test_local_caller_is_refused_even_with_the_key(monkeypatch):
    monkeypatch.setattr(sandboxd, "SANDBOX_KEY", "secret")

    async def call_next(_request):
        raise AssertionError("a local caller must not reach the route")

    request = _request(("127.0.0.1", 50000))
    request.scope["headers"] = [(b"x-talos-sandbox-key", b"secret")]
    response = asyncio.run(sandboxd._require_sandbox_key(request, call_next))
    assert response.status_code == 403


def test_user_env_leaves_out_secrets(monkeypatch):
    monkeypatch.setenv("TALOS_SANDBOX_KEY", "secret")
    monkeypatch.setenv("SOME_API_TOKEN", "t")
    monkeypatch.setenv("DB_PASSWORD", "p")
    monkeypatch.setenv("TALOS_SANDBOX_PIP_PACKAGES", "autots")
    env = sandboxd._user_env(HOME="/w/.talos-home")
    assert "TALOS_SANDBOX_KEY" not in env
    assert "SOME_API_TOKEN" not in env
    assert "DB_PASSWORD" not in env
    assert env["TALOS_SANDBOX_PIP_PACKAGES"] == "autots"
    assert env["HOME"] == "/w/.talos-home"


def _fresh_cache(monkeypatch, addrs):
    monkeypatch.setattr(net_trust, "_sandbox_cache", {"at": None, "addrs": frozenset()})
    monkeypatch.setattr(net_trust, "_resolve_sandbox_addresses", lambda: frozenset(addrs))


def test_sandbox_peer_is_recognised(monkeypatch):
    _fresh_cache(monkeypatch, {"172.20.0.2"})
    assert asyncio.run(net_trust.is_sandbox_peer("172.20.0.2"))


def test_other_private_peers_are_not_the_sandbox(monkeypatch):
    _fresh_cache(monkeypatch, {"172.20.0.2"})
    assert not asyncio.run(net_trust.is_sandbox_peer("172.19.0.1"))
    assert not asyncio.run(net_trust.is_sandbox_peer("192.168.10.42"))
    assert not asyncio.run(net_trust.is_sandbox_peer(None))
    assert not asyncio.run(net_trust.is_sandbox_peer("testclient"))


def test_loopback_sandbox_address_is_ignored(monkeypatch):
    # A dev setup pointing TALOS_SANDBOX_URL at localhost must not lock out the
    # developer's own browser.
    monkeypatch.setenv("TALOS_SANDBOX_URL", "http://localhost:7800")
    assert "127.0.0.1" not in net_trust._resolve_sandbox_addresses()


def test_unresolvable_sandbox_name_yields_nothing(monkeypatch):
    monkeypatch.setenv("TALOS_SANDBOX_URL", "http://no-such-host.invalid:7800")
    assert net_trust._resolve_sandbox_addresses() == frozenset()
