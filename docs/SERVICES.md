# Services, Actions & Internal API Reference

All 12 native Home Assistant actions are registered under the `whatsapp` domain and can be invoked from **Developer Tools &rarr; Actions**, Automations, and Scripts.

---

## 1. Home Assistant Actions (`whatsapp.*`)

### Service 1: `whatsapp.send_message`
Send a text message to an individual phone number or JID.

```yaml
action: whatsapp.send_message
data:
  clientId: default
  to: "919876543210"
  body:
    text: "Hello from Home Assistant"
```

---

### Service 2: `whatsapp.send_image`
Upload and send a local image, CCTV snapshot (JPEG, PNG, WebP), or remote HTTPS image. Automatically waits for fresh snapshots to finish writing to disk.

```yaml
action: whatsapp.send_image
data:
  clientId: default
  to: "919876543210"
  image: "/config/www/snapshots/cctv.jpg"
  caption: "Motion detected at entrance!"
  cooldownSeconds: 15
```

---

### Service 3: `whatsapp.send_video`
Upload and send an MP4 video file from `/config/www`, `/media`, `/share`, or an HTTPS URL.

```yaml
action: whatsapp.send_video
data:
  clientId: default
  to: "919876543210"
  video: "/media/clips/driveway_motion.mp4"
  caption: "Driveway motion video clip"
```

---

### Service 4: `whatsapp.send_document`
Upload and send a PDF or document file from `/config/www`, `/media`, `/share`, or an HTTPS URL.

```yaml
action: whatsapp.send_document
data:
  clientId: default
  to: "919876543210"
  document: "/share/reports/monthly_energy.pdf"
  fileName: "monthly_energy.pdf"
  caption: "Monthly Home Assistant Energy Report"
```

---

### Service 5: `whatsapp.send_audio`
Upload and send an audio file or playable voice note (`ptt: true`).

```yaml
action: whatsapp.send_audio
data:
  clientId: default
  to: "919876543210"
  audio: "/media/tts/doorbell_chime.ogg"
  ptt: true
```

---

### Service 6: `whatsapp.send_location`
Send a geographical GPS location pin.

```yaml
action: whatsapp.send_location
data:
  clientId: default
  to: "919876543210"
  latitude: 28.6139
  longitude: 77.2090
  name: "Home Entrance"
  address: "Main Gate Sensor"
```

---

### Service 7: `whatsapp.get_contacts`
Retrieve known contacts for the specified account (supports action response variable in scripts/automations).

```yaml
action: whatsapp.get_contacts
data:
  clientId: default
response_variable: whatsapp_contacts
```

---

### Service 8: `whatsapp.get_groups`
Retrieve all joined WhatsApp groups and their `@g.us` group JIDs.

```yaml
action: whatsapp.get_groups
data:
  clientId: default
response_variable: whatsapp_groups
```

---

### Service 9: `whatsapp.check_number`
Check if a phone number is registered on WhatsApp and retrieve its canonical JID.

```yaml
action: whatsapp.check_number
data:
  clientId: default
  number: "919876543210"
response_variable: number_check
```

---

### Service 10: `whatsapp.disconnect`
Gracefully disconnect a WhatsApp account socket without deleting its session credentials.

```yaml
action: whatsapp.disconnect
data:
  clientId: default
```

---

### Service 11: `whatsapp.reconnect`
Reconnect a disconnected WhatsApp account session.

```yaml
action: whatsapp.reconnect
data:
  clientId: default
```

---

### Service 12: `whatsapp.send_message_to_group`
Send a text message to a WhatsApp group JID (`1203630...@g.us`).

```yaml
action: whatsapp.send_message_to_group
data:
  clientId: default
  groupId: "1203630123456789@g.us"
  body:
    text: "Security Alert: Perimeter alarm triggered!"
```

---

## 2. Internal Add-on REST & WebSocket API Reference

All requests to `/api/*` require header `Authorization: Bearer <API_KEY>` (or must originate from Home Assistant Supervisor Ingress `172.30.32.2`).

| Method | Endpoint | Request Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Add-on health, version, uptime, and connected account count |
| `GET` | `/api/accounts` | — | List all accounts with connection status and counters |
| `GET` | `/api/accounts/:clientId` | — | Single account details |
| `POST` | `/api/accounts` | `{ clientId, name, connectImmediately }` | Create a new account |
| `POST` | `/api/accounts/:clientId/connect` | `{ regenerateQr, resetSession }` | Start/reconnect account and generate QR |
| `POST` | `/api/accounts/:clientId/disconnect` | `{}` | Gracefully close account socket |
| `DELETE` | `/api/accounts/:clientId?confirm=true` | `confirm=true` | Delete account and wipe `/data/sessions/<clientId>` |
| `GET` | `/api/accounts/:clientId/qr` | — | Current QR code (`qrDataUrl`, `qrExpiresAt`) |
| `POST` | `/api/messages/send` | `{ clientId, to, body: { text } }` | Queue and send text message |
| `POST` | `/api/messages/send-image` | `{ clientId, to, image, caption, cooldownSeconds }` | Validate, encrypt & send image |
| `POST` | `/api/messages/send-video` | `{ clientId, to, video, caption }` | Validate, encrypt & send MP4 video |
| `POST` | `/api/messages/send-document` | `{ clientId, to, document, fileName, caption }` | Validate, encrypt & send document |
| `POST` | `/api/messages/send-audio` | `{ clientId, to, audio, ptt }` | Validate, encrypt & send audio / voice note |
| `POST` | `/api/messages/send-location` | `{ clientId, to, latitude, longitude, name, address }` | Send GPS location pin |
| `POST` | `/api/messages/send-group` | `{ clientId, groupId, body: { text } }` | Send text message to group JID |
| `GET` | `/api/messages` | `?clientId=default&limit=100` | List message history & receipt statuses |
| `GET` | `/api/messages/:messageId/status` | — | Inspect delivery status (`queued`, `sending`, `sent`, `delivered`, `read`, `played`, `failed`) |
| `GET` | `/api/contacts` | `?clientId=default` | List cached contacts |
| `GET` | `/api/groups` | `?clientId=default` | Fetch joined groups |
| `POST` | `/api/contacts/check` | `{ clientId, number }` | Check if phone number is on WhatsApp |
| `GET` | `/api/diagnostics` | — | Sanitized runtime, session, error, and queue diagnostics |
| `WS` | `/ws` | Header `Authorization: Bearer <API_KEY>` | Live event stream (`new_whatsapp_message`, `whatsapp_message_sent`, `whatsapp_message_status`, `whatsapp_send_message_result`, `whatsapp_connection_update`, `qr_update`) |
