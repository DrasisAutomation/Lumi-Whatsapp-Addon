"""Constants for the Home Assistant WhatsApp integration."""

from __future__ import annotations

DOMAIN = "whatsapp"
PLATFORMS = ["sensor", "binary_sensor"]

CONF_URL = "url"
CONF_API_KEY = "api_key"
CONF_VERIFY_SSL = "verify_ssl"

DEFAULT_ADDON_URL = "http://127.0.0.1:8653"
DEFAULT_TIMEOUT_SECONDS = 30
UPDATE_INTERVAL_SECONDS = 30

# Home Assistant Event Bus Event Names
EVENT_NEW_MESSAGE = "new_whatsapp_message"
EVENT_MESSAGE_SENT = "whatsapp_message_sent"
EVENT_MESSAGE_STATUS = "whatsapp_message_status"
EVENT_SEND_MESSAGE_RESULT = "whatsapp_send_message_result"
EVENT_CONNECTION_UPDATE = "whatsapp_connection_update"

# Service / Action Names
SERVICE_SEND_MESSAGE = "send_message"
SERVICE_SEND_IMAGE = "send_image"
SERVICE_SEND_VIDEO = "send_video"
SERVICE_SEND_DOCUMENT = "send_document"
SERVICE_SEND_AUDIO = "send_audio"
SERVICE_SEND_LOCATION = "send_location"
SERVICE_GET_CONTACTS = "get_contacts"
SERVICE_GET_GROUPS = "get_groups"
SERVICE_CHECK_NUMBER = "check_number"
SERVICE_DISCONNECT = "disconnect"
SERVICE_RECONNECT = "reconnect"
SERVICE_SEND_MESSAGE_TO_GROUP = "send_message_to_group"

ALL_SERVICES = [
    SERVICE_SEND_MESSAGE,
    SERVICE_SEND_IMAGE,
    SERVICE_SEND_VIDEO,
    SERVICE_SEND_DOCUMENT,
    SERVICE_SEND_AUDIO,
    SERVICE_SEND_LOCATION,
    SERVICE_GET_CONTACTS,
    SERVICE_GET_GROUPS,
    SERVICE_CHECK_NUMBER,
    SERVICE_DISCONNECT,
    SERVICE_RECONNECT,
    SERVICE_SEND_MESSAGE_TO_GROUP,
]

# Service Field Constants
ATTR_CLIENT_ID = "clientId"
ATTR_TO = "to"
ATTR_BODY = "body"
ATTR_IMAGE = "image"
ATTR_VIDEO = "video"
ATTR_DOCUMENT = "document"
ATTR_AUDIO = "audio"
ATTR_CAPTION = "caption"
ATTR_FILENAME = "fileName"
ATTR_PTT = "ptt"
ATTR_LATITUDE = "latitude"
ATTR_LONGITUDE = "longitude"
ATTR_NAME = "name"
ATTR_ADDRESS = "address"
ATTR_GROUP_ID = "groupId"
ATTR_NUMBER = "number"
ATTR_COOLDOWN_SECONDS = "cooldownSeconds"
