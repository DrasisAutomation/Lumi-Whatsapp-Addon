# Automations Guide – CCTV Snapshot Alerts & Incoming WhatsApp Commands

## 1. CCTV Motion Snapshot Alert Automation

This automation captures a snapshot from `camera.entrance_cctv` when `binary_sensor.entrance_motion` turns `on` and sends the image over WhatsApp.

> [!TIP]
> **Automatic Snapshot Readiness & Cooldown**: Even if `camera.snapshot` takes longer than 2 seconds on slower cameras or RTSP streams, the add-on's `MediaManager.waitForFileReady()` automatically polls for up to `snapshot_wait_timeout_ms` (default 10 seconds) until `/config/www/snapshots/entrance.jpg` exists, is non-empty, and has stabilized in byte size, before validating its JPEG magic bytes and uploading. You can also pass `cooldownSeconds: 30` to prevent repeated motion alerts within 30 seconds.

```yaml
alias: CCTV WhatsApp Snapshot Alert
description: Capture CCTV snapshot on motion and send via WhatsApp with readiness check and cooldown
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

---

## 2. Incoming Message Event Structure (`new_whatsapp_message`)

Whenever an incoming WhatsApp message arrives on any connected account, the integration fires the `new_whatsapp_message` event on the Home Assistant Event Bus.

**Event Payload**:
```json
{
  "event": "new_whatsapp_message",
  "clientId": "default",
  "messageId": "3EB0A123456789ABCDEF",
  "sender": "919876543210",
  "senderJid": "919876543210@s.whatsapp.net",
  "senderName": "Mohan",
  "isGroup": false,
  "groupId": null,
  "messageType": "text",
  "text": "STATUS",
  "timestamp": "2026-11-04T10:30:00.000Z"
}
```
Supported `messageType` values: `text`, `image`, `video`, `document`, `audio`, `voice_note`.
*(Outgoing messages sent by Home Assistant have `fromMe: true` and are strictly filtered out so automations never loop on outgoing messages.)*

---

## 3. Interactive Command Automation: Reply to `"STATUS"` with House Status

When a specific authorized phone number (`919876543210`) sends `"STATUS"` (case-insensitive), Home Assistant replies with the current house status:

```yaml
alias: WhatsApp Interactive House Status Reply
description: Reply with current house status when authorized number sends STATUS
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
      clientId: "{{ trigger.event.data.clientId }}"
      to: "{{ trigger.event.data.sender }}"
      body:
        text: >-
          🏠 *Home Status Report*
          • Alarm: {{ states('alarm_control_panel.home_alarm') | default('disarmed') }}
          • Front Door: {{ states('binary_sensor.entrance_motion') | default('clear') }}
          • Indoor Temp: {{ states('sensor.living_room_temperature') | default('N/A') }} °C
          • WhatsApp Account: {{ states('sensor.whatsapp_default_status') }}
mode: queued
```

---

## 4. Trigger an Action When Any Incoming WhatsApp Message Arrives

```yaml
alias: Notify Persistent Notification on Incoming WhatsApp Message
triggers:
  - trigger: event
    event_type: new_whatsapp_message
conditions: []
actions:
  - action: persistent_notification.create
    data:
      title: "WhatsApp from {{ trigger.event.data.senderName }} ({{ trigger.event.data.sender }})"
      message: >-
        Account: {{ trigger.event.data.clientId }}
        Type: {{ trigger.event.data.messageType }}
        Text: {{ trigger.event.data.text }}
mode: parallel
```

---

## 5. Monitor Delivery Receipts & Failed Sends (`whatsapp_message_status`)

Track when a critical alert is `sent`, `delivered`, `read`, or `failed`:

```yaml
alias: Alert on Failed WhatsApp Message Delivery
triggers:
  - trigger: event
    event_type: whatsapp_message_status
    event_data:
      status: failed
conditions: []
actions:
  - action: persistent_notification.create
    data:
      title: "WhatsApp Delivery Failure ({{ trigger.event.data.clientId }})"
      message: >-
        Failed to deliver message {{ trigger.event.data.messageId }}
        to {{ trigger.event.data.recipient }}.
        Error: {{ trigger.event.data.error.message | default('Unknown error') }}
mode: parallel
```
