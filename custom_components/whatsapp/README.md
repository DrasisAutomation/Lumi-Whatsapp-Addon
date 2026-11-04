# Lumi Whatsapp – Home Assistant HACS Custom Integration

<p align="center">
  <img src="logo.png" alt="Lumi Whatsapp Logo" width="140" />
</p>

This custom integration (`whatsapp`) connects Home Assistant Core to the companion **Lumi Whatsapp Add-on** over an authenticated REST and WebSocket API.

## Entities Created Per Account (`<clientId>`, e.g., `default`)

- **Device**: `Lumi Whatsapp - Default Account`
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

## Native Actions / Services

1. `whatsapp.send_message`
2. `whatsapp.send_image`
3. `whatsapp.send_video`
4. `whatsapp.send_document`
5. `whatsapp.send_audio`
6. `whatsapp.send_location`
7. `whatsapp.get_contacts`
8. `whatsapp.get_groups`
9. `whatsapp.check_number`
10. `whatsapp.disconnect`
11. `whatsapp.reconnect`
12. `whatsapp.send_message_to_group`

## Events Fired on Home Assistant Event Bus

- `new_whatsapp_message`
- `whatsapp_message_sent`
- `whatsapp_message_status`
- `whatsapp_send_message_result`
- `whatsapp_connection_update`
