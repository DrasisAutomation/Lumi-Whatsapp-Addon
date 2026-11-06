'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getBaileys } = require('../whatsapp/baileys');

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes inactivity timeout
const NUM_EMOJIS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function formatNum(n) {
  if (n >= 0 && n <= 10) return NUM_EMOJIS[n];
  return `${n}️⃣`;
}

class InteractiveBot {
  constructor({
    configManager,
    haClient,
    messageManager,
    eventManager,
    dataDir,
    logger,
    castsDir = null,
  }) {
    this.configManager = configManager;
    this.haClient = haClient;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.dataDir = dataDir;
    this.logger = logger;

    // Use HA www folder if available, else local castsDir fallback
    this.castsDir =
      castsDir ||
      (fs.existsSync('/config/www')
        ? '/config/www/whatsapp_casts'
        : path.join(dataDir, 'casts'));

    this.sessions = new Map(); // phone -> session object
    this._initDirs();
  }

  _initDirs() {
    try {
      if (!fs.existsSync(this.castsDir)) {
        fs.mkdirSync(this.castsDir, { recursive: true });
      }
    } catch (err) {
      this.logger?.warn({ err: err.message, dir: this.castsDir }, 'Could not create casts directory');
    }
  }

  init() {
    if (!this.eventManager) return;
    this.eventManager.on('event', async (evt) => {
      if (evt?.type === 'new_whatsapp_message' && evt.payload) {
        try {
          await this.handleIncomingMessage(evt.payload);
        } catch (err) {
          this.logger?.error({ err: err.message, payload: evt.payload }, 'InteractiveBot failed processing message');
        }
      }
    });
  }

  _getSession(phone) {
    return this.sessions.get(phone);
  }

  _setSession(phone, sessionData) {
    this._clearSessionTimer(phone);
    const timeout = setTimeout(() => {
      this._handleSessionTimeout(phone);
    }, SESSION_TIMEOUT_MS);
    if (typeof timeout?.unref === 'function') {
      timeout.unref();
    }

    this.sessions.set(phone, {
      ...sessionData,
      phone,
      replyTarget: sessionData.replyTarget || sessionData.senderJid || phone,
      timer: timeout,
      lastActiveAt: Date.now(),
    });
  }

  close() {
    for (const session of this.sessions.values()) {
      if (session?.timer) {
        clearTimeout(session.timer);
      }
    }
    this.sessions.clear();
  }

  _clearSessionTimer(phone) {
    const existing = this.sessions.get(phone);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
  }

  _destroySession(phone) {
    this._clearSessionTimer(phone);
    this.sessions.delete(phone);
  }

  async _sendMessage(clientId, to, text) {
    try {
      // If 'to' is a phone digits string and has a matching session with replyTarget, use replyTarget
      const session = this.sessions.get(to);
      const targetJid = session?.replyTarget || to;

      if (typeof this.messageManager?.sendText === 'function') {
        return await this.messageManager.sendText({
          clientId,
          to: targetJid,
          body: text,
        });
      }
      if (typeof this.messageManager?.sendMessage === 'function') {
        return await this.messageManager.sendMessage({
          clientId,
          to: targetJid,
          messageType: 'text',
          text,
          body: text,
        });
      }
      throw new Error('MessageManager does not implement sendText or sendMessage');
    } catch (err) {
      this.logger?.error({ err: err.message, clientId, to }, 'InteractiveBot: Failed to send reply');
    }
  }

  async _handleSessionTimeout(phone) {
    const session = this.sessions.get(phone);
    if (!session) return;
    this._destroySession(phone);

    const target = session.replyTarget || phone;
    if (session.type === 'remote') {
      const msg = `⏱️ *Session Timed Out:*\nYour remote control session has ended due to 5 minutes of inactivity. \nSend */remote* to start a new session.`;
      await this._sendMessage(session.clientId, target, msg);
    } else if (session.type === 'cast') {
      const msg = `⏱️ *Cast Session Timed Out:*\nYour broadcast session has ended due to 5 minutes of inactivity. \nSend */cast* whenever you are ready.`;
      await this._sendMessage(session.clientId, target, msg);
    }
  }

