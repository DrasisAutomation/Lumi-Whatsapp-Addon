# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-11-04

### Fixed
- Regenerated clean `package-lock.json` resolving 404 error on `side-channel-weakmap`.
- Added resilient fallback `npm install` in `Dockerfile` for Home Assistant Supervisor builds.

## [1.0.3] - 2026-11-04

### Fixed
- Converted Baileys imports to dynamic ESM import (`src/whatsapp/baileys.js`) to support Node 20+ runtime.
- Removed duplicate s6 service script to prevent duplicate process spawn.

## [1.0.2] - 2026-11-04

### Changed
- Configured default port to `8653` across add-on and integration to avoid port conflicts.

## [1.0.1] - 2026-11-04

### Added
- Official Lumi Whatsapp brand identity and logo assets across add-on, Ingress UI, and HACS integration.

## [1.0.0] - 2026-11-04

### Added
- **Milestone 1 (Architecture & Repository Structure)**:
  - Monorepo configuration supporting both Home Assistant Add-on Store (`repository.yaml`) and HACS Custom Integration (`hacs.json`).
  - System architecture specification (`docs/ARCHITECTURE.md`) and security-hardened `.gitignore`.
- **Milestone 2 (Home Assistant Add-on & Docker Build)**:
  - `whatsapp_addon/config.yaml`, `build.yaml`, `Dockerfile`, `run.sh`, and s6 service scripts supporting `amd64` and `aarch64` with Ingress on port `8653`.
  - Structured redacted logging (`pino`), input validation, and health endpoint (`GET /api/health`).
- **Milestone 3 (WhatsApp QR Pairing & Persistent Sessions)**:
  - Multi-account `@whiskeysockets/baileys` engine (`connection.js`, `session-manager.js`) with crash-safe atomic write-then-rename credential storage (`useAtomicMultiFileAuthState`) and `creds.json.bak` backup.
  - Responsive Home Assistant-themed Ingress Web UI (`whatsapp_addon/frontend/`) with Dashboard, Accounts & QR Pairing, Messaging, Message History, and Diagnostics tabs.
- **Milestone 4 (Text Messaging & Persistent Queue)**:
  - Per-account sequential persistent message queue (`queue.js`) with exponential backoff, idempotency protection, message expiry, and restart recovery that never resends already-submitted messages.
- **Milestone 5 (Image, CCTV Snapshot & Media Messaging)**:
  - `MediaManager` (`media-manager.js`) supporting local files under `/config/www`, `/media`, `/share` with canonical realpath traversal protection, `waitForFileReady` polling for fresh `camera.snapshot` files, magic-byte MIME verification (JPEG, PNG, WebP, MP4, PDF, Ogg, MP3, WAV), SSRF-protected remote URL downloads, and per-recipient alert cooldowns.
- **Milestone 6 (HACS Custom Integration)**:
  - Async Python integration (`custom_components/whatsapp/`) with `manifest.json`, `config_flow.py` (user setup, Supervisor `hassio` discovery, options flow), `api.py` (async REST + auto-reconnecting WebSocket client), and `coordinator.py`.
- **Milestone 7 (Home Assistant Devices, Entities & 12 Native Actions)**:
  - Per-account Device registration (`WhatsApp - <Account Name>`), 7 Sensors (`status`, `phone`, `messages_sent`, `messages_received`, `pending_messages`, `failed_messages`, `last_message`), and 1 Binary Sensor (`connected`).
  - All 12 `whatsapp.*` actions (`send_message`, `send_image`, `send_video`, `send_document`, `send_audio`, `send_location`, `get_contacts`, `get_groups`, `check_number`, `disconnect`, `reconnect`, `send_message_to_group`) with `services.yaml` UI selectors.
- **Milestone 8 (Automations, Incoming Messages & Receipt Events)**:
  - Native Home Assistant events (`new_whatsapp_message`, `whatsapp_message_sent`, `whatsapp_message_status`, `whatsapp_send_message_result`, `whatsapp_connection_update`) with outgoing `fromMe` filtering and receipt deduplication.
- **Milestone 9 (Reliability, Security & Diagnostics)**:
  - Constant-time Bearer token authentication, Supervisor Ingress IP verification, rate limiting, and secret-redacted diagnostics (`diagnostics.py` and `GET /api/diagnostics`).
- **Milestone 10 (CI/CD Workflows & Complete Documentation)**:
  - GitHub Actions workflows (`build-addon.yml`, `validate-integration.yml`, `release.yml`) for automated Node.js + Python testing and multi-arch GHCR image publishing.
  - Complete documentation suite (`INSTALLATION.md`, `CONFIGURATION.md`, `SERVICES.md`, `AUTOMATIONS.md`, `TROUBLESHOOTING.md`, `SECURITY.md`).
