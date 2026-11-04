"""Native Home Assistant actions/services for WhatsApp."""

from __future__ import annotations

import logging
from typing import Any
import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError

from .api import WhatsAppApiError, WhatsAppAuthError, WhatsAppConnectionError
from .const import (
    ALL_SERVICES,
    ATTR_ADDRESS,
    ATTR_AUDIO,
    ATTR_BODY,
    ATTR_CAPTION,
    ATTR_CLIENT_ID,
    ATTR_COOLDOWN_SECONDS,
    ATTR_DOCUMENT,
    ATTR_FILENAME,
    ATTR_GROUP_ID,
    ATTR_IMAGE,
    ATTR_LATITUDE,
    ATTR_LONGITUDE,
    ATTR_NAME,
    ATTR_NUMBER,
    ATTR_PTT,
    ATTR_TO,
    ATTR_VIDEO,
    DOMAIN,
    EVENT_SEND_MESSAGE_RESULT,
    SERVICE_CHECK_NUMBER,
    SERVICE_DISCONNECT,
    SERVICE_GET_CONTACTS,
    SERVICE_GET_GROUPS,
    SERVICE_RECONNECT,
    SERVICE_SEND_AUDIO,
    SERVICE_SEND_DOCUMENT,
    SERVICE_SEND_IMAGE,
    SERVICE_SEND_LOCATION,
    SERVICE_SEND_MESSAGE,
    SERVICE_SEND_MESSAGE_TO_GROUP,
    SERVICE_SEND_VIDEO,
)
from .coordinator import WhatsAppDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)


def _validate_non_empty_str(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise vol.Invalid("Value must be a non-empty string")
    return value.strip()


def _validate_body(value: Any) -> dict[str, str]:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise vol.Invalid("Message text cannot be empty")
        return {"text": text}
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        text = value["text"].strip()
        if not text:
            raise vol.Invalid("body.text cannot be empty")
        return {"text": text}
    raise vol.Invalid("body must be a string or an object containing a non-empty 'text' field")


SCHEMA_SEND_MESSAGE = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_BODY): _validate_body,
    }
)

SCHEMA_SEND_IMAGE = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_IMAGE): _validate_non_empty_str,
        vol.Optional(ATTR_CAPTION, default=""): str,
        vol.Optional(ATTR_COOLDOWN_SECONDS): vol.All(vol.Coerce(int), vol.Range(min=0, max=3600)),
    }
)

SCHEMA_SEND_VIDEO = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_VIDEO): _validate_non_empty_str,
        vol.Optional(ATTR_CAPTION, default=""): str,
    }
)

SCHEMA_SEND_DOCUMENT = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_DOCUMENT): _validate_non_empty_str,
        vol.Optional(ATTR_CAPTION, default=""): str,
        vol.Optional(ATTR_FILENAME): _validate_non_empty_str,
    }
)

SCHEMA_SEND_AUDIO = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_AUDIO): _validate_non_empty_str,
        vol.Optional(ATTR_PTT, default=False): bool,
    }
)

SCHEMA_SEND_LOCATION = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_TO): _validate_non_empty_str,
        vol.Required(ATTR_LATITUDE): vol.All(vol.Coerce(float), vol.Range(min=-90.0, max=90.0)),
        vol.Required(ATTR_LONGITUDE): vol.All(vol.Coerce(float), vol.Range(min=-180.0, max=180.0)),
        vol.Optional(ATTR_NAME): str,
        vol.Optional(ATTR_ADDRESS): str,
    }
)

SCHEMA_ACCOUNT_ONLY = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
    }
)

SCHEMA_CHECK_NUMBER = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_NUMBER): _validate_non_empty_str,
    }
)

SCHEMA_SEND_GROUP = vol.Schema(
    {
        vol.Optional(ATTR_CLIENT_ID, default="default"): _validate_non_empty_str,
        vol.Required(ATTR_GROUP_ID): _validate_non_empty_str,
        vol.Required(ATTR_BODY): _validate_body,
    }
)


def _get_active_coordinator(hass: HomeAssistant) -> WhatsAppDataUpdateCoordinator:
    domain_data: dict[str, WhatsAppDataUpdateCoordinator] = hass.data.get(DOMAIN, {})
    for coord in domain_data.values():
        if isinstance(coord, WhatsAppDataUpdateCoordinator):
            return coord
    raise ServiceValidationError("No active WhatsApp integration instance is configured.")


