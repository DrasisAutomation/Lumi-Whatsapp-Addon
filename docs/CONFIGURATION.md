# Configuration Guide – HA WhatsApp

## 1. Add-on Configuration Options (`whatsapp_addon/config.yaml`)

You can configure the add-on under **Settings** &rarr; **Add-ons** &rarr; **WhatsApp** &rarr; **Configuration**:

```yaml
api_key: "your-strong-secret-bearer-token"
log_level: "info"
max_retries: 3
retry_base_delay_ms: 2000
media_max_size_mb: 25
snapshot_wait_timeout_ms: 10000
cooldown_seconds: 0
allowed_local_hosts: []
```

### Option Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `api_key` | `password` | Auto-generated | Shared Bearer token used by the HACS integration and external REST/WebSocket API callers. Stored in `/data/api_token.txt` if left empty. |
| `log_level` | `list` | `info` | Logging verbosity (`trace`, `debug`, `info`, `warn`, `error`). Sensitive tokens, keys, and message text are automatically redacted. |
| `max_retries` | `int(0,10)` | `3` | Number of automatic retries with exponential backoff when a transient error occurs while sending a message. |
| `retry_base_delay_ms` | `int(500,60000)` | `2000` | Initial delay in milliseconds before retry #1 (doubles on each subsequent attempt with jitter). |
| `media_max_size_mb` | `int(1,64)` | `25` | Maximum permitted file size in megabytes for images, videos, audio, and documents. |
| `snapshot_wait_timeout_ms` | `int(1000,30000)` | `10000` | Maximum time in milliseconds `send_image` / media actions wait for a newly created camera snapshot file to exist, become non-empty, and stabilize on disk. |
| `cooldown_seconds` | `int(0,3600)` | `0` | Global default cooldown in seconds per `(clientId, recipient, mediaSource)` to prevent duplicate motion snapshot bursts. Can also be overridden per service call via `cooldownSeconds`. |
| `allowed_local_hosts` | `list(str)` | `[]` | Whitelist of trusted LAN IP addresses or hostnames (e.g., `["192.168.1.50", "nvr.local"]`) permitted when fetching media via HTTP/HTTPS URLs. |

---

## 2. Directory Mappings & Local Media Access

The add-on maps the following Home Assistant directories in **read-only (`ro`)** mode and enforces strict canonical realpath checks:

- `/config/www` (also accessible via Home Assistant's `/local/...` alias, which is automatically translated to `/config/www/...`)
- `/media`
- `/share`

Any attempt to reference files outside those three directories (for example `/config/secrets.yaml` or `/config/www/../configuration.yaml`) is blocked with `403 PATH_TRAVERSAL_BLOCKED`.

---

## 3. HACS Integration Configuration & Reconfiguration

When adding or reconfiguring the **WhatsApp** integration under **Settings** &rarr; **Devices & services**:

- **Add-on API URL**:
  - If running Home Assistant OS / Supervised with the local add-on installed from a custom repository, use `http://local-whatsapp:8653` or the add-on's hostname displayed on the Add-on **Info** tab (e.g., `http://<repo_hash>-whatsapp:8653`), or `http://127.0.0.1:8653` if port `8653` is mapped to the host.
- **API Bearer Token**:
  - Must match the `api_key` in the add-on configuration (or the auto-generated token shown in the Add-on Web UI **Diagnostics** tab).
- **Verify SSL Certificate**:
  - Keep enabled (`true`) unless connecting to a reverse proxy with a self-signed certificate.

---

## 4. Entities Registered Per WhatsApp Account

For each account configured in the add-on (for example `clientId: default`), the integration creates a dedicated Device (`WhatsApp - Default Account`) with the following entities:

| Entity ID | Type | Description |
|---|---|---|
| `binary_sensor.whatsapp_default_connected` | `binary_sensor` (`connectivity`) | `on` when the WhatsApp socket is open and authenticated; `off` otherwise |
| `sensor.whatsapp_default_status` | `sensor` | Current state (`connected`, `connecting`, `qr_ready`, `reconnecting`, `disconnected`, `logged_out`, `error`) |
| `sensor.whatsapp_default_phone` | `sensor` | Linked WhatsApp phone number (or `Unlinked`) |
| `sensor.whatsapp_default_messages_sent` | `sensor` (`total_increasing`) | Total outgoing messages confirmed by WhatsApp |
| `sensor.whatsapp_default_messages_received` | `sensor` (`total_increasing`) | Total incoming messages received |
| `sensor.whatsapp_default_pending_messages` | `sensor` (`measurement`) | Messages currently queued or sending |
| `sensor.whatsapp_default_failed_messages` | `sensor` (`total_increasing`) | Messages that failed permanently or exhausted retries |
| `sensor.whatsapp_default_last_message` | `sensor` | Preview of the most recent incoming or outgoing message activity |
