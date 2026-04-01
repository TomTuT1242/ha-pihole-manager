"""Config flow for Pi-hole Manager."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PiholeApiClient, PiholeAuthError, PiholeConnectionError
from .const import (
    CONF_HOST,
    CONF_NAME,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USE_SSL,
    CONF_VERIFY_SSL,
    CONF_WEBUI_URL,
    DEFAULT_PORT,
    DEFAULT_USE_SSL,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME, default="Pi-hole"): str,
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Required(CONF_PASSWORD): str,
        vol.Optional(CONF_USE_SSL, default=DEFAULT_USE_SSL): bool,
        vol.Optional(CONF_VERIFY_SSL, default=DEFAULT_VERIFY_SSL): bool,
        vol.Optional(CONF_WEBUI_URL, default=""): str,
    }
)


async def _test_connection(hass: HomeAssistant, data: dict[str, Any]) -> dict[str, Any]:
    """Test if we can connect and authenticate with the Pi-hole instance."""
    session = async_get_clientsession(
        hass, verify_ssl=data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL)
    )
    client = PiholeApiClient(
        host=data[CONF_HOST],
        port=data[CONF_PORT],
        password=data[CONF_PASSWORD],
        use_ssl=data.get(CONF_USE_SSL, DEFAULT_USE_SSL),
        verify_ssl=data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
        session=session,
    )
    try:
        await client.authenticate()
        return {"title": data[CONF_NAME]}
    finally:
        # Don't close the session — it's HA's shared session
        pass


class PiholeManagerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Pi-hole Manager."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step — add a Pi-hole instance."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # Use host:port as unique ID to prevent duplicates
            unique_id = f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
            await self.async_set_unique_id(unique_id)
            self._abort_if_unique_id_configured()

            try:
                info = await _test_connection(self.hass, user_input)
            except PiholeAuthError:
                errors["base"] = "invalid_auth"
            except PiholeConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during Pi-hole connection test")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title=info["title"],
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle reconfiguration of an existing entry."""
        errors: dict[str, str] = {}
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])

        if user_input is not None:
            try:
                info = await _test_connection(self.hass, user_input)
            except PiholeAuthError:
                errors["base"] = "invalid_auth"
            except PiholeConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during Pi-hole connection test")
                errors["base"] = "unknown"
            else:
                return self.async_update_reload_and_abort(
                    entry,
                    title=info["title"],
                    data=user_input,
                )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME, default=entry.data.get(CONF_NAME, "Pi-hole")): str,
                    vol.Required(CONF_HOST, default=entry.data.get(CONF_HOST, "")): str,
                    vol.Required(CONF_PORT, default=entry.data.get(CONF_PORT, DEFAULT_PORT)): int,
                    vol.Required(CONF_PASSWORD, default=entry.data.get(CONF_PASSWORD, "")): str,
                    vol.Optional(
                        CONF_USE_SSL,
                        default=entry.data.get(CONF_USE_SSL, DEFAULT_USE_SSL),
                    ): bool,
                    vol.Optional(
                        CONF_VERIFY_SSL,
                        default=entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
                    ): bool,
                    vol.Optional(
                        CONF_WEBUI_URL,
                        default=entry.data.get(CONF_WEBUI_URL, ""),
                    ): str,
                }
            ),
            errors=errors,
        )