async def async_register_services(hass: HomeAssistant) -> None:
    """Register all 12 native WhatsApp services under the whatsapp domain."""
    if hass.services.has_service(DOMAIN, SERVICE_SEND_MESSAGE):
        return

    async def _execute_api_action(
        call: ServiceCall,
        action_name: str,
        coro_fn: Any,
    ) -> ServiceResponse:
        coordinator = _get_active_coordinator(hass)
        client_id = call.data.get(ATTR_CLIENT_ID, "default")
        recipient = call.data.get(ATTR_TO) or call.data.get(ATTR_GROUP_ID) or call.data.get(ATTR_NUMBER)

        # Log service invocation WITHOUT logging private message contents or captions
        _LOGGER.info(
            "Executing whatsapp.%s via clientId=%s (recipient=%s)",
            action_name,
            client_id,
            recipient,
        )

        try:
            result = await coro_fn(coordinator.client)
            return result
        except (WhatsAppAuthError, WhatsAppConnectionError, WhatsAppApiError) as err:
            hass.bus.async_fire(
                EVENT_SEND_MESSAGE_RESULT,
                {
                    "clientId": client_id,
                    "recipient": recipient,
                    "action": action_name,
                    "status": "failed",
                    "error": {"code": getattr(err, "code", "API_ERROR"), "message": str(err)},
                },
            )
            raise HomeAssistantError(f"WhatsApp {action_name} failed: {err}") from err

    async def handle_send_message(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_MESSAGE,
            lambda client: client.send_message(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                body=call.data[ATTR_BODY],
            ),
        )

    async def handle_send_image(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_IMAGE,
            lambda client: client.send_image(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                image=call.data[ATTR_IMAGE],
                caption=call.data.get(ATTR_CAPTION, ""),
                cooldown_seconds=call.data.get(ATTR_COOLDOWN_SECONDS),
            ),
        )

    async def handle_send_video(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_VIDEO,
            lambda client: client.send_video(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                video=call.data[ATTR_VIDEO],
                caption=call.data.get(ATTR_CAPTION, ""),
            ),
        )

    async def handle_send_document(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_DOCUMENT,
            lambda client: client.send_document(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                document=call.data[ATTR_DOCUMENT],
                caption=call.data.get(ATTR_CAPTION, ""),
                file_name=call.data.get(ATTR_FILENAME),
            ),
        )

    async def handle_send_audio(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_AUDIO,
            lambda client: client.send_audio(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                audio=call.data[ATTR_AUDIO],
                ptt=bool(call.data.get(ATTR_PTT, False)),
            ),
        )

    async def handle_send_location(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_LOCATION,
            lambda client: client.send_location(
                client_id=call.data[ATTR_CLIENT_ID],
                to=call.data[ATTR_TO],
                latitude=call.data[ATTR_LATITUDE],
                longitude=call.data[ATTR_LONGITUDE],
                name=call.data.get(ATTR_NAME),
                address=call.data.get(ATTR_ADDRESS),
            ),
        )

    async def handle_get_contacts(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_GET_CONTACTS,
            lambda client: client.get_contacts(client_id=call.data[ATTR_CLIENT_ID]),
        )

    async def handle_get_groups(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_GET_GROUPS,
            lambda client: client.get_groups(client_id=call.data[ATTR_CLIENT_ID]),
        )

    async def handle_check_number(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_CHECK_NUMBER,
            lambda client: client.check_number(
                client_id=call.data[ATTR_CLIENT_ID],
                number=call.data[ATTR_NUMBER],
            ),
        )

    async def handle_disconnect(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_DISCONNECT,
            lambda client: client.disconnect_account(client_id=call.data[ATTR_CLIENT_ID]),
        )

    async def handle_reconnect(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_RECONNECT,
            lambda client: client.connect_account(client_id=call.data[ATTR_CLIENT_ID]),
        )

    async def handle_send_message_to_group(call: ServiceCall) -> ServiceResponse:
        return await _execute_api_action(
            call,
            SERVICE_SEND_MESSAGE_TO_GROUP,
            lambda client: client.send_message_to_group(
                client_id=call.data[ATTR_CLIENT_ID],
                group_id=call.data[ATTR_GROUP_ID],
                body=call.data[ATTR_BODY],
            ),
        )

    service_registrations = [
        (SERVICE_SEND_MESSAGE, handle_send_message, SCHEMA_SEND_MESSAGE),
        (SERVICE_SEND_IMAGE, handle_send_image, SCHEMA_SEND_IMAGE),
        (SERVICE_SEND_VIDEO, handle_send_video, SCHEMA_SEND_VIDEO),
        (SERVICE_SEND_DOCUMENT, handle_send_document, SCHEMA_SEND_DOCUMENT),
        (SERVICE_SEND_AUDIO, handle_send_audio, SCHEMA_SEND_AUDIO),
        (SERVICE_SEND_LOCATION, handle_send_location, SCHEMA_SEND_LOCATION),
        (SERVICE_GET_CONTACTS, handle_get_contacts, SCHEMA_ACCOUNT_ONLY),
        (SERVICE_GET_GROUPS, handle_get_groups, SCHEMA_ACCOUNT_ONLY),
        (SERVICE_CHECK_NUMBER, handle_check_number, SCHEMA_CHECK_NUMBER),
        (SERVICE_DISCONNECT, handle_disconnect, SCHEMA_ACCOUNT_ONLY),
        (SERVICE_RECONNECT, handle_reconnect, SCHEMA_ACCOUNT_ONLY),
        (SERVICE_SEND_MESSAGE_TO_GROUP, handle_send_message_to_group, SCHEMA_SEND_GROUP),
    ]

    for service_name, handler, schema in service_registrations:
        hass.services.async_register(
            DOMAIN,
            service_name,
            handler,
            schema=schema,
            supports_response=SupportsResponse.OPTIONAL,
        )


async def async_unregister_services(hass: HomeAssistant) -> None:
    """Unregister WhatsApp services when the last config entry is unloaded."""
    for service_name in ALL_SERVICES:
        if hass.services.has_service(DOMAIN, service_name):
            hass.services.async_remove(DOMAIN, service_name)
