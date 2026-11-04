"""DataUpdateCoordinator and live WebSocket event bridge for WhatsApp."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any, Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import (
    WhatsAppAddonApiClient,
    WhatsAppApiError,
    WhatsAppAuthError,
    WhatsAppConnectionError,
)
from .const import (
    DOMAIN,
    EVENT_CONNECTION_UPDATE,
    EVENT_MESSAGE_SENT,
    EVENT_MESSAGE_STATUS,
    EVENT_NEW_MESSAGE,
    EVENT_SEND_MESSAGE_RESULT,
    UPDATE_INTERVAL_SECONDS,
)

_LOGGER = logging.getLogger(__name__)


class WhatsAppDataUpdateCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Manages polling and live WebSocket updates from the WhatsApp Add-on."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: WhatsAppAddonApiClient,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{entry.entry_id}",
            update_interval=timedelta(seconds=UPDATE_INTERVAL_SECONDS),
        )
        self.entry = entry
        self.client = client
        self.health: dict[str, Any] = {}
        self.known_client_ids: set[str] = set()
        self._new_account_callbacks: list[Callable[[list[str]], None]] = []
        self._ws_stop_event = asyncio.Event()
        self._ws_task: asyncio.Task[None] | None = None

    def register_new_account_listener(self, listener: Callable[[list[str]], None]) -> None:
        """Register callback invoked when new WhatsApp accounts are added in the add-on."""
        self._new_account_callbacks.append(listener)

    def _notify_new_accounts(self, accounts_by_id: dict[str, dict[str, Any]]) -> None:
        new_ids = [cid for cid in accounts_by_id if cid not in self.known_client_ids]
        if new_ids:
            self.known_client_ids.update(new_ids)
            for cb in self._new_account_callbacks:
                cb(new_ids)

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        """Fetch latest account states and health from the WhatsApp Add-on."""
        try:
            health_res, accounts_list = await asyncio.gather(
                self.client.get_health(),
                self.client.get_accounts(),
            )
            self.health = health_res
            accounts_by_id = {
                str(acc["clientId"]): acc
                for acc in accounts_list
                if isinstance(acc, dict) and "clientId" in acc
            }
            self._notify_new_accounts(accounts_by_id)
            return accounts_by_id
        except WhatsAppAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except (WhatsAppConnectionError, WhatsAppApiError) as err:
            raise UpdateFailed(f"Error communicating with WhatsApp add-on: {err}") from err

    def start_websocket(self) -> None:
        """Start background WebSocket listener task."""
        if self._ws_task is not None and not self._ws_task.done():
            return
        self._ws_stop_event.clear()
        self._ws_task = self.hass.async_create_background_task(
            self.client.listen_websocket(self._handle_ws_envelope, self._ws_stop_event),
            name=f"{DOMAIN}_ws_{self.entry.entry_id}",
        )

    async def async_stop_websocket(self) -> None:
        """Stop background WebSocket listener task cleanly."""
        self._ws_stop_event.set()
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
        self._ws_task = None

    @callback
    def _handle_ws_envelope(self, envelope: dict[str, Any]) -> None:
        """Process live WebSocket events from the add-on and fire HA events."""
        event_type = envelope.get("type")
        payload = envelope.get("payload")
        if not isinstance(payload, dict):
            return

        if event_type == "initial_state":
            accounts_list = payload.get("accounts", [])
            if isinstance(accounts_list, list):
                accounts_by_id = {
                    str(acc["clientId"]): acc
                    for acc in accounts_list
                    if isinstance(acc, dict) and "clientId" in acc
                }
                self._notify_new_accounts(accounts_by_id)
                self.async_set_updated_data(accounts_by_id)
            return

        if event_type == EVENT_NEW_MESSAGE:
            self.hass.bus.async_fire(EVENT_NEW_MESSAGE, payload)
            self._increment_local_stat(
                payload.get("clientId", "default"),
                "messagesReceived",
                last_message=f"{payload.get('senderName') or payload.get('sender')}: {payload.get('text') or '[' + str(payload.get('messageType')) + ']'}",
            )
            return

        if event_type == EVENT_MESSAGE_SENT:
            self.hass.bus.async_fire(EVENT_MESSAGE_SENT, payload)
            self._increment_local_stat(
                payload.get("clientId", "default"),
                "messagesSent",
                last_message=f"To {payload.get('recipient')}: [{payload.get('messageType')}]",
            )
            return

        if event_type == EVENT_MESSAGE_STATUS:
            self.hass.bus.async_fire(EVENT_MESSAGE_STATUS, payload)
            if payload.get("status") == "failed":
                self._increment_local_stat(payload.get("clientId", "default"), "messagesFailed")
            return

        if event_type == EVENT_SEND_MESSAGE_RESULT:
            self.hass.bus.async_fire(EVENT_SEND_MESSAGE_RESULT, payload)
            return

        if event_type == EVENT_CONNECTION_UPDATE:
            self.hass.bus.async_fire(EVENT_CONNECTION_UPDATE, payload)
            client_id = payload.get("clientId")
            if client_id and self.data and client_id in self.data:
                updated = dict(self.data)
                acc = dict(updated[client_id])
                acc["status"] = payload.get("status", acc.get("status"))
                acc["connected"] = acc["status"] == "connected"
                if payload.get("phone"):
                    acc["phone"] = payload["phone"]
                if payload.get("lastConnectedAt"):
                    acc["lastConnectedAt"] = payload["lastConnectedAt"]
                acc["lastError"] = payload.get("error")
                updated[client_id] = acc
                self.async_set_updated_data(updated)
            else:
                self.hass.async_create_task(self.async_request_refresh())

    @callback
    def _increment_local_stat(
        self,
        client_id: str,
        stat_key: str,
        last_message: str | None = None,
    ) -> None:
        if not self.data or client_id not in self.data:
            return
        updated = dict(self.data)
        acc = dict(updated[client_id])
        stats = dict(acc.get("stats") or {})
        stats[stat_key] = int(stats.get(stat_key, 0)) + 1
        if last_message is not None:
            stats["lastMessage"] = last_message[:120]
        acc["stats"] = stats
        updated[client_id] = acc
        self.async_set_updated_data(updated)
