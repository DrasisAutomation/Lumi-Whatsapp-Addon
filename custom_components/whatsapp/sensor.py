"""Sensor platform for Home Assistant WhatsApp accounts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WhatsAppDataUpdateCoordinator


@dataclass(frozen=True, kw_only=True)
class WhatsAppSensorEntityDescription(SensorEntityDescription):
    """Describes a WhatsApp account sensor entity."""

    value_fn: Callable[[dict[str, Any]], Any]


SENSOR_DESCRIPTIONS: tuple[WhatsAppSensorEntityDescription, ...] = (
    WhatsAppSensorEntityDescription(
        key="status",
        name="Status",
        icon="mdi:whatsapp",
        value_fn=lambda acc: acc.get("status", "disconnected"),
    ),
    WhatsAppSensorEntityDescription(
        key="phone",
        name="Phone",
        icon="mdi:phone",
        value_fn=lambda acc: acc.get("phone") or "Unlinked",
    ),
    WhatsAppSensorEntityDescription(
        key="messages_sent",
        name="Messages Sent",
        icon="mdi:message-arrow-right-outline",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda acc: int((acc.get("stats") or {}).get("messagesSent", 0)),
    ),
    WhatsAppSensorEntityDescription(
        key="messages_received",
        name="Messages Received",
        icon="mdi:message-arrow-left-outline",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda acc: int((acc.get("stats") or {}).get("messagesReceived", 0)),
    ),
    WhatsAppSensorEntityDescription(
        key="pending_messages",
        name="Pending Messages",
        icon="mdi:tray-full",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda acc: int((acc.get("stats") or {}).get("messagesPending", 0)),
    ),
    WhatsAppSensorEntityDescription(
        key="failed_messages",
        name="Failed Messages",
        icon="mdi:message-alert-outline",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda acc: int((acc.get("stats") or {}).get("messagesFailed", 0)),
    ),
    WhatsAppSensorEntityDescription(
        key="last_message",
        name="Last Message",
        icon="mdi:message-text-clock-outline",
        value_fn=lambda acc: str((acc.get("stats") or {}).get("lastMessage") or "None")[:255],
    ),
)


def build_account_device_info(
    entry_id: str, client_id: str, account_data: dict[str, Any], sw_version: str = "1.0.0"
) -> DeviceInfo:
    """Build Home Assistant DeviceInfo for a single WhatsApp account."""
    raw_name = account_data.get("name") or f"{client_id.capitalize()} Account"
    device_name = (
        raw_name
        if raw_name.lower().startswith("whatsapp")
        else f"WhatsApp - {raw_name}"
    )
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_{client_id}")},
        name=device_name,
        manufacturer="HA WhatsApp (Baileys)",
        model=f"Linked Device ({client_id})",
        sw_version=sw_version,
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up WhatsApp sensor entities for each account."""
    coordinator: WhatsAppDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]
    created_client_ids: set[str] = set()

    @callback
    def _add_accounts(client_ids: list[str]) -> None:
        new_entities: list[WhatsAppAccountSensor] = []
        for cid in client_ids:
            if cid in created_client_ids:
                continue
            created_client_ids.add(cid)
            for desc in SENSOR_DESCRIPTIONS:
                new_entities.append(WhatsAppAccountSensor(coordinator, entry, cid, desc))
        if new_entities:
            async_add_entities(new_entities)

    initial_ids = list((coordinator.data or {}).keys())
    _add_accounts(initial_ids)
    coordinator.register_new_account_listener(_add_accounts)


class WhatsAppAccountSensor(CoordinatorEntity[WhatsAppDataUpdateCoordinator], SensorEntity):
    """Sensor entity representing a metric or attribute of a WhatsApp account."""

    entity_description: WhatsAppSensorEntityDescription
    _attr_has_entity_name = False

    def __init__(
        self,
        coordinator: WhatsAppDataUpdateCoordinator,
        entry: ConfigEntry,
        client_id: str,
        description: WhatsAppSensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._entry = entry
        self._client_id = client_id
        slug_client = client_id.lower().replace("-", "_")
        self._attr_unique_id = f"{entry.entry_id}_{slug_client}_{description.key}"
        self.entity_id = f"sensor.whatsapp_{slug_client}_{description.key}"
        self._attr_name = f"WhatsApp {client_id.capitalize()} {description.name}"

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
    def native_value(self) -> Any:
        return self.entity_description.value_fn(self._account_data)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        acc = self._account_data
        return {
            "client_id": self._client_id,
            "session_health": acc.get("sessionHealth"),
            "last_connected_at": acc.get("lastConnectedAt"),
            "last_active_at": acc.get("lastActiveAt"),
            "qr_available": acc.get("qrAvailable", False),
        }
