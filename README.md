# HA WhatsApp – Complete Home Assistant Add-on + HACS Integration

[![Add-on Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](whatsapp_addon/config.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A complete, self-hosted WhatsApp system for Home Assistant consisting of two components in a single installable repository:

1. **Home Assistant WhatsApp Add-on (`whatsapp_addon/`)**: Multi-account WhatsApp linked-device engine (powered by `@whiskeysockets/baileys`), Ingress Web UI dashboard, QR code pairing, crash-safe atomic session storage, persistent sequential message queue, CCTV snapshot readiness verification & encrypted media uploads, and authenticated internal REST + WebSocket API.
2. **Home Assistant WhatsApp HACS Integration (`custom_components/whatsapp/`)**: Native Python integration providing Config Flow setup, Supervisor discovery, per-account Devices, 7 Sensors + 1 Binary Sensor per account, 12 native Home Assistant Actions/Services (`whatsapp.send_message`, `whatsapp.send_image`, etc.), incoming/receipt events (`new_whatsapp_message`, `whatsapp_message_status`, etc.), and redacted diagnostics.

> [!IMPORTANT]
> **Protocol & Account Disclaimer**: This project uses the community-maintained [Baileys (`@whiskeysockets/baileys`)](https://github.com/WhiskeySockets/Baileys) library, which implements WhatsApp's linked-device WebSocket protocol. It is **not** an official WhatsApp Business Cloud API product and is not affiliated with WhatsApp or Meta. 100% compatibility with future protocol changes cannot be guaranteed. Use responsibly for personal smart-home alerts and avoid spam or bulk messaging.

---

## Step-by-Step Installation

Both the **Home Assistant Add-on Store** and **HACS Custom Repositories** support installing directly from this repository URL:

```text
https://github.com/DrasisAutomation/ha-whatsapp
```

### A. Add-on Installation

1. Open **Home Assistant**.
2. Go to **Settings**.
3. Open **Apps / Add-ons**.
4. Open the **Add-on Store**.
5. Open the **three-dot menu** (top right) and select **Repositories**.
6. Add:
   ```text
   https://github.com/DrasisAutomation/ha-whatsapp
   ```
7. Click **Add**.
8. Find **WhatsApp** in the store and click **Install**.
9. Start the add-on.
10. Click **Open Web UI** (via Home Assistant Ingress).
11. Open **Accounts & QR**, click **Connect / Show QR**, and scan the QR code using **WhatsApp &rarr; Linked Devices &rarr; Link a Device** on your phone.

### B. HACS Integration Installation

1. Open **HACS**.
2. Open **Integrations**.
3. Select the **three-dot menu** (top right) and select **Custom repositories**.
4. Add the same GitHub repository URL:
   ```text
   https://github.com/DrasisAutomation/ha-whatsapp
   ```
5. Select **Integration** as the category and click **Add**.
6. Install **WhatsApp**.
7. **Restart Home Assistant**.
8. Open **Settings &rarr; Devices & services &rarr; Add Integration**.
9. Search for **WhatsApp** and complete the setup using the internal URL (`http://local-whatsapp:8099`) and the **API Bearer Token** shown in the Add-on Web UI **Diagnostics** tab.

---

## Home Assistant Devices & Entities

Each connected WhatsApp account (e.g., `default`, `office`, `personal`, `security`) is registered as a dedicated Home Assistant Device (`WhatsApp - Default Account`) with:

- **Binary Sensor**:
  - `binary_sensor.whatsapp_default_connected`
- **Sensors**:
  - `sensor.whatsapp_default_status`
  - `sensor.whatsapp_default_phone`
  - `sensor.whatsapp_default_messages_sent`
  - `sensor.whatsapp_default_messages_received`
  - `sensor.whatsapp_default_pending_messages`
  - `sensor.whatsapp_default_failed_messages`
  - `sensor.whatsapp_default_last_message`

---

## Native Home Assistant Actions / Services

All 12 actions are available in **Developer Tools &rarr; Actions** and in Automations/Scripts:

| Service | Description |
|---|---|
| `whatsapp.send_message` | Send a text message (`clientId`, `to`, `body.text`) |
| `whatsapp.send_image` | Upload & send a local image, CCTV snapshot, or HTTPS image (`clientId`, `to`, `image`, `caption`, `cooldownSeconds`) |
| `whatsapp.send_video` | Upload & send an MP4 video (`clientId`, `to`, `video`, `caption`) |
| `whatsapp.send_document` | Upload & send a PDF or document (`clientId`, `to`, `document`, `fileName`, `caption`) |
| `whatsapp.send_audio` | Upload & send an audio file or voice note (`clientId`, `to`, `audio`, `ptt`) |
| `whatsapp.send_location` | Send a GPS location pin (`clientId`, `to`, `latitude`, `longitude`, `name`, `address`) |
| `whatsapp.get_contacts` | Retrieve cached contacts (`clientId`) |
| `whatsapp.get_groups` | Retrieve joined WhatsApp groups and `@g.us` JIDs (`clientId`) |
| `whatsapp.check_number` | Verify whether a phone number is registered on WhatsApp (`clientId`, `number`) |
| `whatsapp.disconnect` | Gracefully disconnect an account socket without wiping credentials (`clientId`) |
| `whatsapp.reconnect` | Reconnect a WhatsApp account session (`clientId`) |
| `whatsapp.send_message_to_group` | Send a text message to a WhatsApp group JID (`clientId`, `groupId`, `body.text`) |

---

## Example Automations

### 1. CCTV Motion Snapshot Alert
```yaml
alias: CCTV WhatsApp Snapshot Alert
triggers:
  - trigger: state
    entity_id: binary_sensor.entrance_motion
    to: "on"
conditions: []
actions:
  - action: camera.snapshot
    target:
      entity_id: camera.entrance_cctv
    data:
      filename: /config/www/snapshots/entrance.jpg
  - delay:
      seconds: 2
  - action: whatsapp.send_image
    data:
      clientId: default
      to: "919876543210"
      image: "/config/www/snapshots/entrance.jpg"
      caption: "Motion detected at entrance!"
      cooldownSeconds: 30
mode: single
```

### 2. Reply to Incoming `"STATUS"` Message
```yaml
alias: WhatsApp House Status Auto-Reply
triggers:
  - trigger: event
    event_type: new_whatsapp_message
    event_data:
      clientId: default
      sender: "919876543210"
conditions:
  - condition: template
    value_template: "{{ trigger.event.data.text | default('') | trim | upper == 'STATUS' }}"
actions:
  - action: whatsapp.send_message
    data:
      clientId: default
      to: "{{ trigger.event.data.sender }}"
      body:
        text: "House Status: All systems normal ({{ states('sensor.whatsapp_default_status') }})"
mode: single
```

---

## Complete Documentation

- [System Architecture Specification](docs/ARCHITECTURE.md)
- [Step-by-Step Installation Guide](docs/INSTALLATION.md)
- [Configuration & Entities Guide](docs/CONFIGURATION.md)
- [Services & Internal API Reference](docs/SERVICES.md)
- [Automations & Incoming Message Guide](docs/AUTOMATIONS.md)
- [Troubleshooting & Session Recovery](docs/TROUBLESHOOTING.md)
- [Security Architecture](docs/SECURITY.md)
- [Feature & Milestone Status Matrix](docs/FEATURE_STATUS.md)
