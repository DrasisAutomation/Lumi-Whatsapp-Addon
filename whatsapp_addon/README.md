# Home Assistant Add-on: WhatsApp

Multi-account WhatsApp Web (Baileys) linked-device engine for Home Assistant with Ingress Web Dashboard, persistent message queue, encrypted CCTV snapshot and media uploads, incoming message events, and authenticated internal REST & WebSocket API.

## Features

- **Multiple Independent WhatsApp Accounts**: Connect `default`, `office`, `personal`, `security`, or custom account IDs with isolated session storage and queues.
- **QR Code Pairing via Home Assistant Ingress**: Scan QR codes directly inside Home Assistant without exposing any public ports.
- **Persistent Sessions**: Crash-safe atomic credential storage in `/data/sessions/<clientId>` survives Home Assistant restarts, add-on upgrades, and container recreation.
- **Encrypted Media & CCTV Snapshot Uploads**: Native support for images (JPEG, PNG, WebP), MP4 video, PDF/documents, audio, and locations from `/config/www`, `/media`, `/share`, or remote HTTPS URLs, including automatic file-readiness polling for `camera.snapshot`.
- **Authenticated Internal API**: Works seamlessly with the companion **WhatsApp HACS Integration** (`custom_components/whatsapp`).

> **Disclaimer**: Uses the unofficial community-maintained `@whiskeysockets/baileys` library. Not affiliated with WhatsApp or Meta.
