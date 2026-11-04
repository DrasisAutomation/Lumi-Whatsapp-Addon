# Installation Guide – Lumi Whatsapp Add-on & HACS Integration

<p align="center">
  <img src="../logo.png" alt="Lumi Whatsapp Logo" width="120" />
</p>

This single GitHub repository (`https://github.com/DrasisAutomation/Lumi-Whatsapp-Addon`) contains both the **Lumi Whatsapp Home Assistant Add-on** (`whatsapp_addon/` + `repository.yaml`) and the **Lumi Whatsapp HACS Custom Integration** (`custom_components/whatsapp/` + `hacs.json`).

---

## Part 1: Home Assistant Add-on Installation

1. Open **Home Assistant**.
2. Go to **Settings**.
3. Open **Apps / Add-ons**.
4. Click **Add-on Store** (bottom right).
5. Open the **three-dot menu** (top right) and select **Repositories**.
6. Paste the repository URL:
   ```text
   https://github.com/DrasisAutomation/Lumi-Whatsapp-Addon
   ```
7. Click **Add**, then close the dialog and refresh the Add-on Store page if needed.
8. Scroll to **Lumi Whatsapp Add-on Repository** and click **Lumi Whatsapp**.
9. Click **Install**.
10. Optionally open the **Configuration** tab and set your own `api_key` (if left blank, a cryptographic 64-character token is automatically generated on first start and displayed in the Web UI **Diagnostics** tab).
11. Enable **Start on boot**, **Watchdog**, and **Show in sidebar**, then click **Start**.
12. Click **Open Web UI** (opens via Home Assistant Ingress).

---

## Part 2: QR Code Pairing & Adding Multiple Accounts

1. Inside the **Lumi Whatsapp** Add-on **Web UI**, open the **Accounts & QR** tab.
2. For the default account (`default`), click **Connect / Show QR**.
3. On your phone, open **WhatsApp**:
   - **Android**: Tap the three-dot menu &rarr; **Linked devices** &rarr; **Link a device**.
   - **iPhone**: Go to **Settings** &rarr; **Linked Devices** &rarr; **Link a Device**.
4. Scan the QR code displayed in the Home Assistant Web UI.
5. Within a few seconds, the account status changes to `connected` and displays your linked phone number.

### Adding Additional Independent Accounts (`office`, `personal`, `security`, etc.)
1. In the **Accounts & QR** tab under **Add Lumi Whatsapp Account**:
   - Enter a unique **Account ID (`clientId`)**, such as `office`, `personal`, or `security` (letters, numbers, underscores, and hyphens).
   - Enter a **Display Name** (e.g., `Office WhatsApp`).
   - Click **Add WhatsApp Account**.
2. Scan the new QR code using the second WhatsApp phone/account.
3. Each account maintains an isolated session folder (`/data/sessions/<clientId>`), independent socket connection, and independent persistent message queue (`/data/queue/<clientId>.queue.json`).

---

## Part 3: HACS Integration Installation

1. Open **HACS** in Home Assistant.
2. Select **Integrations** (or click the three-dot menu in the top right of HACS).
3. Select **Custom repositories**.
4. In **Repository**, enter:
   ```text
   https://github.com/DrasisAutomation/Lumi-Whatsapp-Addon
   ```
5. In **Category / Type**, select **Integration**.
6. Click **Add**.
7. Find **Lumi Whatsapp** in HACS and click **Download**.
8. **Restart Home Assistant** (**Developer Tools** &rarr; **YAML** &rarr; **Restart**).
9. Go to **Settings** &rarr; **Devices & services** &rarr; **Add Integration**.
10. Search for **Lumi Whatsapp** and select it.
11. Enter:
    - **Add-on API URL**: `http://local-whatsapp:8099` (or the hostname shown in your Add-on's Info/Diagnostics page, e.g., `http://54c23642-whatsapp:8099`).
    - **API Bearer Token**: Copy the token from the Add-on Web UI **Diagnostics** tab (or the `api_key` you configured in the Add-on Configuration tab).
12. Click **Submit**. Each WhatsApp account will immediately appear as a Home Assistant Device (`Lumi Whatsapp - Default Account`) with 7 Sensors and 1 Binary Sensor.

---

## Updating & Uninstalling

### Updating
- **Add-on**: Updates appear automatically in **Settings** &rarr; **Add-ons** &rarr; **Lumi Whatsapp** when a new version is released. Updating the add-on preserves all sessions in `/data/sessions/`.
- **HACS Integration**: Updates appear in **HACS** &rarr; **Lumi Whatsapp**. Restart Home Assistant after updating the integration.

### Uninstalling
1. Go to **Settings** &rarr; **Devices & services** &rarr; **Lumi Whatsapp** &rarr; three-dot menu &rarr; **Delete**.
2. In HACS, remove the **Lumi Whatsapp** custom integration if no longer needed.
3. In **Settings** &rarr; **Add-ons** &rarr; **Lumi Whatsapp**, click **Uninstall** (optionally check "Also permanently delete this add-on's data" if you want to wipe `/data/sessions`).
