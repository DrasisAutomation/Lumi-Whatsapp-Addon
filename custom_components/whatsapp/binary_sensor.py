"""Binary sensor platform for Home Assistant WhatsApp accounts."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WhatsAppDataUpdateCoordinator
from .sensor import build_account_device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up WhatsApp connectivity binary sensor for each account."""
    coordinator: WhatsAppDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]
    created_client_ids: set[str] = set()

    @callback
    def _add_accounts(client_ids: list[str]) -> None:
        new_entities: list[WhatsAppConnectedBinarySensor] = []
        for cid in client_ids:
            if cid in created_client_ids:
                continue
            created_client_ids.add(cid)
            new_entities.append(WhatsAppConnectedBinarySensor(coordinator, entry, cid))
        if new_entities:
            async_add_entities(new_entities)

    initial_ids = list((coordinator.data or {}).keys())
    _add_accounts(initial_ids)
    coordinator.register_new_account_listener(_add_accounts)


class WhatsAppConnectedBinarySensor(
    CoordinatorEntity[WhatsAppDataUpdateCoordinator], BinarySensorEntity
):
    """Binary sensor indicating whether a WhatsApp account is connected."""

    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_has_entity_name = False
    _attr_icon = "mdi:whatsapp"

    def __init__(
        self,
        coordinator: WhatsAppDataUpdateCoordinator,
        entry: ConfigEntry,
        client_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._client_id = client_id
        slug_client = client_id.lower().replace("-", "_")
        self._attr_unique_id = f"{entry.entry_id}_{slug_client}_connected"
        self.entity_id = f"binary_sensor.whatsapp_{slug_client}_connected"
        self._attr_name = f"WhatsApp {client_id.capitalize()} Connected"

    @property
    def _account_data(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get(self._client_id, {})

    @property
    def device_info(self) -> DeviceInfo:
        sw_ver = str((self.coordinator.health or {}).get("version", "1.0.0"))
        return build_account_device_info(
            self._entry.entry_id,
            self._client_id,
            self._account_data,
            sw_version=sw_ver,
        )

    @property
    def is_on(self) -> bool:
        acc = self._account_data
        return bool(acc.get("connected") or acc.get("status") == "connected")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account_data
        return {
            "client_id": self._client_id,
            "status": acc.get("status", "disconnected"),
            "phone": acc.get("phone"),
            "session_health": acc.get("sessionHealth"),
        }
