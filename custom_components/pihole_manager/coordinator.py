"""DataUpdateCoordinator for Pi-hole Manager."""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import PiholeApiClient, PiholeApiError
from .const import CONF_WEBUI_URL, DEFAULT_SCAN_INTERVAL, DOMAIN

_LOGGER = logging.getLogger(__name__)

type PiholeManagerConfigEntry = ConfigEntry[PiholeManagerCoordinator]


class PiholeManagerCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator to fetch data from a Pi-hole instance."""

    config_entry: PiholeManagerConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry: PiholeManagerConfigEntry,
        api_client: PiholeApiClient,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{config_entry.title}",
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL),
            config_entry=config_entry,
        )
        self.api = api_client

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch data from the Pi-hole API."""
        try:
            info = await self.api.get_stats_summary()
            blocking = await self.api.get_blocking_status()
            denied = await self.api.get_denied_domains()
            allowed = await self.api.get_allowed_domains()
            dns_hosts = await self.api.get_dns_hosts()
            dns_cnames = await self.api.get_dns_cnames()
            lists = await self.api.get_lists()
        except PiholeApiError as err:
            raise UpdateFailed(f"Error fetching data from {self.api.base_url}: {err}") from err

        return {
            "info": info,
            "blocking": blocking,
            "denied_domains": denied,
            "allowed_domains": allowed,
            "dns_hosts": dns_hosts,
            "dns_cnames": dns_cnames,
            "lists": lists,
            "base_url": self.api.base_url,
            "webui_url": self.config_entry.data.get(CONF_WEBUI_URL, ""),
        }
