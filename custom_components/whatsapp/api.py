"""Asynchronous API client for the Home Assistant WhatsApp Add-on."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

import aiohttp

from .const import DEFAULT_TIMEOUT_SECONDS

_LOGGER = logging.getLogger(__name__)


class WhatsAppApiError(Exception):
    """Base exception for WhatsApp Add-on API errors."""

    def __init__(self, message: str, code: str = "API_ERROR", status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class WhatsAppAuthError(WhatsAppApiError):
    """Authentication error (401/403) communicating with WhatsApp Add-on."""


class WhatsAppConnectionError(WhatsAppApiError):
    """Network or connection timeout error communicating with WhatsApp Add-on."""


class WhatsAppAddonApiClient:
    """Async client for REST and WebSocket communication with the WhatsApp Add-on."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        session: aiohttp.ClientSession | None = None,
        verify_ssl: bool = True,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key.strip()
        self._session = session
        self._own_session = session is None
        self._verify_ssl = verify_ssl
        self._timeout = timeout

    @property
    def base_url(self) -> str:
        """Return normalized base URL."""
        return self._base_url

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
            self._own_session = True
        return self._session

    async def close(self) -> None:
        """Close internal session if owned by this client."""
        if self._own_session and self._session and not self._session.closed:
            await self._session.close()

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = await self._ensure_session()
        url = f"{self._base_url}/{path.lstrip('/')}"
        client_timeout = aiohttp.ClientTimeout(total=self._timeout)

        try:
            async with session.request(
                method,
                url,
                headers=self._headers(),
                json=payload,
                params=params,
                ssl=self._verify_ssl if url.startswith("https:") else False,
                timeout=client_timeout,
            ) as response:
                try:
                    data = await response.json()
                except Exception:
                    data = {}

                if response.status in (401, 403):
                    err_info = data.get("error", {}) if isinstance(data, dict) else {}
                    raise WhatsAppAuthError(
                        err_info.get("message", "Invalid API token or unauthorized request"),
                        code=err_info.get("code", "UNAUTHORIZED"),
                        status=response.status,
                    )

                if response.status >= 400 or (isinstance(data, dict) and data.get("ok") is False):
                    err_info = data.get("error", {}) if isinstance(data, dict) else {}
                    raise WhatsAppApiError(
                        err_info.get("message", f"Add-on API returned HTTP {response.status}"),
                        code=err_info.get("code", "API_ERROR"),
                        status=response.status,
                    )

                return data if isinstance(data, dict) else {"ok": True, "data": data}
        except (WhatsAppAuthError, WhatsAppApiError):
            raise
        except asyncio.TimeoutError as err:
            raise WhatsAppConnectionError(
                f"Request to WhatsApp add-on timed out ({url})",
                code="TIMEOUT",
                status=408,
            ) from err
        except aiohttp.ClientError as err:
            raise WhatsAppConnectionError(
                f"Cannot connect to WhatsApp add-on at {self._base_url}: {err}",
                code="CONNECTION_ERROR",
                status=503,
            ) from err

    async def get_health(self) -> dict[str, Any]:
        """Fetch add-on health summary."""
        return await self._request("GET", "/api/health")

    async def get_accounts(self) -> list[dict[str, Any]]:
        """Fetch all configured WhatsApp accounts."""
        res = await self._request("GET", "/api/accounts")
        return list(res.get("accounts", []))

    async def get_account(self, client_id: str) -> dict[str, Any]:
        """Fetch status for a specific WhatsApp account."""
        res = await self._request("GET", f"/api/accounts/{client_id}")
        return dict(res.get("account", {}))

    async def connect_account(self, client_id: str, regenerate_qr: bool = False) -> dict[str, Any]:
        """Connect or reconnect a WhatsApp account."""
        return await self._request(
            "POST",
            f"/api/accounts/{client_id}/connect",
            payload={"regenerateQr": regenerate_qr},
        )

    async def disconnect_account(self, client_id: str) -> dict[str, Any]:
        """Disconnect a WhatsApp account without deleting its session."""
        return await self._request("POST", f"/api/accounts/{client_id}/disconnect", payload={})

    async def send_message(
        self,
        client_id: str,
        to: str,
        body: dict[str, Any] | str,
    ) -> dict[str, Any]:
        """Send a text message."""
        normalized_body = body if isinstance(body, dict) else {"text": str(body)}
        return await self._request(
            "POST",
            "/api/messages/send",
            payload={"clientId": client_id, "to": to, "body": normalized_body},
        )

    async def send_image(
        self,
        client_id: str,
        to: str,
        image: str,
        caption: str = "",
        cooldown_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Send an image or CCTV snapshot."""
        payload: dict[str, Any] = {
            "clientId": client_id,
            "to": to,
            "image": image,
            "caption": caption,
        }
        if cooldown_seconds is not None:
            payload["cooldownSeconds"] = cooldown_seconds
        return await self._request("POST", "/api/messages/send-image", payload=payload)

    async def send_video(
        self,
        client_id: str,
        to: str,
        video: str,
        caption: str = "",
    ) -> dict[str, Any]:
        """Send an MP4 video."""
        return await self._request(
            "POST",
            "/api/messages/send-video",
            payload={"clientId": client_id, "to": to, "video": video, "caption": caption},
        )

    async def send_document(
        self,
        client_id: str,
        to: str,
        document: str,
        caption: str = "",
        file_name: str | None = None,
    ) -> dict[str, Any]:
        """Send a document file."""
        payload: dict[str, Any] = {
            "clientId": client_id,
            "to": to,
            "document": document,
            "caption": caption,
        }
        if file_name:
            payload["fileName"] = file_name
        return await self._request("POST", "/api/messages/send-document", payload=payload)

    async def send_audio(
        self,
        client_id: str,
        to: str,
        audio: str,
        ptt: bool = False,
    ) -> dict[str, Any]:
        """Send an audio file or voice note."""
        return await self._request(
            "POST",
            "/api/messages/send-audio",
            payload={"clientId": client_id, "to": to, "audio": audio, "ptt": ptt},
        )

    async def send_location(
        self,
        client_id: str,
        to: str,
        latitude: float,
        longitude: float,
        name: str | None = None,
        address: str | None = None,
    ) -> dict[str, Any]:
        """Send a location pin."""
        return await self._request(
            "POST",
            "/api/messages/send-location",
            payload={
                "clientId": client_id,
                "to": to,
                "latitude": latitude,
                "longitude": longitude,
                "name": name,
                "address": address,
            },
        )

    async def send_message_to_group(
        self,
        client_id: str,
        group_id: str,
        body: dict[str, Any] | str,
    ) -> dict[str, Any]:
        """Send a text message to a WhatsApp group."""
        normalized_body = body if isinstance(body, dict) else {"text": str(body)}
        return await self._request(
            "POST",
            "/api/messages/send-group",
            payload={"clientId": client_id, "groupId": group_id, "body": normalized_body},
        )

    async def get_contacts(self, client_id: str = "default") -> dict[str, Any]:
        """Retrieve known contacts for an account."""
        return await self._request("GET", "/api/contacts", params={"clientId": client_id})

    async def get_groups(self, client_id: str = "default") -> dict[str, Any]:
        """Retrieve joined WhatsApp groups for an account."""
        return await self._request("GET", "/api/groups", params={"clientId": client_id})

    async def check_number(self, client_id: str, number: str) -> dict[str, Any]:
        """Check if a phone number is registered on WhatsApp."""
        return await self._request(
            "POST",
            "/api/contacts/check",
            payload={"clientId": client_id, "number": number},
        )

    async def get_diagnostics(self) -> dict[str, Any]:
        """Fetch sanitized diagnostics from the add-on."""
        return await self._request("GET", "/api/diagnostics")

    def build_ws_url(self) -> str:
        """Convert HTTP/HTTPS base URL to WS/WSS URL."""
        parsed = urlparse(self._base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = f"{parsed.path.rstrip('/')}/ws"
        return urlunparse((scheme, parsed.netloc, path, "", "", ""))

    async def listen_websocket(
        self,
        on_event: Callable[[dict[str, Any]], None],
        stop_event: asyncio.Event,
        reconnect_delay: float = 3.0,
    ) -> None:
        """Maintain a persistent WebSocket connection to the add-on with automatic reconnection."""
        ws_url = self.build_ws_url()
        backoff = reconnect_delay

        while not stop_event.is_set():
            session = await self._ensure_session()
            try:
                async with session.ws_connect(
                    ws_url,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    heartbeat=25.0,
                    ssl=self._verify_ssl if ws_url.startswith("wss:") else False,
                ) as ws:
                    backoff = reconnect_delay
                    _LOGGER.debug("Connected to WhatsApp add-on WebSocket stream at %s", ws_url)
                    async for msg in ws:
                        if stop_event.is_set():
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                envelope = json.loads(msg.data)
                                if isinstance(envelope, dict):
                                    on_event(envelope)
                            except Exception as parse_err:
                                _LOGGER.debug("Ignored invalid WS payload: %s", parse_err)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except asyncio.CancelledError:
                break
            except Exception as err:
                if stop_event.is_set():
                    break
                _LOGGER.debug(
                    "WhatsApp add-on WebSocket disconnected (%s); reconnecting in %.1fs",
                    err,
                    backoff,
                )
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)
