"""Pi-hole Manager — Custom Integration for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PiholeApiClient
from .const import (
    CONF_HOST,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USE_SSL,
    CONF_VERIFY_SSL,
    DEFAULT_USE_SSL,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
)
from .coordinator import PiholeManagerCoordinator
from .services import async_setup_services, async_unload_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor", "switch"]

CARD_URL = "/pihole_manager/pihole-manager-card.js"
CARD_NAME = "pihole-manager-card"

type PiholeManagerConfigEntry = ConfigEntry[PiholeManagerCoordinator]


async def _async_register_card(hass: HomeAssistant) -> None:
    """Register the Lovelace card JS as a static resource."""
    # Serve the www/ folder under /pihole_manager/
    hass.http.register_static_path(
        "/pihole_manager",
        str(Path(__file__).parent / "www"),
        cache_headers=False,
    )

    # Register as Lovelace resource if not already registered
    try:
        resources = hass.data.get("lovelace", {}).get("resources")
        if resources is None:
            _LOGGER.debug("Lovelace resources not available, skipping card registration")
            return

        if not resources.loaded:
            await resources.async_load()

        for item in resources.async_items():
            if CARD_NAME in item.get("url", ""):
                return  # Already registered

        await resources.async_create_item({"res_type": "module", "url": CARD_URL})
        _LOGGER.info("Registered Lovelace resource: %s", CARD_URL)
    except Exception:
        _LOGGER.warning(
            "Could not auto-register Lovelace resource. "
            "Please add manually: URL=%s, Type=module", CARD_URL
        )


async def async_setup_entry(hass: HomeAssistant, entry: PiholeManagerConfigEntry) -> bool:
    """Set up Pi-hole Manager from a config entry."""
    session = async_get_clientsession(
        hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL)
    )
    client = PiholeApiClient(
        host=entry.data[CONF_HOST],
        port=entry.data[CONF_PORT],
        password=entry.data[CONF_PASSWORD],
        use_ssl=entry.data.get(CONF_USE_SSL, DEFAULT_USE_SSL),
        verify_ssl=entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
        session=session,
    )

    coordinator = PiholeManagerCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = coordinator

    # Store coordinator in hass.data for service access
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Register card + services on first entry
    if len(hass.data[DOMAIN]) == 1:
        await _async_register_card(hass)
        await async_setup_services(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PiholeManagerConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)

        # Unregister services when last entry is removed
        if not hass.data[DOMAIN]:
            await async_unload_services(hass)
            hass.data.pop(DOMAIN, None)

    return unload_ok
