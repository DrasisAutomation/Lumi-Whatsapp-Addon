#!/usr/bin/with-contenv bashio
# ==============================================================================
# Home Assistant Add-on: WhatsApp
# Starts the WhatsApp Node.js service with Supervisor configuration
# ==============================================================================
set -e

bashio::log.info "Starting Home Assistant WhatsApp Add-on..."

mkdir -p /data/sessions /data/queue /data/history

if bashio::fs.file_exists '/data/options.json'; then
    export OPTIONS_PATH="/data/options.json"
fi

export DATA_DIR="/data"
export PORT="8099"

cd /opt/whatsapp_addon
exec node src/index.js
