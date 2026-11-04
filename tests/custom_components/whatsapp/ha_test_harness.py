"""Lightweight Home Assistant Core & dependency test harness for testing custom_components/whatsapp."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum
import sys
import types
from typing import Any, Callable


def install_homeassistant_Test_shims() -> None:
    """Install minimal, accurate Home Assistant and voluptuous/aiohttp shims if not installed."""

    # 1. Voluptuous shim if not installed
    if "voluptuous" not in sys.modules:
        vol_mod = types.ModuleType("voluptuous")

        class Invalid(Exception):
            pass

        class Marker:
            def __init__(self, key: Any, default: Any = None) -> None:
                self.key = key
                self.default = default

        class Required(Marker):
            pass

        class Optional(Marker):
            pass

        def Coerce(target_type: type) -> Callable[[Any], Any]:
            def _coerce(val: Any) -> Any:
                try:
                    return target_type(val)
                except Exception as err:
                    raise Invalid(str(err)) from err

            return _coerce

        def Range(min: float | None = None, max: float | None = None) -> Callable[[Any], Any]:
            def _range(val: Any) -> Any:
                if min is not None and val < min:
                    raise Invalid(f"Value {val} < {min}")
                if max is not None and val > max:
                    raise Invalid(f"Value {val} > {max}")
                return val

            return _range

        def All(*validators: Callable[[Any], Any]) -> Callable[[Any], Any]:
            def _all(val: Any) -> Any:
                res = val
                for v in validators:
                    res = v(res) if callable(v) else res
                return res

            return _all

        class Schema:
            def __init__(self, schema_dict: dict[Any, Any]) -> None:
                self.schema = schema_dict

            def __call__(self, data: dict[str, Any]) -> dict[str, Any]:
                if not isinstance(data, dict):
                    raise Invalid("Expected dict")
                out: dict[str, Any] = dict(data)
                for marker, validator in self.schema.items():
                    if isinstance(marker, Required):
                        if marker.key not in out:
                            if marker.default is not None:
                                out[marker.key] = marker.default
                            else:
                                raise Invalid(f"Missing required field: {marker.key}")
                        val = out[marker.key]
                        out[marker.key] = self._validate_val(validator, val)
                    elif isinstance(marker, Optional):
                        if marker.key not in out:
                            if marker.default is not None:
                                out[marker.key] = marker.default
                        else:
                            out[marker.key] = self._validate_val(validator, out[marker.key])
                    else:
                        if marker in out:
                            out[marker] = self._validate_val(validator, out[marker])
                return out

            @staticmethod
            def _validate_val(validator: Any, val: Any) -> Any:
                if isinstance(validator, type):
                    if not isinstance(val, validator):
                        raise Invalid(f"Expected {validator.__name__}")
                    return val
                if callable(validator):
                    return validator(val)
                return val

        vol_mod.Invalid = Invalid
        vol_mod.Required = Required
        vol_mod.Optional = Optional
        vol_mod.Coerce = Coerce
        vol_mod.Range = Range
        vol_mod.All = All
        vol_mod.Schema = Schema
        sys.modules["voluptuous"] = vol_mod

    # 2. aiohttp shim if not installed
    if "aiohttp" not in sys.modules:
        aio_mod = types.ModuleType("aiohttp")

        class ClientError(Exception):
            pass

        class ClientTimeout:
            def __init__(self, total: float = 30.0) -> None:
                self.total = total

        class WSMsgType(Enum):
            TEXT = 1
            CLOSED = 2
            ERROR = 3

        class ClientSession:
            def __init__(self) -> None:
                self.closed = False

            async def close(self) -> None:
                self.closed = True

        aio_mod.ClientError = ClientError
        aio_mod.ClientTimeout = ClientTimeout
        aio_mod.WSMsgType = WSMsgType
        aio_mod.ClientSession = ClientSession
        sys.modules["aiohttp"] = aio_mod

    # 3. Home Assistant core & helpers shims
    if "homeassistant" in sys.modules:
        return

    ha_mod = types.ModuleType("homeassistant")
    ha_core = types.ModuleType("homeassistant.core")
    ha_ce = types.ModuleType("homeassistant.config_entries")
    ha_def = types.ModuleType("homeassistant.data_entry_flow")
    ha_exc = types.ModuleType("homeassistant.exceptions")
    ha_helpers = types.ModuleType("homeassistant.helpers")
    ha_aio = types.ModuleType("homeassistant.helpers.aiohttp_client")
    ha_uc = types.ModuleType("homeassistant.helpers.update_coordinator")
    ha_dr = types.ModuleType("homeassistant.helpers.device_registry")
    ha_ep = types.ModuleType("homeassistant.helpers.entity_platform")
    ha_comp = types.ModuleType("homeassistant.components")
    ha_sensor = types.ModuleType("homeassistant.components.sensor")
    ha_bsensor = types.ModuleType("homeassistant.components.binary_sensor")
    ha_diag = types.ModuleType("homeassistant.components.diagnostics")

    class HomeAssistantError(Exception):
        pass

    class ServiceValidationError(HomeAssistantError):
        pass

    class ConfigEntryAuthFailed(HomeAssistantError):
        pass

    class UpdateFailed(HomeAssistantError):
        pass

    ha_exc.HomeAssistantError = HomeAssistantError
    ha_exc.ServiceValidationError = ServiceValidationError
    ha_exc.ConfigEntryAuthFailed = ConfigEntryAuthFailed

    class SupportsResponse(Enum):
        NONE = "none"
        OPTIONAL = "optional"
        ONLY = "only"

    @dataclass
    class ServiceCall:
        domain: str
        service: str
        data: dict[str, Any]

    class EventBus:
        def __init__(self) -> None:
            self.fired_events: list[tuple[str, dict[str, Any]]] = []

        def async_fire(self, event_type: str, event_data: dict[str, Any] | None = None) -> None:
            self.fired_events.append((event_type, dict(event_data or {})))

    class ServiceRegistry:
        def __init__(self) -> None:
            self._services: dict[tuple[str, str], dict[str, Any]] = {}

        def has_service(self, domain: str, service: str) -> bool:
            return (domain, service) in self._services

        def async_register(
            self,
            domain: str,
            service: str,
            service_func: Callable[..., Any],
            schema: Any = None,
            supports_response: Any = SupportsResponse.NONE,
        ) -> None:
            self._services[(domain, service)] = {
                "handler": service_func,
                "schema": schema,
                "supports_response": supports_response,
            }

        def async_remove(self, domain: str, service: str) -> None:
            self._services.pop((domain, service), None)

        async def async_call(
            self, domain: str, service: str, service_data: dict[str, Any]
        ) -> Any:
            reg = self._services[(domain, service)]
            validated = reg["schema"](service_data) if reg["schema"] else service_data
            call = ServiceCall(domain=domain, service=service, data=validated)
            return await reg["handler"](call)

    class ConfigEntriesManager:
        def __init__(self, hass: HomeAssistant) -> None:
            self.hass = hass
            self.forwarded_platforms: list[str] = []

        async def async_forward_entry_setups(
            self, entry: Any, platforms: list[str]
        ) -> None:
            self.forwarded_platforms.extend(platforms)

        async def async_unload_platforms(
            self, entry: Any, platforms: list[str]
        ) -> bool:
            return True

        def async_update_entry(self, entry: Any, data: dict[str, Any] | None = None) -> None:
            if data is not None:
                entry.data = data

    class HomeAssistant:
        def __init__(self) -> None:
            self.data: dict[str, Any] = {}
            self.bus = EventBus()
            self.services = ServiceRegistry()
            self.config_entries = ConfigEntriesManager(self)
            self._bg_tasks: list[asyncio.Task[Any]] = []

        def async_create_background_task(
            self, coro: Any, name: str | None = None
        ) -> asyncio.Task[Any]:
            task = asyncio.create_task(coro, name=name)
            self._bg_tasks.append(task)
            return task

        def async_create_task(self, coro: Any) -> asyncio.Task[Any]:
            return asyncio.create_task(coro)

    def callback(func: Callable[..., Any]) -> Callable[..., Any]:
        return func

    ha_core.HomeAssistant = HomeAssistant
    ha_core.ServiceCall = ServiceCall
    ha_core.ServiceResponse = dict[str, Any] | None
    ha_core.SupportsResponse = SupportsResponse
    ha_core.callback = callback

    class ConfigEntry:
        def __init__(
            self,
            entry_id: str = "test_entry_1",
            title: str = "WhatsApp",
            data: dict[str, Any] | None = None,
        ) -> None:
            self.entry_id = entry_id
            self.title = title
            self.data = data or {}

    class ConfigFlow:
        def __init_subclass__(cls, domain: str | None = None, **kwargs: Any) -> None:
            super().__init_subclass__(**kwargs)
            cls.domain = domain

        def __init__(self) -> None:
            self.hass: Any = None
            self._unique_id: str | None = None

        async def async_set_unique_id(self, unique_id: str) -> None:
            self._unique_id = unique_id

        def _abort_if_unique_id_configured(self) -> None:
            pass

        def async_create_entry(self, title: str, data: dict[str, Any]) -> dict[str, Any]:
            return {"type": "create_entry", "title": title, "data": data}

        def async_show_form(
            self,
            step_id: str,
            data_schema: Any = None,
            errors: dict[str, str] | None = None,
        ) -> dict[str, Any]:
            return {
                "type": "form",
                "step_id": step_id,
                "data_schema": data_schema,
                "errors": errors or {},
            }

    class OptionsFlow(ConfigFlow):
        pass

    ha_ce.ConfigEntry = ConfigEntry
    ha_ce.ConfigFlow = ConfigFlow
    ha_ce.OptionsFlow = OptionsFlow
    ha_def.FlowResult = dict[str, Any]

    def async_get_clientsession(hass: Any, verify_ssl: bool = True) -> Any:
        return sys.modules["aiohttp"].ClientSession()

    ha_aio.async_get_clientsession = async_get_clientsession

    class DataUpdateCoordinator:
        def __class_getitem__(cls, item: Any) -> Any:
            return cls

        def __init__(
            self,
            hass: HomeAssistant,
            logger: Any,
            name: str,
            update_interval: Any = None,
        ) -> None:
            self.hass = hass
            self.logger = logger
            self.name = name
            self.update_interval = update_interval
            self.data: Any = None
            self._listeners: list[Callable[[], None]] = []

        async def async_config_entry_first_refresh(self) -> None:
            self.data = await self._async_update_data()

        async def async_request_refresh(self) -> None:
            self.data = await self._async_update_data()

        def async_set_updated_data(self, data: Any) -> None:
            self.data = data
            for listener in list(self._listeners):
                listener()

        def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
            self._listeners.append(listener)
            return lambda: self._listeners.remove(listener)

    class CoordinatorEntity:
        def __class_getitem__(cls, item: Any) -> Any:
            return cls

        def __init__(self, coordinator: DataUpdateCoordinator) -> None:
            self.coordinator = coordinator

    ha_uc.DataUpdateCoordinator = DataUpdateCoordinator
    ha_uc.CoordinatorEntity = CoordinatorEntity
    ha_uc.UpdateFailed = UpdateFailed

    class DeviceInfo(dict):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)

    ha_dr.DeviceInfo = DeviceInfo
    ha_ep.AddEntitiesCallback = Callable[[list[Any]], None]

    class SensorStateClass(Enum):
        MEASUREMENT = "measurement"
        TOTAL_INCREASING = "total_increasing"

    @dataclass(frozen=True, kw_only=True)
    class SensorEntityDescription:
        key: str
        name: str | None = None
        icon: str | None = None
        state_class: SensorStateClass | None = None

    class SensorEntity:
        pass

    ha_sensor.SensorStateClass = SensorStateClass
    ha_sensor.SensorEntityDescription = SensorEntityDescription
    ha_sensor.SensorEntity = SensorEntity

    class BinarySensorDeviceClass(Enum):
        CONNECTIVITY = "connectivity"

    class BinarySensorEntity:
        pass

    ha_bsensor.BinarySensorDeviceClass = BinarySensorDeviceClass
    ha_bsensor.BinarySensorEntity = BinarySensorEntity

    def async_redact_data(data: Any, to_redact: set[str]) -> Any:
        if isinstance(data, dict):
            out = {}
            for k, v in data.items():
                if k in to_redact:
                    out[k] = "**REDACTED**"
                else:
                    out[k] = async_redact_data(v, to_redact)
            return out
        if isinstance(data, list):
            return [async_redact_data(i, to_redact) for i in data]
        return data

    ha_diag.async_redact_data = async_redact_data

    ha_mod.core = ha_core
    ha_mod.config_entries = ha_ce
    ha_mod.data_entry_flow = ha_def
    ha_mod.exceptions = ha_exc
    ha_mod.helpers = ha_helpers
    ha_mod.components = ha_comp

    sys.modules["homeassistant"] = ha_mod
    sys.modules["homeassistant.core"] = ha_core
    sys.modules["homeassistant.config_entries"] = ha_ce
    sys.modules["homeassistant.data_entry_flow"] = ha_def
    sys.modules["homeassistant.exceptions"] = ha_exc
    sys.modules["homeassistant.helpers"] = ha_helpers
    sys.modules["homeassistant.helpers.aiohttp_client"] = ha_aio
    sys.modules["homeassistant.helpers.update_coordinator"] = ha_uc
    sys.modules["homeassistant.helpers.device_registry"] = ha_dr
    sys.modules["homeassistant.helpers.entity_platform"] = ha_ep
    sys.modules["homeassistant.components"] = ha_comp
    sys.modules["homeassistant.components.sensor"] = ha_sensor
    sys.modules["homeassistant.components.binary_sensor"] = ha_bsensor
    sys.modules["homeassistant.components.diagnostics"] = ha_diag
