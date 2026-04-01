"""Pi-hole v6 API Client."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

from .const import (
    API_AUTH,
    API_DNS,
    API_DNS_BLOCKING,
    API_DNS_HOSTS,
    API_DOMAINS_ALLOW,
    API_DOMAINS_ALLOW_REGEX,
    API_DOMAINS_DENY,
    API_DOMAINS_DENY_REGEX,
    API_LISTS,
    API_QUERIES,
    API_STATS_SUMMARY,
    API_STATS_TOP_DOMAINS,
)

_LOGGER = logging.getLogger(__name__)


class PiholeApiError(Exception):
    """Base exception for Pi-hole API errors."""


class PiholeAuthError(PiholeApiError):
    """Authentication failed."""


class PiholeConnectionError(PiholeApiError):
    """Connection to Pi-hole failed."""


class PiholeApiClient:
    """Async client for the Pi-hole v6 REST API."""

    def __init__(
        self,
        host: str,
        port: int,
        password: str,
        *,
        use_ssl: bool = False,
        verify_ssl: bool = True,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        """Initialize the API client."""
        self._host = host
        self._port = port
        self._password = password
        self._use_ssl = use_ssl
        self._verify_ssl = verify_ssl
        self._session = session
        self._own_session = session is None
        self._sid: str | None = None
        scheme = "https" if use_ssl else "http"
        self._base_url = f"{scheme}://{host}:{port}"

    @property
    def base_url(self) -> str:
        """Return the base URL."""
        return self._base_url

    async def _ensure_session(self) -> aiohttp.ClientSession:
        """Get or create the aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
            self._own_session = True
        return self._session

    async def authenticate(self) -> str:
        """Authenticate and return session ID."""
        session = await self._ensure_session()
        try:
            async with session.post(
                f"{self._base_url}{API_AUTH}",
                json={"password": self._password},
            ) as resp:
                if resp.status == 401:
                    raise PiholeAuthError("Invalid password")
                resp.raise_for_status()
                data = await resp.json()
                self._sid = data["session"]["sid"]
                return self._sid
        except aiohttp.ClientError as err:
            raise PiholeConnectionError(f"Cannot connect to {self._base_url}: {err}") from err

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Make an authenticated API request."""
        if self._sid is None:
            await self.authenticate()

        session = await self._ensure_session()
        headers = {"sid": self._sid}

        try:
            async with session.request(
                method,
                f"{self._base_url}{path}",
                headers=headers,
                json=json_data,
            ) as resp:
                if resp.status == 401:
                    # Session expired, re-authenticate and retry once
                    await self.authenticate()
                    headers["sid"] = self._sid
                    async with session.request(
                        method,
                        f"{self._base_url}{path}",
                        headers=headers,
                        json=json_data,
                    ) as retry_resp:
                        retry_resp.raise_for_status()
                        if retry_resp.status == 204:
                            return {}
                        return await retry_resp.json()
                resp.raise_for_status()
                if resp.status == 204:
                    return {}
                return await resp.json()
        except aiohttp.ClientError as err:
            raise PiholeConnectionError(f"API request failed: {err}") from err

    async def close(self) -> None:
        """Close the session if we own it."""
        # Logout to invalidate session
        if self._sid and self._session and not self._session.closed:
            try:
                await self._session.delete(
                    f"{self._base_url}{API_AUTH}",
                    headers={"sid": self._sid},
                )
            except Exception:  # noqa: BLE001
                pass
            self._sid = None

        if self._own_session and self._session and not self._session.closed:
            await self._session.close()

    # ── Info ──────────────────────────────────────────────

    async def get_stats_summary(self) -> dict[str, Any]:
        """Get Pi-hole stats summary (queries, blocking, gravity)."""
        return await self._request("GET", API_STATS_SUMMARY)

    # ── Blocking ─────────────────────────────────────────

    async def get_blocking_status(self) -> bool:
        """Get whether blocking is enabled."""
        data = await self._request("GET", API_DNS_BLOCKING)
        return data.get("blocking") == "enabled"

    async def set_blocking(self, enabled: bool) -> dict[str, Any]:
        """Enable or disable blocking."""
        return await self._request(
            "POST",
            API_DNS_BLOCKING,
            json_data={"blocking": enabled, "timer": None},
        )

    # ── Domains (Allow / Deny) ───────────────────────────

    async def get_denied_domains(self) -> list[dict[str, Any]]:
        """Get all denied (blacklisted) domains."""
        data = await self._request("GET", API_DOMAINS_DENY)
        return data.get("domains", [])

    async def add_denied_domain(self, domain: str, comment: str = "") -> dict[str, Any]:
        """Add a domain to the deny list."""
        return await self._request(
            "POST",
            API_DOMAINS_DENY,
            json_data={"domain": domain, "comment": comment},
        )

    async def remove_denied_domain(self, domain: str) -> dict[str, Any]:
        """Remove a domain from the deny list."""
        return await self._request(
            "DELETE",
            f"{API_DOMAINS_DENY}/{domain}",
        )

    async def add_denied_domain_regex(self, pattern: str, comment: str = "") -> dict[str, Any]:
        """Add a regex pattern to the deny list."""
        return await self._request(
            "POST",
            API_DOMAINS_DENY_REGEX,
            json_data={"domain": pattern, "comment": comment},
        )

    async def remove_denied_domain_regex(self, pattern: str) -> dict[str, Any]:
        """Remove a regex pattern from the deny list."""
        return await self._request(
            "DELETE",
            f"{API_DOMAINS_DENY_REGEX}/{pattern}",
        )

    async def get_allowed_domains(self) -> list[dict[str, Any]]:
        """Get all allowed (whitelisted) domains."""
        data = await self._request("GET", API_DOMAINS_ALLOW)
        return data.get("domains", [])

    async def add_allowed_domain(self, domain: str, comment: str = "") -> dict[str, Any]:
        """Add a domain to the allow list."""
        return await self._request(
            "POST",
            API_DOMAINS_ALLOW,
            json_data={"domain": domain, "comment": comment},
        )

    async def remove_allowed_domain(self, domain: str) -> dict[str, Any]:
        """Remove a domain from the allow list."""
        return await self._request(
            "DELETE",
            f"{API_DOMAINS_ALLOW}/{domain}",
        )

    async def add_allowed_domain_regex(self, pattern: str, comment: str = "") -> dict[str, Any]:
        """Add a regex pattern to the allow list."""
        return await self._request(
            "POST",
            API_DOMAINS_ALLOW_REGEX,
            json_data={"domain": pattern, "comment": comment},
        )

    async def remove_allowed_domain_regex(self, pattern: str) -> dict[str, Any]:
        """Remove a regex pattern from the allow list."""
        return await self._request(
            "DELETE",
            f"{API_DOMAINS_ALLOW_REGEX}/{pattern}",
        )

    # ── Local DNS Records (A + CNAME) ──────────────────────

    async def _get_dns_config(self) -> dict[str, Any]:
        """Get the full DNS config."""
        data = await self._request("GET", API_DNS)
        return data.get("config", {}).get("dns", {})

    async def _patch_dns(self, **fields: Any) -> dict[str, Any]:
        """Patch specific DNS config fields."""
        return await self._request(
            "PATCH",
            API_DNS,
            json_data={"config": {"dns": fields}},
        )

    # ── A-Records (hosts) ──

    async def get_dns_hosts(self) -> list[dict[str, Any]]:
        """Get all local DNS A-records."""
        dns = await self._get_dns_config()
        result = []
        for entry in dns.get("hosts", []):
            parts = entry.split(" ", 1)
            if len(parts) == 2:
                result.append({"ip": parts[0], "domain": parts[1]})
        return result

    async def get_dns_hosts_raw(self) -> list[str]:
        """Get raw hosts strings from API."""
        dns = await self._get_dns_config()
        return dns.get("hosts", [])

    async def add_dns_host(self, ip: str, domain: str) -> dict[str, Any]:
        """Add a local DNS A-record via PATCH."""
        current = await self.get_dns_hosts_raw()
        entry = f"{ip} {domain}"
        if entry not in current:
            current.append(entry)
        return await self._patch_dns(hosts=current)

    async def remove_dns_host(self, ip: str, domain: str) -> dict[str, Any]:
        """Remove a local DNS A-record via PATCH."""
        current = await self.get_dns_hosts_raw()
        entry = f"{ip} {domain}"
        current = [h for h in current if h != entry]
        return await self._patch_dns(hosts=current)

    async def set_dns_hosts_raw(self, hosts: list[str]) -> dict[str, Any]:
        """Set the full hosts list (for sync)."""
        return await self._patch_dns(hosts=hosts)

    # ── CNAME Records ──

    async def get_dns_cnames(self) -> list[dict[str, Any]]:
        """Get all local CNAME records."""
        dns = await self._get_dns_config()
        result = []
        for entry in dns.get("cnameRecords", []):
            parts = entry.split(",", 1)
            if len(parts) == 2:
                result.append({"domain": parts[0], "target": parts[1]})
        return result

    async def get_dns_cnames_raw(self) -> list[str]:
        """Get raw CNAME strings from API."""
        dns = await self._get_dns_config()
        return dns.get("cnameRecords", [])

    async def add_dns_cname(self, domain: str, target: str) -> dict[str, Any]:
        """Add a CNAME record via PATCH."""
        current = await self.get_dns_cnames_raw()
        entry = f"{domain},{target}"
        if entry not in current:
            current.append(entry)
        return await self._patch_dns(cnameRecords=current)

    async def remove_dns_cname(self, domain: str, target: str) -> dict[str, Any]:
        """Remove a CNAME record via PATCH."""
        current = await self.get_dns_cnames_raw()
        entry = f"{domain},{target}"
        current = [c for c in current if c != entry]
        return await self._patch_dns(cnameRecords=current)

    async def set_dns_cnames_raw(self, cnames: list[str]) -> dict[str, Any]:
        """Set the full CNAME list (for sync)."""
        return await self._patch_dns(cnameRecords=cnames)

    # ── Blocklists (Adlists) ─────────────────────────────

    async def get_lists(self) -> list[dict[str, Any]]:
        """Get all adlists/blocklists."""
        data = await self._request("GET", API_LISTS)
        return data.get("lists", [])

    async def add_list(self, url: str, comment: str = "") -> dict[str, Any]:
        """Add a blocklist by URL."""
        return await self._request(
            "POST",
            API_LISTS,
            json_data={"address": url, "comment": comment},
        )

    async def remove_list(self, url: str) -> dict[str, Any]:
        """Remove a blocklist by URL."""
        return await self._request(
            "DELETE",
            f"{API_LISTS}/{url}",
        )

    async def toggle_list(self, list_id: int, enabled: bool) -> dict[str, Any]:
        """Enable or disable a blocklist."""
        return await self._request(
            "PATCH",
            f"{API_LISTS}/{list_id}",
            json_data={"enabled": enabled},
        )

    # ── Stats (on-demand) ────────────────────────────────

    async def get_top_blocked(self, count: int = 20) -> list[dict[str, Any]]:
        """Get top blocked domains (on-demand, not polled)."""
        data = await self._request(
            "GET",
            f"{API_STATS_TOP_DOMAINS}?blocked=true&count={count}",
        )
        return data.get("domains", [])

    async def get_recent_queries(self, count: int = 50) -> list[dict[str, Any]]:
        """Get recent queries (on-demand, not polled)."""
        data = await self._request(
            "GET",
            f"{API_QUERIES}?length={count}",
        )
        return data.get("queries", [])
