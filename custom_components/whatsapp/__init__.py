"""The Home Assistant WhatsApp integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import WhatsAppAddonApiClient
from .const import CONF_API_KEY, CONF_URL, CONF_VERIFY_SSL, DOMAIN, PLATFORMS
from .coordinator import WhatsAppDataUpdateCoordinator
from .services import async_register_services, async_unregister_services

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WhatsApp from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    url = entry.data[CONF_URL]
    api_key = entry.data[CONF_API_KEY]
    verify_ssl = bool(entry.data.get(CONF_VERIFY_SSL, True))

    session = async_get_clientsession(hass, verify_ssl=verify_ssl)
    client = WhatsAppAddonApiClient(
        base_url=url,
        api_key=api_key,
        session=session,
        verify_ssl=verify_ssl,
    )

    coordinator = WhatsAppDataUpdateCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await async_register_services(hass)

    coordinator.start_websocket()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a WhatsApp config entry cleanly."""
    coordinator: WhatsAppDataUpdateCoordinator | None = hass.data.get(DOMAIN, {}).get(
        entry.entry_id
    )
    if coordinator:
        await coordinator.async_stop_websocket()

    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if not hass.data[DOMAIN]:
            await async_unregister_services(hass)

    return unload_ok
