"""Tests for core/net_trust.py — the rule behind token-free MCP (MCP_OPEN).

This decides whether a caller may reach `/mcp` with no credentials at all, so
the interesting cases are the ones where it must say *no*: a forwarded request
that only looks local, an address outside the allowance, a misconfigured list.
"""

import pytest

from core.net_trust import (
    DEFAULT_PRIVATE_NETWORKS,
    PROXY_FORWARD_HEADERS,
    client_in_networks,
    parse_networks,
)

PRIVATE = parse_networks(DEFAULT_PRIVATE_NETWORKS)


def test_default_allowance_covers_loopback_and_rfc1918():
    for host in ("127.0.0.1", "::1", "10.4.1.9", "172.16.0.5", "192.168.10.91"):
        assert client_in_networks(host, {}, PRIVATE) is True, host


def test_public_addresses_are_refused():
    for host in ("8.8.8.8", "203.0.113.7", "2606:4700::1111"):
        assert client_in_networks(host, {}, PRIVATE) is False, host


@pytest.mark.parametrize("header", PROXY_FORWARD_HEADERS)
def test_a_forwarded_request_is_refused_even_from_a_private_address(header):
    """A tunnel or reverse proxy connects from the LAN itself, so without this
    every outside visitor would inherit the intranet's trust."""
    assert client_in_networks("127.0.0.1", {header: "anything"}, PRIVATE) is False


def test_an_empty_allowance_trusts_nobody():
    assert client_in_networks("127.0.0.1", {}, []) is False


def test_a_missing_or_unparseable_peer_is_refused():
    assert client_in_networks(None, {}, PRIVATE) is False
    assert client_in_networks("", {}, PRIVATE) is False
    assert client_in_networks("not-an-ip", {}, PRIVATE) is False


def test_a_typo_in_the_network_list_drops_that_range_instead_of_widening_it():
    nets = parse_networks("192.168.10.0/24, nonsense, 10.0.0.0/8")
    assert len(nets) == 2
    assert client_in_networks("192.168.10.91", {}, nets) is True
    assert client_in_networks("172.16.0.1", {}, nets) is False


def test_a_single_host_can_be_pinned():
    """The tightest useful configuration: only the MACS server."""
    nets = parse_networks("192.168.10.42/32")
    assert client_in_networks("192.168.10.42", {}, nets) is True
    assert client_in_networks("192.168.10.43", {}, nets) is False
