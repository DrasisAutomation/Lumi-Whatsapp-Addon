"""Config flow for the Home Assistant WhatsApp integration."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    WhatsAppAddonApiClient,
    WhatsAppApiError,
    WhatsAppAuthError,
    WhatsAppConnectionError,
)
from .const import (
    CONF_API_KEY,
    CONF_URL,
    CONF_VERIFY_SSL,
    DEFAULT_ADDON_URL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


async def validate_addon_connection(
    hass: Any,
    url: str,
    api_key: str,
    verify_ssl: bool = True,
) -> dict[str, Any]:
    """Validate that the add-on is reachable and the Bearer token is accepted.

    If the specified URL fails with a connection error, attempt common host network
    fallbacks (127.0.0.1, localhost) to resolve Docker/Supervisor internal DNS mismatches.
    """
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)

    candidates: list[str] = [url]
    try:
        parsed = urlparse(url)
        port = parsed.port or 8653
        scheme = parsed.scheme or "http"
        for fb in (f"{scheme}://127.0.0.1:{port}", f"{scheme}://localhost:{port}"):
            if fb not in candidates:
                candidates.append(fb)
    except Exception:
        pass

    last_error: Exception | None = None
    for candidate in candidates:
        client = WhatsAppAddonApiClient(
            base_url=candidate,
            api_key=api_key,
            session=session,
            verify_ssl=verify_ssl,
            timeout=5,
        )
        try:
            health = await client.get_health()
            accounts = await client.get_accounts()
            _LOGGER.info("Lumi Whatsapp Add-on successfully validated at %s", candidate)
            return {
                "title": "Lumi Whatsapp",
                "version": health.get("version", "1.0.8"),
                "accounts_count": len(accounts),
                "working_url": candidate,
            }
        except WhatsAppAuthError:
            # Reached the add-on, but token was rejected — do not try other URLs
            raise
        except (WhatsAppConnectionError, WhatsAppApiError) as err:
            last_error = err
            _LOGGER.debug("Failed connecting to candidate %s: %s", candidate, err)
            continue
        except Exception as err:
            last_error = err
            continue

    if last_error:
        raise last_error
    raise WhatsAppConnectionError(f"Could not connect to WhatsApp Add-on at {url}")


class WhatsAppConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Lumi Whatsapp."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered_url: str | None = None
        self._discovered_name: str = "Lumi Whatsapp"

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step where the user configures the add-on URL and API key."""
        errors: dict[str, str] = {}

        if user_input is not None:
            url = str(user_input[CONF_URL]).strip().rstrip("/")
            api_key = str(user_input[CONF_API_KEY]).strip()
            verify_ssl = bool(user_input.get(CONF_VERIFY_SSL, True))

            if not api_key:
                errors["base"] = "invalid_auth"
            else:
                try:
                    info = await validate_addon_connection(
                        self.hass, url, api_key, verify_ssl
                    )
                except WhatsAppAuthError:
                    errors["base"] = "invalid_auth"
                except (WhatsAppConnectionError, WhatsAppApiError):
                    errors["base"] = "cannot_connect"
                except Exception:
                    errors["base"] = "unknown"
                else:
                    working_url = info.get("working_url", url)
                    await self.async_set_unique_id(f"{DOMAIN}_{working_url}")
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=info.get("title", "Lumi Whatsapp"),
                        data={
                            CONF_URL: working_url,
                            CONF_API_KEY: api_key,
                            CONF_VERIFY_SSL: verify_ssl,
                        },
                    )

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_URL,
                    default=self._discovered_url or DEFAULT_ADDON_URL,
                ): str,
                vol.Required(CONF_API_KEY): str,
                vol.Optional(CONF_VERIFY_SSL, default=True): bool,
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
        )

    async def async_step_hassio(self, discovery_info: Any) -> FlowResult:
        """Handle Supervisor add-on discovery."""
        slug = getattr(discovery_info, "slug", None) or (
            discovery_info.get("slug") if isinstance(discovery_info, dict) else "whatsapp"
        )
        host = slug.replace("_", "-")
        self._discovered_url = f"http://{host}:8653"
        await self.async_set_unique_id(f"{DOMAIN}_{self._discovered_url}")
        self._abort_if_unique_id_configured()
        return await self.async_step_user()

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> FlowResult:
        """Handle reauthentication when the API key is rotated."""
        self._discovered_url = entry_data.get(CONF_URL, DEFAULT_ADDON_URL)
        return await self.async_step_user()

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Return the options flow handler."""
        return WhatsAppOptionsFlowHandler(config_entry)


class WhatsAppOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle updating the WhatsApp add-on URL or API token."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Manage the integration options."""
        errors: dict[str, str] = {}

        if user_input is not None:
            url = str(user_input[CONF_URL]).strip().rstrip("/")
            api_key = str(user_input[CONF_API_KEY]).strip()
            verify_ssl = bool(user_input.get(CONF_VERIFY_SSL, True))

            try:
                info = await validate_addon_connection(
                    self.hass, url, api_key, verify_ssl
                )
            except WhatsAppAuthError:
                errors["base"] = "invalid_auth"
            except (WhatsAppConnectionError, WhatsAppApiError):
                errors["base"] = "cannot_connect"
            except Exception:
                errors["base"] = "unknown"
            else:
                working_url = info.get("working_url", url)
                self.hass.config_entries.async_update_entry(
                    self._config_entry,
                    data={
                        CONF_URL: working_url,
                        CONF_API_KEY: api_key,
                        CONF_VERIFY_SSL: verify_ssl,
                    },
                )
                return self.async_create_entry(title="", data={})

        current_data = self._config_entry.data
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_URL,
                    default=current_data.get(CONF_URL, DEFAULT_ADDON_URL),
                ): str,
                vol.Required(
                    CONF_API_KEY,
                    default=current_data.get(CONF_API_KEY, ""),
                ): str,
                vol.Optional(
                    CONF_VERIFY_SSL,
                    default=current_data.get(CONF_VERIFY_SSL, True),
                ): bool,
            }
        )

        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=errors,
        )
