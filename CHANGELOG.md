# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-11-05

### Added
- **Zoho Classic Premium UI Redesign**: Enterprise SaaS dashboard styling with modern typography, executive navy/slate surfaces, Zoho Blue interactive accents, high-contrast KPI metric cards, and responsive layout for desktop and Home Assistant mobile app.
- **Bulletproof Clipboard Engine**: Reliable two-layer copy mechanism (`navigator.clipboard` + hidden textarea `execCommand('copy')` fallback) ensuring 100% copy reliability inside Home Assistant Ingress iframes, non-HTTPS sessions, and mobile webviews.
- **Dedicated Integration Setup Hero Card**: Interactive credential box in Diagnostics tab displaying the universal loopback URL (`http://127.0.0.1:8653`), alternative URLs, API token visibility toggle, and instant one-click copy buttons with animated `✓ Copied!` visual feedback.
- **Multi-URL Automatic Fallback in Config Flow**: `validate_addon_connection` automatically probes `http://127.0.0.1:8653` and `http://localhost:8653` if the initial entered URL encounters Docker/Supervisor internal DNS resolution failure, completely eliminating the `cannot_connect` error.
- **Default Host Network URL**: Changed default add-on API URL to `http://127.0.0.1:8653`.

## [1.0.8] - 2026-11-05

### Fixed
- Fixed WhatsApp "Waiting for this message. This may take a while." placeholder error by implementing `MessageStore` and Baileys `getMessage` decryption retry callback.
- Added `msgRetryCounterCache` and `patchMessageBeforeSending` to ensure reliable multi-device E2EE decryption for media messages.
- Enhanced `MediaManager.waitForFileReady` with JPEG SOI/EOI (`0xFFD8`/`0xFFD9`) and PNG `IEND` chunk verification to guarantee camera snapshot completeness before upload.

## [1.0.7] - 2026-11-05

### Fixed
- Injected dynamic `<base href="...">` tag into served `index.html` matching `X-Ingress-Path` to guarantee all relative browser assets (`css/styles.css`, `js/app.js`, `logo.png`, `api/*`) resolve through Home Assistant's Ingress tunnel without 404.
- Added `{ index: false }` to `express.static` to route root document requests through the dynamic base injector.
- Verified local live server execution across direct HTTP, Ingress proxy simulation, and Bearer token authentication.

## [1.0.6] - 2026-11-04

### Fixed
- Allowed direct access to Web UI static dashboard assets without `INGRESS_REQUIRED` 401 error.
- Added API Bearer token prompt and query parameter support for direct port `8653` browser sessions and WebSockets.
- Removed `ingress_entry: /` from `config.yaml` to prevent double-slash proxy 404 in Home Assistant Ingress.
- Simplified Ingress detection in `auth.js` to rely directly on `X-Ingress-Path` and `X-Hassio-Key` headers without restrictive IP filtering.

## [1.0.5] - 2026-11-04

### Fixed
- Fixed Home Assistant Ingress sub-path routing: normalized `X-Ingress-Path` in Express middleware so `/api/*` routes and static assets resolve correctly inside Home Assistant iframe.
- Updated frontend Ingress base URL resolution to reliably strip trailing filenames (e.g. `index.html`) from `window.location.pathname`.
- Expanded Ingress IP authentication to support all private Home Assistant Docker subnet addresses (`172.30.32.0/23`, `172.16.0.0/12`, loopback).

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
