# Security Architecture & Protocol Disclaimer

## 1. Authentication & Network Isolation

1. **Home Assistant Ingress Only for Web UI**:
   - The Web UI is served exclusively through Home Assistant Supervisor Ingress (`ingress: true`, port `8653`).
   - Direct browser requests that do not originate from the Supervisor Ingress proxy (`172.30.32.2` with `X-Ingress-Path`) or carry a valid `Authorization: Bearer <API_KEY>` header are rejected with `401 UNAUTHORIZED`.
2. **Constant-Time Bearer Token Verification**:
   - All `/api/*` and `/ws` calls from the HACS integration authenticate with a 256-bit Bearer token verified via `crypto.timingSafeEqual` to prevent timing side-channel attacks.
3. **Rate Limiting & Payload Caps**:
   - Sliding-window per-IP rate limiting protects all endpoints (`429 RATE_LIMIT_EXCEEDED`), and request payload sizes and timeouts are strictly bounded.

---

## 2. File System & Media Security

1. **Least-Privilege Read-Only Mounts**:
   - The add-on mounts `homeassistant_config:ro`, `media:ro`, and `share:ro` as read-only (`ro`).
2. **Canonical Path Traversal & Symlink Escape Protection**:
   - `validateLocalMediaPath()` resolves both the target path and `fs.realpathSync()` and verifies that the canonical path resides strictly within `/config/www`, `/media`, or `/share`.
   - Null bytes, `../` traversal, and symlinks pointing to `/config/secrets.yaml` or `/config/.storage` are rejected with `403 PATH_TRAVERSAL_BLOCKED` / `SYMLINK_ESCAPE_BLOCKED`.
3. **Magic-Byte Content Verification**:
   - Every media buffer is inspected for valid file headers (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF...WEBP`, MP4 `ftyp`/`moov`, PDF `%PDF`, Ogg `OggS`, MP3/WAV) prior to encryption and upload.
4. **SSRF Protection on Remote URLs**:
   - `validateAndResolveRemoteUrl()` resolves DNS records prior to connecting and blocks loopback (`127.0.0.0/8`, `::1`), cloud metadata (`169.254.169.254`), link-local (`169.254.0.0/16`), and private RFC1918 networks unless explicitly whitelisted in `allowed_local_hosts`.

---

## 3. Atomic Credential Storage & Secret Hygiene

- **Atomic Session Writes**: Signal keys and Baileys credentials in `/data/sessions/<clientId>` are written via temporary files with `0600` permissions, `fsync()`, and atomic `rename()`, plus an automatic `creds.json.bak` fallback.
- **No Custom Cryptography**: All Signal E2EE and WhatsApp media encryption (`hkdf`, AES-CBC + HMAC-SHA256 media keys) are delegated strictly to `@whiskeysockets/baileys`.
- **Redacted Logging & Diagnostics**: `pino` redaction and Home Assistant `async_redact_data` strip `api_key`, tokens, QR codes, Signal keys, and private message contents from logs and diagnostic downloads.

---

## 4. Unofficial Protocol & Account Restrictions Disclaimer

- This software uses `@whiskeysockets/baileys`, an open-source implementation of WhatsApp Web's multi-device linked client protocol.
- It is **not** an official WhatsApp or Meta product.
- Because WhatsApp may change its internal WebSocket protocol or enforce anti-spam rate limits at any time, 100% compatibility cannot be guaranteed indefinitely.
- Use this integration only for personal smart-home notifications and authorized interactive commands; never use it for unsolicited bulk messaging.
