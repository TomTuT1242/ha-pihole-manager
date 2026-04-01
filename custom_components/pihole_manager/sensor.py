"""Sensor platform for Pi-hole Manager."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import PiholeManagerCoordinator


@dataclass(frozen=True, kw_only=True)
class PiholeSensorEntityDescription(SensorEntityDescription):
    """Describe a Pi-hole Manager sensor."""

    value_fn: Callable[[dict[str, Any]], Any]
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


SENSOR_DESCRIPTIONS: tuple[PiholeSensorEntityDescription, ...] = (
    PiholeSensorEntityDescription(
        key="queries_total",
        translation_key="queries_total",
        native_unit_of_measurement="queries",
        state_class=SensorStateClass.TOTAL,
        value_fn=lambda data: data.get("info", {}).get("queries", {}).get("total"),
        attrs_fn=lambda data: {
            "webui_url": data.get("webui_url") or f"{data.get('base_url', '').replace('http://', 'https://')}/admin"
        } if data.get("base_url") else None,
    ),
    PiholeSensorEntityDescription(
        key="queries_blocked",
        translation_key="queries_blocked",
        native_unit_of_measurement="queries",
        state_class=SensorStateClass.TOTAL,
        value_fn=lambda data: data.get("info", {}).get("queries", {}).get("blocked"),
    ),
    PiholeSensorEntityDescription(
        key="percent_blocked",
        translation_key="percent_blocked",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: round(
            data.get("info", {}).get("queries", {}).get("percent_blocked", 0), 1
        ),
    ),
    PiholeSensorEntityDescription(
        key="domains_blocked",
        translation_key="domains_blocked",
        native_unit_of_measurement="domains",
        state_class=SensorStateClass.TOTAL,
        value_fn=lambda data: data.get("info", {}).get("gravity", {}).get("domains_being_blocked"),
    ),
    PiholeSensorEntityDescription(
        key="blocklists",
        translation_key="blocklists",
        native_unit_of_measurement="lists",
        value_fn=lambda data: len(data.get("lists", [])),
        attrs_fn=lambda data: {
            "items": [
                {
                    "id": lst.get("id"),
                    "address": lst.get("address", ""),
                    "enabled": lst.get("enabled", True),
                    "comment": lst.get("comment", ""),
                }
                for lst in data.get("lists", [])
            ]
        },
    ),
    PiholeSensorEntityDescription(
        key="denied_domains",
        translation_key="denied_domains",
        native_unit_of_measurement="domains",
        value_fn=lambda data: len(data.get("denied_domains", [])),
        attrs_fn=lambda data: {
            "items": [
                {
                    "domain": d.get("domain", ""),
                    "comment": d.get("comment", ""),
                }
                for d in data.get("denied_domains", [])
            ]
        },
    ),
    PiholeSensorEntityDescription(
        key="allowed_domains",
        translation_key="allowed_domains",
        native_unit_of_measurement="domains",
        value_fn=lambda data: len(data.get("allowed_domains", [])),
        attrs_fn=lambda data: {
            "items": [
                {
                    "domain": d.get("domain", ""),
                    "comment": d.get("comment", ""),
                }
                for d in data.get("allowed_domains", [])
            ]
        },
    ),
    PiholeSensorEntityDescription(
        key="dns_records",
        translation_key="dns_records",
        native_unit_of_measurement="records",
        value_fn=lambda data: len(data.get("dns_hosts", [])) + len(data.get("dns_cnames", [])),
        attrs_fn=lambda data: {
            "items": [
                {
                    "ip": r.get("ip", ""),
                    "domain": r.get("domain", ""),
                }
                for r in data.get("dns_hosts", [])
            ],
            "cname_items": [
                {
                    "domain": r.get("domain", ""),
                    "target": r.get("target", ""),
                }
                for r in data.get("dns_cnames", [])
            ],
            "a_count": len(data.get("dns_hosts", [])),
            "cname_count": len(data.get("dns_cnames", [])),
        },
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Pi-hole Manager sensors."""
    coordinator: PiholeManagerCoordinator = entry.runtime_data
    async_add_entities(
        PiholeSensor(coordinator, description) for description in SENSOR_DESCRIPTIONS
    )


class PiholeSensor(CoordinatorEntity[PiholeManagerCoordinator], SensorEntity):
    """Representation of a Pi-hole sensor."""

    entity_description: PiholeSensorEntityDescription
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: PiholeManagerCoordinator,
        description: PiholeSensorEntityDescription,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_{description.key}"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, coordinator.config_entry.entry_id)},
            "name": coordinator.config_entry.title,
            "manufacturer": "Pi-hole",
            "model": "Pi-hole v6",
        }

    @property
    def native_value(self) -> Any:
        """Return the sensor value."""
        return self.entity_description.value_fn(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return extra state attributes with raw data."""
        if self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self.coordinator.data)
