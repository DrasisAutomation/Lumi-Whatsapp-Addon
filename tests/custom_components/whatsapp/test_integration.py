"""Comprehensive unit & integration tests for the Home Assistant WhatsApp HACS integration."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any
import unittest
from unittest.mock import AsyncMock, patch

# Ensure repository root is on sys.path
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.custom_components.whatsapp.ha_test_harness import (  # noqa: E402
    install_homeassistant_Test_shims,
)

install_homeassistant_Test_shims()

from homeassistant.config_entries import ConfigEntry  # noqa: E402
from homeassistant.core import HomeAssistant  # noqa: E402
from homeassistant.exceptions import HomeAssistantError  # noqa: E402
import voluptuous as vol  # noqa: E402

from custom_components.whatsapp import async_setup_entry, async_unload_entry  # noqa: E402
from custom_components.whatsapp.api import (  # noqa: E402
    WhatsAppAddonApiClient,
    WhatsAppApiError,
    WhatsAppAuthError,
)
from custom_components.whatsapp.binary_sensor import (  # noqa: E402
    async_setup_entry as async_setup_binary_sensors,
)
from custom_components.whatsapp.config_flow import WhatsAppConfigFlow  # noqa: E402
from custom_components.whatsapp.const import (  # noqa: E402
    ALL_SERVICES,
    CONF_API_KEY,
    CONF_URL,
    DOMAIN,
    EVENT_CONNECTION_UPDATE,
    EVENT_MESSAGE_SENT,
    EVENT_MESSAGE_STATUS,
    EVENT_NEW_MESSAGE,
    EVENT_SEND_MESSAGE_RESULT,
)
from custom_components.whatsapp.coordinator import (  # noqa: E402
    WhatsAppDataUpdateCoordinator,
)
from custom_components.whatsapp.diagnostics import (  # noqa: E402
    async_get_config_entry_diagnostics,
)
from custom_components.whatsapp.sensor import (  # noqa: E402
    async_setup_entry as async_setup_sensors,
)
from custom_components.whatsapp.services import async_register_services  # noqa: E402


SAMPLE_ACCOUNTS = [
    {
        "clientId": "default",
        "name": "Default Account",
        "status": "connected",
        "connected": True,
        "sessionHealth": "healthy",
        "phone": "919876543210",
        "jid": "919876543210@s.whatsapp.net",
        "qrAvailable": False,
        "lastConnectedAt": "2026-11-04T10:00:00Z",
        "lastActiveAt": "2026-11-04T10:05:00Z",
        "stats": {
            "messagesSent": 12,
            "messagesReceived": 5,
            "messagesPending": 1,
            "messagesFailed": 0,
            "lastMessage": "Alice: STATUS",
        },
    }
]


class TestWhatsAppIntegration(unittest.IsolatedAsyncioTestCase):
    """Test suite covering Config Flow, API Client, Coordinator, Entities, Services, and Diagnostics."""

    def test_manifest_and_translations_valid(self) -> None:
        """Verify manifest.json, strings.json, and translations/en.json are valid."""
        comp_dir = REPO_ROOT / "custom_components" / "whatsapp"
        manifest = json.loads((comp_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["domain"], "whatsapp")
        self.assertEqual(manifest["name"], "Lumi Whatsapp")
        self.assertTrue(manifest["config_flow"])
        self.assertEqual(manifest["iot_class"], "local_push")
        self.assertTrue((comp_dir / "logo.png").exists())
        self.assertTrue((comp_dir / "icon.png").exists())
        self.assertTrue((comp_dir / "brand" / "logo.png").exists())
        self.assertTrue((comp_dir / "brand" / "icon.png").exists())

        strings = json.loads((comp_dir / "strings.json").read_text(encoding="utf-8"))
        en_trans = json.loads((comp_dir / "translations" / "en.json").read_text(encoding="utf-8"))
        self.assertEqual(strings, en_trans)

    async def test_config_flow_user_and_hassio_discovery(self) -> None:
        """Test ConfigFlow user setup, auth failure, connection failure, and Supervisor discovery."""
        hass = HomeAssistant()
        flow = WhatsAppConfigFlow()
        flow.hass = hass

        # 1. Show initial form
        form_res = await flow.async_step_user(None)
        self.assertEqual(form_res["type"], "form")
        self.assertEqual(form_res["step_id"], "user")

        # 2. Invalid auth error handling
        with patch(
            "custom_components.whatsapp.config_flow.validate_addon_connection",
            side_effect=WhatsAppAuthError("Invalid token"),
        ):
            err_res = await flow.async_step_user(
                {CONF_URL: "http://local-whatsapp:8099", CONF_API_KEY: "bad_token"}
            )
            self.assertEqual(err_res["errors"]["base"], "invalid_auth")

        # 3. Successful configuration creates entry
        with patch(
            "custom_components.whatsapp.config_flow.validate_addon_connection",
            return_value={"title": "WhatsApp", "version": "1.0.0", "accounts_count": 1},
        ):
            ok_res = await flow.async_step_user(
                {CONF_URL: "http://local-whatsapp:8099/", CONF_API_KEY: "valid_secret_token"}
            )
            self.assertEqual(ok_res["type"], "create_entry")
            self.assertEqual(ok_res["data"][CONF_URL], "http://local-whatsapp:8099")
            self.assertEqual(ok_res["data"][CONF_API_KEY], "valid_secret_token")

        # 4. Supervisor hassio discovery step pre-fills discovered URL
        hassio_res = await flow.async_step_hassio({"slug": "local_whatsapp"})
        self.assertEqual(hassio_res["type"], "form")
        self.assertEqual(flow._discovered_url, "http://local-whatsapp:8099")

    async def test_coordinator_entities_and_live_websocket_events(self) -> None:
        """Test Coordinator refresh, all 7 Sensors + 1 Binary Sensor, DeviceInfo, and WebSocket events."""
        hass = HomeAssistant()
        entry = ConfigEntry(
            entry_id="entry_123",
            title="WhatsApp",
            data={CONF_URL: "http://local-whatsapp:8099", CONF_API_KEY: "secret_token"},
        )

        mock_client = WhatsAppAddonApiClient("http://local-whatsapp:8099", "secret_token")
        mock_client.get_health = AsyncMock(return_value={"status": "ok", "version": "1.0.0"})
        mock_client.get_accounts = AsyncMock(return_value=SAMPLE_ACCOUNTS)

        coordinator = WhatsAppDataUpdateCoordinator(hass, entry, mock_client)
        await coordinator.async_config_entry_first_refresh()
        hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

        sensors: list[Any] = []
        binary_sensors: list[Any] = []

        await async_setup_sensors(hass, entry, lambda ents: sensors.extend(ents))
        await async_setup_binary_sensors(hass, entry, lambda ents: binary_sensors.extend(ents))

        # Verify all 7 sensors and 1 binary sensor exist with exact required entity_ids
        sensor_by_id = {s.entity_id: s for s in sensors}
        self.assertEqual(len(sensors), 7)
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_status"].native_value, "connected")
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_phone"].native_value, "919876543210")
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_messages_sent"].native_value, 12)
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_messages_received"].native_value, 5)
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_pending_messages"].native_value, 1)
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_failed_messages"].native_value, 0)
        self.assertEqual(
            sensor_by_id["sensor.whatsapp_default_last_message"].native_value, "Alice: STATUS"
        )

        self.assertEqual(len(binary_sensors), 1)
        bs = binary_sensors[0]
        self.assertEqual(bs.entity_id, "binary_sensor.whatsapp_default_connected")
        self.assertTrue(bs.is_on)
        self.assertEqual(bs.device_info["name"], "Lumi Whatsapp - Default Account")
        self.assertEqual(bs.device_info["manufacturer"], "Lumi Whatsapp")

        # Simulate live WebSocket incoming message event
        coordinator._handle_ws_envelope(
            {
                "type": EVENT_NEW_MESSAGE,
                "payload": {
                    "clientId": "default",
                    "messageId": "MSG_99",
                    "sender": "919988776655",
                    "senderName": "Bob",
                    "messageType": "text",
                    "text": "STATUS",
                },
            }
        )
        self.assertEqual(len(hass.bus.fired_events), 1)
        self.assertEqual(hass.bus.fired_events[0][0], EVENT_NEW_MESSAGE)
        self.assertEqual(hass.bus.fired_events[0][1]["text"], "STATUS")
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_messages_received"].native_value, 6)

        # Simulate connection update and status update events
        coordinator._handle_ws_envelope(
            {
                "type": EVENT_MESSAGE_STATUS,
                "payload": {
                    "clientId": "default",
                    "messageId": "MSG_100",
                    "status": "delivered",
                },
            }
        )
        coordinator._handle_ws_envelope(
            {
                "type": EVENT_CONNECTION_UPDATE,
                "payload": {
                    "clientId": "default",
                    "status": "reconnecting",
                },
            }
        )
        self.assertFalse(bs.is_on)
        self.assertEqual(sensor_by_id["sensor.whatsapp_default_status"].native_value, "reconnecting")

    async def test_all_12_services_and_validation(self) -> None:
        """Test all 12 native Home Assistant services and schema validation."""
        hass = HomeAssistant()
        entry = ConfigEntry(
            entry_id="entry_svc",
            title="WhatsApp",
            data={CONF_URL: "http://local-whatsapp:8099", CONF_API_KEY: "secret_token"},
        )

        mock_client = WhatsAppAddonApiClient("http://local-whatsapp:8099", "secret_token")
        mock_client.send_message = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.send_image = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.send_video = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.send_document = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.send_audio = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.send_location = AsyncMock(return_value={"ok": True, "message": {"status": "sent"}})
        mock_client.get_contacts = AsyncMock(return_value={"ok": True, "contacts": []})
        mock_client.get_groups = AsyncMock(return_value={"ok": True, "groups": []})
        mock_client.check_number = AsyncMock(return_value={"ok": True, "exists": True})
        mock_client.disconnect_account = AsyncMock(return_value={"ok": True})
        mock_client.connect_account = AsyncMock(return_value={"ok": True})
        mock_client.send_message_to_group = AsyncMock(return_value={"ok": True})

        coordinator = WhatsAppDataUpdateCoordinator(hass, entry, mock_client)
        coordinator.data = {"default": SAMPLE_ACCOUNTS[0]}
        hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

        await async_register_services(hass)

        for svc in ALL_SERVICES:
            self.assertTrue(hass.services.has_service(DOMAIN, svc), f"Missing service: {svc}")

        # 1. whatsapp.send_message
        await hass.services.async_call(
            DOMAIN,
            "send_message",
            {"clientId": "default", "to": "919876543210", "body": {"text": "Hello from Home Assistant"}},
        )
        mock_client.send_message.assert_awaited_once_with(
            client_id="default", to="919876543210", body={"text": "Hello from Home Assistant"}
        )

        # 2. whatsapp.send_image (CCTV snapshot)
        await hass.services.async_call(
            DOMAIN,
            "send_image",
            {
                "clientId": "default",
                "to": "919876543210",
                "image": "/config/www/snapshots/cctv.jpg",
                "caption": "Motion detected at entrance!",
            },
        )
        mock_client.send_image.assert_awaited_once()

        # 3-12. Remaining 10 services
        await hass.services.async_call(
            DOMAIN, "send_video", {"to": "919876543210", "video": "/media/clip.mp4"}
        )
        await hass.services.async_call(
            DOMAIN, "send_document", {"to": "919876543210", "document": "/share/report.pdf"}
        )
        await hass.services.async_call(
            DOMAIN, "send_audio", {"to": "919876543210", "audio": "/media/alert.ogg", "ptt": True}
        )
        await hass.services.async_call(
            DOMAIN,
            "send_location",
            {"to": "919876543210", "latitude": 28.6139, "longitude": 77.2090},
        )
        await hass.services.async_call(DOMAIN, "get_contacts", {"clientId": "default"})
        await hass.services.async_call(DOMAIN, "get_groups", {"clientId": "default"})
        await hass.services.async_call(
            DOMAIN, "check_number", {"clientId": "default", "number": "919876543210"}
        )
        await hass.services.async_call(DOMAIN, "disconnect", {"clientId": "default"})
        await hass.services.async_call(DOMAIN, "reconnect", {"clientId": "default"})
        await hass.services.async_call(
            DOMAIN,
            "send_message_to_group",
            {
                "clientId": "default",
                "groupId": "1203630123456@g.us",
                "body": {"text": "Group alert"},
            },
        )

        # Validation error on empty message body
        with self.assertRaises(vol.Invalid):
            await hass.services.async_call(
                DOMAIN,
                "send_message",
                {"clientId": "default", "to": "919876543210", "body": {"text": "   "}},
            )

        # API error fires whatsapp_send_message_result with status=failed and raises HomeAssistantError
        mock_client.send_message.side_effect = WhatsAppApiError("Failed to upload", code="UPLOAD_ERR")
        with self.assertRaises(HomeAssistantError):
            await hass.services.async_call(
                DOMAIN,
                "send_message",
                {"clientId": "default", "to": "919876543210", "body": {"text": "Test failure"}},
            )
        self.assertEqual(hass.bus.fired_events[-1][0], EVENT_SEND_MESSAGE_RESULT)
        self.assertEqual(hass.bus.fired_events[-1][1]["status"], "failed")

    async def test_diagnostics_redaction(self) -> None:
        """Verify diagnostics redact API keys, phone numbers, JIDs, and private messages."""
        hass = HomeAssistant()
        entry = ConfigEntry(
            entry_id="entry_diag",
            title="WhatsApp",
            data={CONF_URL: "http://local-whatsapp:8099", CONF_API_KEY: "super_secret_key_999"},
        )
        mock_client = WhatsAppAddonApiClient("http://local-whatsapp:8099", "super_secret_key_999")
        mock_client.get_diagnostics = AsyncMock(
            return_value={"health": {"status": "ok"}, "qrDataUrl": "secret_qr"}
        )

        coordinator = WhatsAppDataUpdateCoordinator(hass, entry, mock_client)
        coordinator.data = {"default": SAMPLE_ACCOUNTS[0]}
        hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

        diag = await async_get_config_entry_diagnostics(hass, entry)
        serialized = json.dumps(diag)
        self.assertNotIn("super_secret_key_999", serialized)
        self.assertNotIn("919876543210", serialized)
        self.assertNotIn("Alice: STATUS", serialized)
        self.assertNotIn("secret_qr", serialized)


if __name__ == "__main__":
    unittest.main()
