# HA WhatsApp – Feature & Milestone Status

Status Legend:
- `Not started`
- `In development`
- `Automated test passed`
- `Manual test required`
- `Manually verified`

---

## Milestone Progress Overview

| Milestone | Description | Status | Notes |
|---|---|---|---|
| **Milestone 1** | Architecture and project structure | `Automated test passed` | Validated via `tests/validate_milestone1.mjs` |
| **Milestone 2** | Home Assistant add-on and Docker build | `Automated test passed` | Add-on config, Dockerfile, server & health verified |
| **Milestone 3** | WhatsApp QR pairing and persistent sessions | `Automated test passed` | Multi-account Baileys engine, QR & atomic auth state tested (`addon.test.js`); live phone QR scan is `Manual test required` |
| **Milestone 4** | Text messaging | `Automated test passed` | Persistent queue, backoff, idempotency & `/api/messages/send` verified |
| **Milestone 5** | Image and media messaging | `Automated test passed` | Path security, SSRF blocking, `waitForFileReady` CCTV snapshot & magic bytes verified |
| **Milestone 6** | HACS integration | `Automated test passed` | `config_flow.py`, `api.py`, `coordinator.py` tested (`test_integration.py`) |
| **Milestone 7** | Home Assistant entities and services | `Automated test passed` | 7 Sensors + 1 Binary Sensor + all 12 `whatsapp.*` services verified |
| **Milestone 8** | Automation and incoming message events | `Automated test passed` | `new_whatsapp_message`, `fromMe` filtering, and receipt status events verified |
| **Milestone 9** | Reliability, security and diagnostics | `Automated test passed` | Bearer auth, Ingress isolation, rate limiting, and redaction verified |
| **Milestone 10** | GitHub publishing and installation testing | `Automated test passed` | GitHub Actions workflows & full documentation completed; live GitHub push & HA OS installation are `Manual test required` |

---

## Detailed Feature Matrix

| Category | Feature / Requirement | Status | Verification Method |
|---|---|---|---|
| **1. Repository & Structure** | Root `repository.yaml` for HA Add-on Store | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **1. Repository & Structure** | Root `hacs.json` for HACS Integration compatibility | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **1. Repository & Structure** | Security `.gitignore` (excludes sessions, QR, keys) | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **1. Repository & Structure** | Complete directory hierarchy (`whatsapp_addon`, `custom_components/whatsapp`, `docs`, `.github/workflows`) | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **2. Add-on & Docker** | `whatsapp_addon/config.yaml` with Ingress, schema, `amd64` + `aarch64` | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **2. Add-on & Docker** | `Dockerfile`, `build.yaml`, `run.sh`, s6 service startup | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **2. Add-on & Docker** | Express + WebSocket server & `/api/health` | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **3. Pairing & Sessions** | Baileys multi-account connection & atomic session storage | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **3. Pairing & Sessions** | QR code generation, regeneration, reconnect & disconnect | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **3. Pairing & Sessions** | Ingress Web UI Dashboard & Accounts management | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **3. Pairing & Sessions** | Real WhatsApp phone QR scan & live multi-device pairing | `Manual test required` | Requires user's physical WhatsApp phone in Home Assistant |
| **4. Text Messaging** | Persistent per-account message queue with backoff & idempotency | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **4. Text Messaging** | `POST /api/messages/send` & Web UI Messaging tab | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **4. Text Messaging** | Message history & delivery status tracking (`queued` -> `read`) | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **5. Media Messaging** | Local file path validation (`/config/www`, `/media`, `/share`) & traversal protection | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **5. Media Messaging** | Snapshot readiness verification (`waitForFileReady`) for CCTV | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **5. Media Messaging** | Remote HTTP/HTTPS download with SSRF protection | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **5. Media Messaging** | Image, Video, Document, Audio & Location sending via Baileys | `Automated test passed` | `whatsapp_addon/tests/addon.test.js` |
| **6. HACS Integration** | `manifest.json`, `config_flow.py`, `api.py`, `coordinator.py` | `Automated test passed` | `tests/custom_components/whatsapp/test_integration.py` |
| **6. HACS Integration** | WebSocket live event listener & automatic reconnection | `Automated test passed` | `tests/custom_components/whatsapp/test_integration.py` |
| **7. Entities & Services** | Per-account Device + 7 Sensors + 1 Binary Sensor | `Automated test passed` | `tests/custom_components/whatsapp/test_integration.py` |
| **7. Entities & Services** | All 12 `whatsapp.*` native Home Assistant services + `services.yaml` | `Automated test passed` | `tests/custom_components/whatsapp/test_integration.py` |
| **8. Automations & Events** | `new_whatsapp_message` & status events on HA Event Bus | `Automated test passed` | `tests/custom_components/whatsapp/test_integration.py` |
| **8. Automations & Events** | CCTV snapshot alert automation with cooldown & incoming command reply | `Automated test passed` | `docs/AUTOMATIONS.md` & `addon.test.js` |
| **9. Reliability & Security** | Bearer auth, rate limiting, sanitized diagnostics (`diagnostics.py` & `/api/diagnostics`) | `Automated test passed` | `addon.test.js` & `test_integration.py` |
| **10. CI/CD & Publishing** | GitHub Actions (`build-addon.yml`, `validate-integration.yml`, `release.yml`) & full docs | `Automated test passed` | `tests/validate_milestone1.mjs` |
| **10. CI/CD & Publishing** | Push to GitHub & install in live Home Assistant Supervisor + HACS | `Manual test required` | Requires user approval to push to GitHub and test on live HA |
