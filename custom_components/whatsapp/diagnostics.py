"""Diagnostics support for the Home Assistant WhatsApp integration."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_API_KEY, DOMAIN
from .coordinator import WhatsAppDataUpdateCoordinator

TO_REDACT = {
    CONF_API_KEY,
    "apiKey",
    "token",
    "Authorization",
    "qr",
    "qrRaw",
    "qrDataUrl",
    "creds",
    "noiseKey",
    "signedIdentityKey",
    "signedPreKey",
    "advSecretKey",
    "phone",
    "jid",
    "lastMessage",
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return sanitized diagnostics for a config entry."""
    coordinator: WhatsAppDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]

    try:
        addon_diagnostics = await coordinator.client.get_diagnostics()
    except Exception as err:
        addon_diagnostics = {"error": str(err)}

    raw_payload = {
        "config_entry": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "data": dict(entry.data),
        },
        "coordinator_accounts": dict(coordinator.data or {}),
        "addon_diagnostics": addon_diagnostics,
    }

    return async_redact_data(raw_payload, TO_REDACT)
