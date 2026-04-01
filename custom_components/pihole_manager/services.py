"""Service handlers for Pi-hole Manager — broadcast to all instances."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
import homeassistant.helpers.config_validation as cv

from .const import DOMAIN
from .coordinator import PiholeManagerCoordinator

_LOGGER = logging.getLogger(__name__)

# ── Schema definitions ────────────────────────────────────

SCHEMA_DOMAIN = vol.Schema(
    {
        vol.Required("domain"): cv.string,
        vol.Optional("comment", default=""): cv.string,
        vol.Optional("include_subdomains", default=True): cv.boolean,
    }
)

SCHEMA_DOMAIN_ONLY = vol.Schema(
    {
        vol.Required("domain"): cv.string,
    }
)

SCHEMA_DNS_RECORD = vol.Schema(
    {
        vol.Required("ip"): cv.string,
        vol.Required("domain"): cv.string,
    }
)

SCHEMA_BLOCKLIST = vol.Schema(
    {
        vol.Required("url"): cv.string,
        vol.Optional("comment", default=""): cv.string,
    }
)

SCHEMA_BLOCKLIST_ONLY = vol.Schema(
    {
        vol.Required("url"): cv.string,
    }
)

SCHEMA_TOGGLE_BLOCKLIST = vol.Schema(
    {
        vol.Required("list_id"): vol.Coerce(int),
        vol.Required("enabled"): cv.boolean,
    }
)


def _get_coordinators(hass: HomeAssistant) -> list[PiholeManagerCoordinator]:
    """Get all active coordinators."""
    coordinators: dict[str, PiholeManagerCoordinator] = hass.data.get(DOMAIN, {})
    return list(coordinators.values())


async def _broadcast(
    hass: HomeAssistant,
    action_name: str,
    action_fn,
) -> None:
    """Execute an action on all instances, log errors, fire result event."""
    coordinators = _get_coordinators(hass)
    if not coordinators:
        _LOGGER.warning("No Pi-hole instances configured")
        return

    # Execute on all instances in parallel
    results = await asyncio.gather(
        *(action_fn(c) for c in coordinators),
        return_exceptions=True,
    )

    success = []
    failed = []
    for coordinator, result in zip(coordinators, results):
        name = coordinator.config_entry.title
        if isinstance(result, Exception):
            _LOGGER.error(
                "%s failed on %s: %s", action_name, name, result
            )
            failed.append({"instance": name, "error": str(result)})
        else:
            success.append({"instance": name})

    # Refresh all coordinators
    await asyncio.gather(
        *(c.async_request_refresh() for c in coordinators),
        return_exceptions=True,
    )

    # Fire result event
    hass.bus.async_fire(
        "pihole_manager_sync_result",
        {
            "action": action_name,
            "success": success,
            "failed": failed,
        },
    )

    _LOGGER.info(
        "%s: %d succeeded, %d failed",
        action_name,
        len(success),
        len(failed),
    )


# ── Service handlers ──────────────────────────────────────


def _domain_to_regex(domain: str) -> str:
    """Convert a domain to a regex matching itself and all subdomains."""
    escaped = domain.replace(".", "\\.")
    return f"(^|\\.){escaped}$"


async def _handle_add_denied_domain(call: ServiceCall) -> None:
    domain = call.data["domain"]
    comment = call.data.get("comment", "")
    include_subdomains = call.data.get("include_subdomains", True)
    await _broadcast(
        call.hass,
        "add_denied_domain",
        lambda c: c.api.add_denied_domain(domain, comment),
    )
    if include_subdomains:
        regex = _domain_to_regex(domain)
        await _broadcast(
            call.hass,
            "add_denied_domain_regex",
            lambda c: c.api.add_denied_domain_regex(regex, f"Subdomains: {domain}"),
        )


async def _handle_remove_denied_domain(call: ServiceCall) -> None:
    domain = call.data["domain"]
    await _broadcast(
        call.hass,
        "remove_denied_domain",
        lambda c: c.api.remove_denied_domain(domain),
    )
    # Also try to remove the regex variant (ignore errors if it doesn't exist)
    regex = _domain_to_regex(domain)
    await _broadcast(
        call.hass,
        "remove_denied_domain_regex",
        lambda c: c.api.remove_denied_domain_regex(regex),
    )


async def _handle_add_allowed_domain(call: ServiceCall) -> None:
    domain = call.data["domain"]
    comment = call.data.get("comment", "")
    include_subdomains = call.data.get("include_subdomains", True)
    await _broadcast(
        call.hass,
        "add_allowed_domain",
        lambda c: c.api.add_allowed_domain(domain, comment),
    )
    if include_subdomains:
        regex = _domain_to_regex(domain)
        await _broadcast(
            call.hass,
            "add_allowed_domain_regex",
            lambda c: c.api.add_allowed_domain_regex(regex, f"Subdomains: {domain}"),
        )


async def _handle_remove_allowed_domain(call: ServiceCall) -> None:
    domain = call.data["domain"]
    await _broadcast(
        call.hass,
        "remove_allowed_domain",
        lambda c: c.api.remove_allowed_domain(domain),
    )
    regex = _domain_to_regex(domain)
    await _broadcast(
        call.hass,
        "remove_allowed_domain_regex",
        lambda c: c.api.remove_allowed_domain_regex(regex),
    )


async def _handle_add_dns_record(call: ServiceCall) -> None:
    ip = call.data["ip"]
    domain = call.data["domain"]
    await _broadcast(
        call.hass,
        "add_dns_record",
        lambda c: c.api.add_dns_host(ip, domain),
    )


async def _handle_remove_dns_record(call: ServiceCall) -> None:
    ip = call.data["ip"]
    domain = call.data["domain"]
    await _broadcast(
        call.hass,
        "remove_dns_record",
        lambda c: c.api.remove_dns_host(ip, domain),
    )


async def _handle_add_blocklist(call: ServiceCall) -> None:
    url = call.data["url"]
    comment = call.data.get("comment", "")
    await _broadcast(
        call.hass,
        "add_blocklist",
        lambda c: c.api.add_list(url, comment),
    )


async def _handle_remove_blocklist(call: ServiceCall) -> None:
    url = call.data["url"]
    await _broadcast(
        call.hass,
        "remove_blocklist",
        lambda c: c.api.remove_list(url),
    )


async def _handle_toggle_blocklist(call: ServiceCall) -> None:
    list_id = call.data["list_id"]
    enabled = call.data["enabled"]
    await _broadcast(
        call.hass,
        "toggle_blocklist",
        lambda c: c.api.toggle_list(list_id, enabled),
    )


SCHEMA_DNS_CNAME = vol.Schema(
    {
        vol.Required("domain"): cv.string,
        vol.Required("target"): cv.string,
    }
)


async def _handle_add_dns_cname(call: ServiceCall) -> None:
    domain = call.data["domain"]
    target = call.data["target"]
    await _broadcast(
        call.hass,
        "add_dns_cname",
        lambda c: c.api.add_dns_cname(domain, target),
    )


async def _handle_remove_dns_cname(call: ServiceCall) -> None:
    domain = call.data["domain"]
    target = call.data["target"]
    await _broadcast(
        call.hass,
        "remove_dns_cname",
        lambda c: c.api.remove_dns_cname(domain, target),
    )


async def _handle_compare_dns_records(call: ServiceCall) -> dict[str, Any]:
    coordinators = _get_coordinators(call.hass)
    if not coordinators:
        return {"synced": [], "unsynced": []}

    host_results = await asyncio.gather(
        *(c.api.get_dns_hosts_raw() for c in coordinators),
        return_exceptions=True,
    )
    cname_results = await asyncio.gather(
        *(c.api.get_dns_cnames_raw() for c in coordinators),
        return_exceptions=True,
    )

    instance_names = [c.config_entry.title for c in coordinators]
    host_sets: dict[str, set[str]] = {}
    cname_sets: dict[str, set[str]] = {}
    for name, hosts, cnames in zip(instance_names, host_results, cname_results):
        host_sets[name] = set(hosts) if not isinstance(hosts, Exception) else set()
        cname_sets[name] = set(cnames) if not isinstance(cnames, Exception) else set()

    all_hosts: set[str] = set()
    all_cnames: set[str] = set()
    for s in host_sets.values():
        all_hosts |= s
    for s in cname_sets.values():
        all_cnames |= s

    def _classify(all_records: set[str], per_instance: dict[str, set[str]], rec_type: str):
        synced = []
        unsynced = []
        for record in sorted(all_records):
            present = [n for n in instance_names if record in per_instance[n]]
            missing = [n for n in instance_names if record not in per_instance[n]]
            if rec_type == "A":
                parts = record.split(" ", 1)
                entry = {"ip": parts[0], "domain": parts[1], "type": "A"} if len(parts) == 2 else {"raw": record, "type": "A"}
            else:
                parts = record.split(",", 1)
                entry = {"domain": parts[0], "target": parts[1], "type": "CNAME"} if len(parts) == 2 else {"raw": record, "type": "CNAME"}
            if missing:
                entry["present_on"] = present
                entry["missing_on"] = missing
                unsynced.append(entry)
            else:
                synced.append(entry)
        return synced, unsynced

    synced_h, unsynced_h = _classify(all_hosts, host_sets, "A")
    synced_c, unsynced_c = _classify(all_cnames, cname_sets, "CNAME")

    return {
        "synced": synced_h + synced_c,
        "unsynced": unsynced_h + unsynced_c,
    }


async def _handle_sync_dns_records(call: ServiceCall) -> None:
    coordinators = _get_coordinators(call.hass)
    if not coordinators:
        _LOGGER.warning("No Pi-hole instances configured")
        return

    # Get union of all hosts + cnames
    host_results = await asyncio.gather(
        *(c.api.get_dns_hosts_raw() for c in coordinators),
        return_exceptions=True,
    )
    cname_results = await asyncio.gather(
        *(c.api.get_dns_cnames_raw() for c in coordinators),
        return_exceptions=True,
    )

    all_hosts: set[str] = set()
    all_cnames: set[str] = set()
    for hosts in host_results:
        if not isinstance(hosts, Exception):
            all_hosts.update(hosts)
    for cnames in cname_results:
        if not isinstance(cnames, Exception):
            all_cnames.update(cnames)

    sorted_hosts = sorted(all_hosts)
    sorted_cnames = sorted(all_cnames)

    # Push union to all instances
    success = []
    failed = []
    for coordinator, cur_hosts, cur_cnames in zip(coordinators, host_results, cname_results):
        name = coordinator.config_entry.title
        cur_h = set(cur_hosts) if not isinstance(cur_hosts, Exception) else set()
        cur_c = set(cur_cnames) if not isinstance(cur_cnames, Exception) else set()
        try:
            if cur_h != all_hosts:
                await coordinator.api.set_dns_hosts_raw(sorted_hosts)
            if cur_c != all_cnames:
                await coordinator.api.set_dns_cnames_raw(sorted_cnames)
            success.append({"instance": name})
        except Exception as err:
            _LOGGER.error("sync_dns_records failed on %s: %s", name, err)
            failed.append({"instance": name, "error": str(err)})

    # Refresh
    await asyncio.gather(
        *(c.async_request_refresh() for c in coordinators),
        return_exceptions=True,
    )

    call.hass.bus.async_fire(
        "pihole_manager_sync_result",
        {"action": "sync_dns_records", "success": success, "failed": failed},
    )


SCHEMA_RECENT_QUERIES = vol.Schema(
    {
        vol.Optional("count", default=50): vol.All(vol.Coerce(int), vol.Range(min=10, max=200)),
    }
)

BLOCKED_STATUSES = {"GRAVITY", "BLACKLIST", "REGEX", "DENYLIST", "EXTERNAL_BLOCKED_IP",
                    "EXTERNAL_BLOCKED_NULL", "EXTERNAL_BLOCKED_NXRA", "SPECIAL_DOMAIN"}


async def _handle_get_recent_queries(call: ServiceCall) -> dict[str, Any]:
    count = call.data.get("count", 50)
    coordinators = _get_coordinators(call.hass)
    if not coordinators:
        return {"queries": []}

    # Query only first (primary) instance — queries are instance-specific
    api = coordinators[0].api
    try:
        raw = await api.get_recent_queries(count)
    except Exception as err:
        _LOGGER.error("get_recent_queries failed: %s", err)
        return {"queries": []}

    queries = []
    for q in raw:
        status = q.get("status", "")
        blocked = status in BLOCKED_STATUSES
        queries.append({
            "domain": q.get("domain", ""),
            "client": q.get("client", {}).get("ip", ""),
            "type": q.get("type", ""),
            "status": status,
            "blocked": blocked,
            "time": q.get("time", 0),
        })

    return {"queries": queries}


SCHEMA_TOP_BLOCKED = vol.Schema(
    {
        vol.Optional("count", default=20): vol.All(vol.Coerce(int), vol.Range(min=5, max=100)),
    }
)


async def _handle_get_top_blocked(call: ServiceCall) -> dict[str, Any]:
    count = call.data.get("count", 20)
    coordinators = _get_coordinators(call.hass)
    if not coordinators:
        return {"domains": []}

    results = await asyncio.gather(
        *(c.api.get_top_blocked(count) for c in coordinators),
        return_exceptions=True,
    )

    merged: dict[str, int] = {}
    for coordinator, result in zip(coordinators, results):
        if isinstance(result, Exception):
            _LOGGER.error(
                "get_top_blocked failed on %s: %s",
                coordinator.config_entry.title,
                result,
            )
            continue
        for entry in result:
            domain = entry.get("domain", "")
            hits = entry.get("count", 0)
            merged[domain] = merged.get(domain, 0) + hits

    sorted_domains = sorted(merged.items(), key=lambda x: x[1], reverse=True)[:count]
    domain_list = [{"domain": d, "count": c} for d, c in sorted_domains]
    return {"domains": domain_list}


async def _sync_domains(
    coordinators: list[PiholeManagerCoordinator],
    get_fn: str,
    add_fn: str,
    label: str,
) -> tuple[list[dict], list[dict]]:
    """Sync domains (exact or regex) across all instances.

    Gets all domains from all instances, computes the union,
    and adds missing domains to each instance.
    """
    success: list[dict] = []
    failed: list[dict] = []

    # Get domains from all instances
    results = await asyncio.gather(
        *(getattr(c.api, get_fn)() for c in coordinators),
        return_exceptions=True,
    )

    # Build union: domain_str -> comment (keep first comment found)
    union: dict[str, str] = {}
    per_instance: list[set[str]] = []
    for result in results:
        if isinstance(result, Exception):
            per_instance.append(set())
            continue
        instance_domains: set[str] = set()
        for entry in result:
            domain = entry.get("domain", "")
            if domain and domain not in union:
                union[domain] = entry.get("comment", "")
            instance_domains.add(domain)
        per_instance.append(instance_domains)

    # Add missing domains to each instance
    for coordinator, existing in zip(coordinators, per_instance):
        name = coordinator.config_entry.title
        missing = set(union.keys()) - existing
        if not missing:
            success.append({"instance": name})
            continue
        try:
            for domain in sorted(missing):
                await getattr(coordinator.api, add_fn)(domain, union[domain])
            success.append({"instance": name, "added": len(missing)})
            _LOGGER.info("%s: added %d entries on %s", label, len(missing), name)
        except Exception as err:
            _LOGGER.error("%s failed on %s: %s", label, name, err)
            failed.append({"instance": name, "error": str(err)})

    return success, failed


async def _sync_blocklists(
    coordinators: list[PiholeManagerCoordinator],
) -> tuple[list[dict], list[dict]]:
    """Sync blocklists across all instances.

    Gets all blocklists, computes the union by URL, adds missing ones.
    """
    success: list[dict] = []
    failed: list[dict] = []

    results = await asyncio.gather(
        *(c.api.get_lists() for c in coordinators),
        return_exceptions=True,
    )

    # Build union: url -> comment
    union: dict[str, str] = {}
    per_instance: list[set[str]] = []
    for result in results:
        if isinstance(result, Exception):
            per_instance.append(set())
            continue
        instance_urls: set[str] = set()
        for entry in result:
            url = entry.get("address", "")
            if url and url not in union:
                union[url] = entry.get("comment", "")
            instance_urls.add(url)
        per_instance.append(instance_urls)

    # Add missing blocklists to each instance
    for coordinator, existing in zip(coordinators, per_instance):
        name = coordinator.config_entry.title
        missing = set(union.keys()) - existing
        if not missing:
            success.append({"instance": name})
            continue
        try:
            for url in sorted(missing):
                await coordinator.api.add_list(url, union[url])
            success.append({"instance": name, "added": len(missing)})
            _LOGGER.info("sync_blocklists: added %d lists on %s", len(missing), name)
        except Exception as err:
            _LOGGER.error("sync_blocklists failed on %s: %s", name, err)
            failed.append({"instance": name, "error": str(err)})

    return success, failed


async def _handle_sync_all(call: ServiceCall) -> None:
    coordinators = _get_coordinators(call.hass)
    if not coordinators:
        _LOGGER.warning("No Pi-hole instances configured")
        return

    all_success: list[dict] = []
    all_failed: list[dict] = []

    # 1. Sync DNS Records (A + CNAME) — uses PATCH (set full list)
    _LOGGER.info("sync_all: syncing DNS records...")
    host_results = await asyncio.gather(
        *(c.api.get_dns_hosts_raw() for c in coordinators),
        return_exceptions=True,
    )
    cname_results = await asyncio.gather(
        *(c.api.get_dns_cnames_raw() for c in coordinators),
        return_exceptions=True,
    )
    all_hosts: set[str] = set()
    all_cnames: set[str] = set()
    for hosts in host_results:
        if not isinstance(hosts, Exception):
            all_hosts.update(hosts)
    for cnames in cname_results:
        if not isinstance(cnames, Exception):
            all_cnames.update(cnames)
    sorted_hosts = sorted(all_hosts)
    sorted_cnames = sorted(all_cnames)
    for coordinator, cur_hosts, cur_cnames in zip(coordinators, host_results, cname_results):
        name = coordinator.config_entry.title
        cur_h = set(cur_hosts) if not isinstance(cur_hosts, Exception) else set()
        cur_c = set(cur_cnames) if not isinstance(cur_cnames, Exception) else set()
        try:
            if cur_h != all_hosts:
                await coordinator.api.set_dns_hosts_raw(sorted_hosts)
            if cur_c != all_cnames:
                await coordinator.api.set_dns_cnames_raw(sorted_cnames)
            all_success.append({"instance": name, "step": "dns_records"})
        except Exception as err:
            _LOGGER.error("sync_all dns_records failed on %s: %s", name, err)
            all_failed.append({"instance": name, "step": "dns_records", "error": str(err)})

    # 2. Sync Denied Domains (exact + regex)
    _LOGGER.info("sync_all: syncing denied domains...")
    s, f = await _sync_domains(coordinators, "get_denied_domains", "add_denied_domain", "sync_denied_exact")
    all_success.extend(s)
    all_failed.extend(f)
    s, f = await _sync_domains(coordinators, "get_denied_domains_regex", "add_denied_domain_regex", "sync_denied_regex")
    all_success.extend(s)
    all_failed.extend(f)

    # 3. Sync Allowed Domains (exact + regex)
    _LOGGER.info("sync_all: syncing allowed domains...")
    s, f = await _sync_domains(coordinators, "get_allowed_domains", "add_allowed_domain", "sync_allowed_exact")
    all_success.extend(s)
    all_failed.extend(f)
    s, f = await _sync_domains(coordinators, "get_allowed_domains_regex", "add_allowed_domain_regex", "sync_allowed_regex")
    all_success.extend(s)
    all_failed.extend(f)

    # 4. Sync Blocklists
    _LOGGER.info("sync_all: syncing blocklists...")
    s, f = await _sync_blocklists(coordinators)
    all_success.extend(s)
    all_failed.extend(f)

    # 5. Refresh all coordinators
    _LOGGER.info("sync_all: refreshing all coordinators...")
    await asyncio.gather(
        *(c.async_request_refresh() for c in coordinators),
        return_exceptions=True,
    )

    call.hass.bus.async_fire(
        "pihole_manager_sync_result",
        {
            "action": "sync_all",
            "success": all_success,
            "failed": all_failed,
        },
    )

    _LOGGER.info(
        "sync_all complete: %d succeeded, %d failed",
        len(all_success),
        len(all_failed),
    )


# ── Service registration ─────────────────────────────────

SERVICES = {
    "add_denied_domain": (_handle_add_denied_domain, SCHEMA_DOMAIN, None),
    "remove_denied_domain": (_handle_remove_denied_domain, SCHEMA_DOMAIN_ONLY, None),
    "add_allowed_domain": (_handle_add_allowed_domain, SCHEMA_DOMAIN, None),
    "remove_allowed_domain": (_handle_remove_allowed_domain, SCHEMA_DOMAIN_ONLY, None),
    "add_dns_record": (_handle_add_dns_record, SCHEMA_DNS_RECORD, None),
    "remove_dns_record": (_handle_remove_dns_record, SCHEMA_DNS_RECORD, None),
    "add_dns_cname": (_handle_add_dns_cname, SCHEMA_DNS_CNAME, None),
    "remove_dns_cname": (_handle_remove_dns_cname, SCHEMA_DNS_CNAME, None),
    "compare_dns_records": (_handle_compare_dns_records, None, SupportsResponse.OPTIONAL),
    "sync_dns_records": (_handle_sync_dns_records, None, None),
    "add_blocklist": (_handle_add_blocklist, SCHEMA_BLOCKLIST, None),
    "remove_blocklist": (_handle_remove_blocklist, SCHEMA_BLOCKLIST_ONLY, None),
    "toggle_blocklist": (_handle_toggle_blocklist, SCHEMA_TOGGLE_BLOCKLIST, None),
    "get_recent_queries": (_handle_get_recent_queries, SCHEMA_RECENT_QUERIES, SupportsResponse.OPTIONAL),
    "get_top_blocked": (_handle_get_top_blocked, SCHEMA_TOP_BLOCKED, SupportsResponse.OPTIONAL),
    "sync_all": (_handle_sync_all, None, None),
}


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register all Pi-hole Manager services."""
    for name, (handler, schema, response) in SERVICES.items():
        hass.services.async_register(
            DOMAIN, name, handler, schema=schema,
            supports_response=response,
        )


async def async_unload_services(hass: HomeAssistant) -> None:
    """Unregister all Pi-hole Manager services."""
    for name in SERVICES:
        hass.services.async_remove(DOMAIN, name)
