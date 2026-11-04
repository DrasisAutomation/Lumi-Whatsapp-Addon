# Troubleshooting & Session Recovery Guide

## 1. Account Status is `logged_out` (Session Invalid)

### Cause
WhatsApp returned HTTP `401 (DisconnectReason.loggedOut)` because the linked device was manually removed from the phone (**WhatsApp &rarr; Linked Devices &rarr; Log out**) or expired after prolonged phone inactivity (>14 days with primary phone turned off).

### Resolution
1. Open Home Assistant &rarr; **WhatsApp** (Add-on Web UI).
2. Go to **Accounts & QR**.
3. Locate the account showing `logged_out`.
4. Click **Regenerate QR** (or **Connect / Show QR**).
5. Scan the new QR code using **WhatsApp &rarr; Linked Devices &rarr; Link a Device** on your phone.

> [!NOTE]
> Temporary internet outages, DNS hiccups, or Home Assistant restarts **never** delete your session credentials. The add-on automatically reconnects with exponential backoff while preserving `/data/sessions/<clientId>/creds.json` and its atomic backup `creds.json.bak`.

---

## 2. CCTV Snapshot Fails with `FILE_NOT_FOUND` or `PATH_TRAVERSAL_BLOCKED`

### Cause A: File Path Outside Permitted Directories
For security, the add-on only permits reading local media files inside:
- `/config/www` (or `/local/...`)
- `/media`
- `/share`

### Resolution A
Save your camera snapshots inside `/config/www/snapshots/...` or `/media/snapshots/...`:
```yaml
action: camera.snapshot
target:
  entity_id: camera.entrance_cctv
data:
  filename: /config/www/snapshots/entrance.jpg
```

### Cause B: Slow RTSP Camera Takes Longer Than 10 Seconds
If your camera takes more than 10 seconds to write a snapshot, increase `snapshot_wait_timeout_ms` (for example to `20000`) in **Settings &rarr; Add-ons &rarr; WhatsApp &rarr; Configuration**.

---

## 3. Local HTTP Camera / NVR URL Blocked by `SSRF_BLOCKED`

### Cause
By default, the add-on blocks HTTP/HTTPS downloads from private LAN IP ranges (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `127.0.0.1`, `.local`) to prevent Server-Side Request Forgery (SSRF).

### Resolution
If you want to pass a trusted local LAN camera or Frigate/NVR URL (e.g., `http://192.168.1.50:5000/api/events/.../snapshot.jpg`) directly to `whatsapp.send_image`, add `192.168.1.50` to `allowed_local_hosts` in the Add-on Configuration:

```yaml
allowed_local_hosts:
  - "192.168.1.50"
```

---

## 4. HACS Integration Cannot Connect to Add-on (`cannot_connect` or `invalid_auth`)

1. Verify the **WhatsApp** add-on is running (**Settings &rarr; Add-ons &rarr; WhatsApp**).
2. Open the Add-on **Web UI** &rarr; **Diagnostics** tab.
3. Copy the exact **API Bearer Token** displayed under **HACS Integration Connection Details**.
4. Try the internal URL `http://local-whatsapp:8099`, `http://localhost:8099`, or the add-on's specific hostname shown in the Add-on **Info** tab (e.g., `http://54c23642-whatsapp:8099`).

---

## 5. Inspecting Sanitized Diagnostics

- **In the Add-on Web UI**: Open the **Diagnostics** tab to view connection errors, authentication errors, media upload failures, and retry telemetry.
- **In Home Assistant**: Go to **Settings &rarr; Devices & services &rarr; WhatsApp &rarr; three-dot menu &rarr; Download diagnostics**. All tokens, QR codes, private keys, phone numbers, and message contents are automatically redacted.
