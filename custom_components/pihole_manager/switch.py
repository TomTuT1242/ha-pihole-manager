"""Switch platform for Pi-hole Manager — Blocking Toggle."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import PiholeApiError
from .const import DOMAIN
from .coordinator import PiholeManagerCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Pi-hole Manager switches."""
    coordinator: PiholeManagerCoordinator = entry.runtime_data
    async_add_entities([PiholeBlockingSwitch(coordinator)])


class PiholeBlockingSwitch(CoordinatorEntity[PiholeManagerCoordinator], SwitchEntity):
    """Switch to toggle Pi-hole blocking on/off."""

    _attr_has_entity_name = True
    _attr_translation_key = "blocking"
    _attr_icon = "mdi:shield-check"

    def __init__(self, coordinator: PiholeManagerCoordinator) -> None:
        """Initialize the switch."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_blocking"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, coordinator.config_entry.entry_id)},
            "name": coordinator.config_entry.title,
            "manufacturer": "Pi-hole",
            "model": "Pi-hole v6",
        }

    @property
    def is_on(self) -> bool | None:
        """Return True if blocking is enabled."""
        if self.coordinator.data is None:
            return None
        return self.coordinator.data.get("blocking", False)

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable blocking."""
        try:
            await self.coordinator.api.set_blocking(True)
        except PiholeApiError as err:
            _LOGGER.error("Failed to enable blocking: %s", err)
            return
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable blocking."""
        try:
            await self.coordinator.api.set_blocking(False)
        except PiholeApiError as err:
            _LOGGER.error("Failed to disable blocking: %s", err)
            return
        await self.coordinator.async_request_refresh()