  _isAuthorized(clientId, phone, senderJid) {
    if (this.configManager.isAuthorized(phone, senderJid)) {
      return true;
    }

    // Auto-authorize the account owner (the device currently linked to this add-on)
    const conn =
      this.messageManager?.sessionManager?.getConnection?.(clientId) ||
      this.messageManager?.sessionManager?.accounts?.get?.(clientId);
    if (conn) {
      const ownerPhone = conn.phone ? String(conn.phone).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null;
      const ownerJid = conn.jid ? String(conn.jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null;
      const ownerLid = conn.sock?.user?.lid ? String(conn.sock.user.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null;
      const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
      const cleanJid = senderJid ? String(senderJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';

      if (
        (cleanPhone && ownerPhone && cleanPhone === ownerPhone) ||
        (cleanPhone && ownerJid && cleanPhone === ownerJid) ||
        (cleanPhone && ownerLid && cleanPhone === ownerLid) ||
        (cleanJid && ownerLid && cleanJid === ownerLid) ||
        (cleanJid && ownerJid && cleanJid === ownerJid) ||
        (cleanJid && ownerPhone && cleanJid === ownerPhone)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Main entry point for incoming messages.
   */
  async handleIncomingMessage(msg) {
    if (!msg || msg.isGroup) return; // Only direct 1-on-1 private messages are handled by bot

    const phone = String(msg.sender || '').replace(/[^0-9]/g, '');
    const senderJid = msg.senderJid || (msg.sender ? (msg.sender.includes('@') ? msg.sender : `${msg.sender}@s.whatsapp.net`) : null);
    const replyTarget = msg.senderJid || phone;
    const rawText = String(msg.text || '').trim();
    const clientId = msg.clientId;
    const session = this._getSession(phone);

    // 1. Explicit Session Termination (/end)
    if (rawText.toLowerCase() === '/end') {
      if (session) {
        const isCast = session.type === 'cast';
        const target = session.replyTarget || replyTarget;
        this._destroySession(phone);
        const exitMsg = isCast
          ? `👋 *Cast Session Ended.*\nAudio broadcast cancelled. Send */cast* anytime to broadcast or */remote* for smart home controls.`
          : `👋 *Remote Session Ended.*\nThank you! Send */remote* anytime you want to control your devices.`;
        return this._sendMessage(clientId, target, exitMsg);
      } else {
        return this._sendMessage(
          clientId,
          replyTarget,
          `👋 *Session Ended.*\nSend */remote* to control devices or */cast* to broadcast audio.`
        );
      }
    }

    // 2. Global Help command (/help)
    if (rawText.toLowerCase() === '/help') {
      const helpMsg = `ℹ️ *Lumi Remote Commands:*\n• */remote* - Open main smart home menu\n• *1, 2, 3...* - Select room number\n• *on 1* or *on-1* - Turn ON device #1\n• *off 1* or *off-1* - Turn OFF device #1\n• *on 1,2,3* - Turn ON multiple devices\n• *off 1,2,3* - Turn OFF multiple devices\n• */back* - Go back to room list\n• */end* - Exit remote session`;
      return this._sendMessage(clientId, session?.replyTarget || replyTarget, helpMsg);
    }

    // 3. Trigger: /remote
    if (rawText.toLowerCase() === '/remote') {
      if (!this._isAuthorized(clientId, phone, msg.senderJid)) {
        const config = this.configManager.getConfig();
        const hasWhitelisted = Array.isArray(config.authorizedNumbers) && config.authorizedNumbers.length > 0;
        const deniedMsg = hasWhitelisted
          ? `⛔ *Access Denied:*\nThis phone number / ID (+${phone}) is not authorized to control Home Assistant.\nPlease add this number in the Lumi Whatsapp Web UI under *Authorized Numbers*.`
          : `🔒 *Access Denied:*\nCurrently no authorized phone numbers are whitelisted in Lumi Whatsapp.\nPlease open the Home Assistant Add-on Web UI and add your phone number under *Authorized Numbers* to enable smart home controls.`;
        return this._sendMessage(clientId, replyTarget, deniedMsg);
      }
      return this._startRemoteSession(clientId, phone, replyTarget);
    }

    // 4. Trigger: /cast
    if (rawText.toLowerCase() === '/cast') {
      if (!this._isAuthorized(clientId, phone, msg.senderJid)) {
        const config = this.configManager.getConfig();
        const hasWhitelisted = Array.isArray(config.authorizedNumbers) && config.authorizedNumbers.length > 0;
        const deniedMsg = hasWhitelisted
          ? `⛔ *Access Denied:*\nThis phone number / ID (+${phone}) is not authorized to broadcast to Home Assistant speakers.\nPlease add this number in the Lumi Whatsapp Web UI under *Authorized Numbers*.`
          : `🔒 *Access Denied:*\nCurrently no authorized phone numbers are whitelisted in Lumi Whatsapp.\nPlease open the Home Assistant Add-on Web UI and add your phone number under *Authorized Numbers* to enable audio broadcasting.`;
        return this._sendMessage(clientId, replyTarget, deniedMsg);
      }
      return this._startCastSession(clientId, phone, replyTarget);
    }

    // 5. Active Session Flow
    if (session) {
      if (session.type === 'remote') {
        return this._handleRemoteFlow(session, msg);
      }
      if (session.type === 'cast') {
        return this._handleCastFlow(session, msg);
      }
    }
  }

  // ==========================================
  // REMOTE CONTROL (/remote) FLOW
  // ==========================================

  async _startRemoteSession(clientId, phone, replyTarget = null) {
    const config = this.configManager.getConfig();
    const rooms = config.rooms || [];
    const target = replyTarget || phone;

    if (rooms.length === 0) {
      const noRoomsMsg = `⚠️ *No Rooms Configured:*\nPlease open the Lumi Whatsapp Web UI to add your rooms and devices under *Remote Builder*, or click *Load Demo Configuration* on the Dashboard to get started instantly.`;
      return this._sendMessage(clientId, target, noRoomsMsg);
    }

    const roomList = rooms
      .map((room, idx) => `${formatNum(idx + 1)} ${room.name}`)
      .join('\n');

    const prompt = `🏠 *LUMI SMART HOME REMOTE*\n━━━━━━━━━━━━━━━━━━━━━\nSelect a room by replying with its number:\n\n${roomList}\n\n─────────────────────\n💡 Reply with a room number (e.g. *1*) or */end* to exit.`;

    this._setSession(phone, {
      type: 'remote',
      state: 'ROOM_SELECT',
      clientId,
      replyTarget: target,
    });

    return this._sendMessage(clientId, target, prompt);
  }

  async _handleRemoteFlow(session, msg) {
    const phone = session.phone;
    const clientId = session.clientId;
    const rawText = String(msg.text || '').trim();
    const config = this.configManager.getConfig();
    const rooms = config.rooms || [];

    // State: Room Selection
    if (session.state === 'ROOM_SELECT') {
      const roomNum = parseInt(rawText, 10);
      if (isNaN(roomNum) || roomNum < 1 || roomNum > rooms.length) {
        const invalidRoomMsg = `⚠️ *Invalid Room Number:*\nPlease reply with a valid room number (e.g. *1* to *${rooms.length}*), or type */end* to exit.`;
        return this._sendMessage(clientId, phone, invalidRoomMsg);
      }

      const room = rooms[roomNum - 1];
      return this._showRoomDevices(session, room);
    }

    // State: Device Control inside a Room
    if (session.state === 'DEVICE_CONTROL') {
      // Check /back to return to room list
      if (rawText.toLowerCase() === '/back') {
        const roomList = rooms
          .map((room, idx) => `${formatNum(idx + 1)} ${room.name}`)
          .join('\n');
        const backPrompt = `↩️ *Returning to Room Selection:*\n\n${roomList}\n\n💡 Reply with a room number (e.g. *1*) or */end* to exit.`;

        this._setSession(phone, {
          ...session,
          state: 'ROOM_SELECT',
          currentRoomId: null,
        });
        return this._sendMessage(clientId, phone, backPrompt);
      }

      const room = rooms.find((r) => r.id === session.currentRoomId);
      if (!room) {
        return this._startRemoteSession(clientId, phone);
      }

      // Parse commands: on 1, ON-1, on-1, on 1,2,3, off 1, OFF-2, etc.
      const match = rawText.match(/^(on|off)[\s-]*([0-9,\s]+)$/i);
      if (!match) {
        const invalidCmdMsg = `⚠️ *Invalid Command!*\n\nPlease enter:\n• A valid device number and action (e.g. *on 1*, *off 2*, *on 1,2,3*)\n• */back* to return to the room list\n• */end* to exit`;
        return this._sendMessage(clientId, phone, invalidCmdMsg);
      }

      const action = match[1].toLowerCase(); // 'on' or 'off'
      const indices = match[2]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const devices = room.devices || [];
      const validTargets = [];
      const invalidIndices = [];

      for (const idx of indices) {
        if (idx >= 1 && idx <= devices.length) {
          validTargets.push(devices[idx - 1]);
        } else {
          invalidIndices.push(idx);
        }
      }

      if (validTargets.length === 0) {
        const errPrompt = `⚠️ *Invalid Device Number:*\nPlease select between 1 and ${devices.length} (e.g. *${action} 1* or *${action} 1,2*).`;
        return this._sendMessage(clientId, phone, errPrompt);
      }

      // Execute action for each target device
      for (const dev of validTargets) {
        if (action === 'on') {
          await this.haClient.turnOn(dev.entityId);
        } else {
          await this.haClient.turnOff(dev.entityId);
        }
      }

      // Format execution response
      let resultMsg = '';
      if (validTargets.length === 1) {
        resultMsg = `✅ *Action Executed:*\n• *${validTargets[0].name}*: turned *${action.toUpperCase()}*`;
      } else {
        const bullets = validTargets
          .map((d) => `• *${d.name}*: turned *${action.toUpperCase()}*`)
          .join('\n');
        resultMsg = `✅ *Batch Action Executed:*\n${bullets}`;
      }

      // Refresh timeout and stay in room
      this._setSession(phone, session);
      return this._sendMessage(clientId, phone, resultMsg);
    }
  }

  async _showRoomDevices(session, room) {
    const devices = room.devices || [];
    if (devices.length === 0) {
      const emptyMsg = `🛋️ *${room.name}*\n━━━━━━━━━━━━━━━━━━━━━\nNo devices configured in this room yet.\n\nType */back* to choose another room or */end* to exit.`;
      this._setSession(session.phone, {
        ...session,
        state: 'DEVICE_CONTROL',
        currentRoomId: room.id,
      });
      return this._sendMessage(session.clientId, session.phone, emptyMsg);
    }

    // Fetch live state for all devices in room
    const deviceLines = [];
    for (let i = 0; i < devices.length; i++) {
      const dev = devices[i];
      let stateStr = 'OFF';
      try {
        const st = await this.haClient.getEntityState(dev.entityId);
        if (st && (st.state === 'on' || st.state === 'playing' || st.state === 'open')) {
          stateStr = 'ON';
        }
      } catch {
        stateStr = 'OFF';
      }
      deviceLines.push(`${formatNum(i + 1)} ${dev.name}: *[${stateStr}]*`);
    }

    const prompt = `🛋️ *${room.name} Devices*\n━━━━━━━━━━━━━━━━━━━━━\n${deviceLines.join('\n')}\n\n─────────────────────\n⚡ *How to Control:*\n• Single device: *on 1* | *off 1* | *ON-1* | *off-1*\n• Multiple devices: *on 1,2,3* | *off 1,4*\n• Navigation: */back* (Rooms) | */end* (Exit)`;

    this._setSession(session.phone, {
      ...session,
      state: 'DEVICE_CONTROL',
      currentRoomId: room.id,
    });

    return this._sendMessage(session.clientId, session.phone, prompt);
  }

  // ==========================================
  // SPEAKER BROADCAST (/cast) FLOW
  // ==========================================

  async _startCastSession(clientId, phone, replyTarget = null) {
    const config = this.configManager.getConfig();
    const speakers = config.speakers || [];
    const target = replyTarget || phone;

    if (speakers.length === 0) {
      const noSpeakersMsg = `⚠️ *No Speakers Configured:*\nPlease open the Lumi Whatsapp Web UI to add your Home Assistant media_player speakers under *Speakers & Casting*, or click *Load Demo Configuration* on the Dashboard to get started instantly.`;
      return this._sendMessage(clientId, target, noSpeakersMsg);
    }

    const prompt = `🎙️ *LUMI SPEAKER BROADCAST / CAST*\n━━━━━━━━━━━━━━━━━━━━━\nPlease record a *Voice Note* or send an *Audio File* (.mp3, .ogg, .m4a) that you want to play on your smart home speakers.\n─────────────────────\n💡 *Instructions:*\n• Press & hold Mic on WhatsApp to record, then send.\n• Or attach an audio file.\n• Type */end* to exit.`;

    this._setSession(phone, {
      type: 'cast',
      state: 'WAITING_AUDIO',
      clientId,
      replyTarget: target,
    });

    return this._sendMessage(clientId, target, prompt);
  }

  async _handleCastFlow(session, msg) {
    const phone = session.phone;
    const clientId = session.clientId;
    const config = this.configManager.getConfig();
    const speakers = config.speakers || [];

    // State 1: Waiting for Audio/Voice note
    if (session.state === 'WAITING_AUDIO') {
      const isAudio = msg.messageType === 'voice_note' || msg.messageType === 'audio';

      if (!isAudio) {
        const audioReqMsg = `⚠️ *Audio Required:*\nPlease record a *Voice Note* (hold Mic) or upload an *audio file* to continue.\nOr type */end* to exit.`;
        return this._sendMessage(clientId, phone, audioReqMsg);
      }

      // Download audio buffer from Baileys or direct buffer
      let buffer = null;
      try {
        if (msg.mediaBuffer) {
          buffer = msg.mediaBuffer;
        } else if (msg.rawMessage) {
          const baileys = await getBaileys();
          const downloadFn = baileys.downloadMediaMessage || baileys.default?.downloadMediaMessage;
          if (typeof downloadFn === 'function') {
            buffer = await downloadFn(msg.rawMessage, 'buffer', {}, { logger: this.logger });
          } else {
            this.logger?.error('downloadMediaMessage is not available on Baileys export');
          }
        }
      } catch (err) {
        this.logger?.error({ err: err.message }, 'Failed to download WhatsApp audio message');
      }

      if (!buffer || buffer.length === 0) {
        const failMsg = `⚠️ *Audio Download Failed:*\nCould not process the audio file. Please try recording again or send a valid .mp3 / .ogg file.\nOr type */end* to exit.`;
        return this._sendMessage(clientId, phone, failMsg);
      }

      // Determine extension and file path
      const mime =
        msg.rawMessage?.message?.audioMessage?.mimetype ||
        msg.rawMessage?.message?.documentMessage?.mimetype ||
        'audio/ogg';
      let ext = '.ogg';
      if (mime.includes('mp4') || mime.includes('m4a')) ext = '.m4a';
      else if (mime.includes('mpeg') || mime.includes('mp3')) ext = '.mp3';

      const fileName = `cast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
      const filePath = path.join(this.castsDir, fileName);

      try {
        await fsp.writeFile(filePath, buffer);
      } catch (err) {
        this.logger?.error({ err: err.message, filePath }, 'Failed writing cast audio file to disk');
        const writeFailMsg = `⚠️ *Storage Error:*\nCould not save broadcast audio to disk. Please check add-on permissions.`;
        return this._sendMessage(clientId, phone, writeFailMsg);
      }

      // If saved in /config/www/whatsapp_casts, HA serves it at /local/whatsapp_casts/
      // Otherwise serve via add-on internal route /api/bot/casts/
      let publicUrl = `/local/whatsapp_casts/${fileName}`;
      if (!this.castsDir.includes('/config/www')) {
        publicUrl = `/api/bot/casts/${fileName}`;
      }

      // Prepare speaker list menu
      const speakerLines = speakers.map((spk, idx) => `${formatNum(idx + 1)} ${spk.name}`);
      const allSpeakersNum = speakers.length + 1;
      speakerLines.push(`${formatNum(allSpeakersNum)} 🔊 All Speakers (Whole House)`);

      const menuPrompt = `📢 *Audio Received! Select Speaker to Play:*\n━━━━━━━━━━━━━━━━━━━━━\n${speakerLines.join(
        '\n'
      )}\n─────────────────────\n⚡ *How to Play:*\n• Single speaker: *play 1* (or just *1*)\n• Multiple speakers: *play 1,2* (or *1,2*)\n• All speakers: *play all* (or *play ${allSpeakersNum}*)\n• Audio will play at each speaker's *current volume*.\n• Type */end* to exit.`;

      this._setSession(phone, {
        ...session,
        state: 'SPEAKER_SELECT',
        savedAudio: {
          filePath,
          publicUrl,
          fileName,
        },
      });

      return this._sendMessage(clientId, phone, menuPrompt);
    }

    // State 2: Speaker Selection & Broadcast Trigger
    if (session.state === 'SPEAKER_SELECT') {
      const rawText = String(msg.text || '').trim();
      const allSpeakersNum = speakers.length + 1;

      let selectedSpeakers = [];
      const cleanLower = rawText.toLowerCase().replace(/^play\s*/, '').trim();

      if (cleanLower === 'all' || cleanLower === String(allSpeakersNum)) {
        selectedSpeakers = [...speakers];
      } else {
        const parts = cleanLower.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        for (const p of parts) {
          if (p === allSpeakersNum) {
            selectedSpeakers = [...speakers];
            break;
          } else if (p >= 1 && p <= speakers.length) {
            selectedSpeakers.push(speakers[p - 1]);
          }
        }
      }

      if (selectedSpeakers.length === 0) {
        const invalidChoiceMsg = `⚠️ *Invalid Speaker Number:*\nPlease reply with a valid choice (e.g. *play 1*, *play 1,2*, *play all*), or type */end* to exit.`;
        return this._sendMessage(clientId, phone, invalidChoiceMsg);
      }

      // Play audio on all selected speakers (preserving current/last active volume!)
      const audioUrl = session.savedAudio?.publicUrl;
      for (const spk of selectedSpeakers) {
        try {
          await this.haClient.playMedia(spk.entityId, audioUrl, 'music');
        } catch (err) {
          this.logger?.warn({ err: err.message, speaker: spk }, 'Failed to trigger speaker playback');
        }
      }

      // Send confirmation
      let confirmMsg = '';
      if (selectedSpeakers.length === 1) {
        confirmMsg = `✅ *Broadcasting Announcement:*\n• Target: *${selectedSpeakers[0].name}*\n• Volume: *Current Speaker Volume*\n• Status: *Playing Now 📢*\n─────────────────────\n💡 Send */cast* anytime to broadcast another message, or */remote* to control devices.`;
      } else {
        const bullets = selectedSpeakers.map((s) => `  ✓ ${s.name}`).join('\n');
        confirmMsg = `✅ *Multi-Speaker Broadcast Active:*\n• Target Speakers:\n${bullets}\n• Volume: *Current Speaker Volume*\n• Status: *Playing Now 📢*`;
      }

      // Cast completed - terminate session
      this._destroySession(phone);
      return this._sendMessage(clientId, phone, confirmMsg);
    }
  }
}

module.exports = {
  InteractiveBot,
  SESSION_TIMEOUT_MS,
};
