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

const DEFAULT_TEMPLATES = {
  remoteGreeting: "LUMI SMART HOME REMOTE\nWelcome {{userName}}.\nSelect a room by replying with its number:\n\n{{roomList}}\n\n─────────────────────\nReply with a room number (e.g. 1) or '{{primaryEndTrigger}}' to exit.",
  deviceMenu: "{{roomName}} Devices\nUser: {{userName}}\n─────────────────────\n{{deviceList}}\n\n─────────────────────\nHow to Control:\n• Single device: on 1 | off 1 | ON-1 | off-1\n• Multiple devices: on 1,2,3 | off 1,2\n• Navigation: '{{primaryBackTrigger}}' (Rooms) | '{{primaryEndTrigger}}' (Exit)",
  actionResult: "{{roomName}}\nUpdated by {{userName}}:\n─────────────────────\n{{results}}\n\n─────────────────────\nControl more devices, '{{primaryBackTrigger}}' for rooms, or '{{primaryEndTrigger}}' to exit.",
  castGreeting: "LUMI SPEAKER BROADCAST\nHello {{userName}}.\nPlease record a Voice Note or send an Audio File (.mp3, .ogg, .m4a) to play on your smart home speakers.\n─────────────────────\nType '{{primaryEndTrigger}}' to exit.",
  castSelectSpeaker: "Audio Received! Select Speaker:\nUser: {{userName}}\n─────────────────────\n{{speakerList}}\n\n─────────────────────\nHow to Play:\n• Single: 1 (or play 1)\n• Multiple: 1,2 (or play 1,2)\n• All speakers: play all\n• Audio plays at speaker's current volume.\n• Type '{{primaryEndTrigger}}' to exit.",
  castSuccess: "Broadcast Active:\nTarget: {{speakerName}}\nRequested by: {{userName}}\nVolume: Current Speaker Volume\nStatus: Playing Now",
  accessDenied: "Access Denied:\nWhatsApp ID / Phone (+{{userPhone}}) is not authorized.\n\nTo authorize:\n1. Open Lumi Whatsapp Web UI > Authorized Numbers\n2. Add {{userPhone}}",
  sessionEnded: "Session Ended.\nThank you {{userName}}! Send '{{primaryRemoteTrigger}}' anytime to control devices.",
  helpText: "Lumi Remote Commands:\n• {{primaryRemoteTrigger}} - Open main smart home menu\n• 1, 2, 3... - Select room number\n• on 1 / off 1 - Toggle device #1\n• on 1,2,3 / off 1,2,3 - Toggle multiple\n• {{primaryBackTrigger}} - Go back to room list\n• {{primaryEndTrigger}} - Exit remote session",
  noRooms: "No Rooms Configured:\nPlease open the Lumi Whatsapp Web UI and add rooms and devices under Remote Builder.",
  noSpeakers: "No Speakers Configured:\nPlease open the Lumi Whatsapp Web UI and add speakers under Speakers & Casting.",
  invalidChoice: "Invalid choice.\nPlease reply with a valid number, '{{primaryBackTrigger}}' for rooms, or '{{primaryEndTrigger}}' to exit.",
  invalidAudio: "Audio Required:\nPlease record a voice note or upload an audio file to continue, or type '{{primaryEndTrigger}}' to exit.",
};

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

  _getSettings() {
    return (
      this.configManager?.getSettings?.() || {
        remoteTriggers: ['remote', 'lumi', 'control', '/remote'],
        castTriggers: ['cast', 'broadcast', 'speak', '/cast'],
        endTriggers: ['end', 'exit', '/end', 'stop', 'quit', 'close'],
        backTriggers: ['back', '/back', 'rooms', 'menu'],
        helpTriggers: ['help', '/help', 'info', 'commands'],
        enableEmojis: false,
        includeUserName: true,
        templates: DEFAULT_TEMPLATES,
      }
    );
  }

  _matchesTrigger(text, triggers = []) {
    if (!text || !Array.isArray(triggers)) return false;
    const clean = text.trim().toLowerCase();
    return triggers.some((tr) => {
      const cleanTr = String(tr || '').trim().toLowerCase();
      if (!cleanTr) return false;
      return clean === cleanTr || clean === `/${cleanTr}` || `/${clean}` === cleanTr;
    });
  }

  _getUserName(clientId, phone, senderJid) {
    const entry = this.configManager?.getAuthorizedEntry?.(phone, senderJid);
    if (entry && entry.name) {
      return entry.name;
    }
    const conn =
      this.messageManager?.sessionManager?.getConnection?.(clientId) ||
      this.messageManager?.sessionManager?.accounts?.get?.(clientId);
    if (conn?.sock?.user?.name) {
      return conn.sock.user.name;
    }
    return phone || 'User';
  }

  _formatNum(num, enableEmojis = false) {
    if (enableEmojis) {
      const emojiDigits = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
      const str = String(num);
      if (num >= 0 && num <= 9) return emojiDigits[num];
      return str.split('').map((d) => emojiDigits[Number(d)] || d).join('');
    }
    return `${num}.`;
  }

  _stripEmojis(text) {
    if (!text) return '';
    return text
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu, '')
      .replace(/^[ \t]+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _render(templateKey, vars = {}) {
    const settings = this._getSettings();
    const rawTpl = settings.templates?.[templateKey] || DEFAULT_TEMPLATES[templateKey] || '';
    const primaryRemote = settings.remoteTriggers?.[0] || 'remote';
    const primaryCast = settings.castTriggers?.[0] || 'cast';
    const primaryEnd = settings.endTriggers?.[0] || 'end';
    const primaryBack = settings.backTriggers?.[0] || 'back';

    const allVars = {
      primaryRemoteTrigger: primaryRemote,
      primaryCastTrigger: primaryCast,
      primaryEndTrigger: primaryEnd,
      primaryBackTrigger: primaryBack,
      ...vars,
    };

    let result = rawTpl;
    for (const [k, v] of Object.entries(allVars)) {
      const regex = new RegExp(`{{\\s*${k}\\s*}}`, 'g');
      result = result.replace(regex, v !== undefined && v !== null ? String(v) : '');
    }

    if (!settings.enableEmojis) {
      result = this._stripEmojis(result);
    }
    return result;
  }

  async _sendMessage(clientId, to, text) {
    try {
      const session = this.sessions.get(to);
      const targetJid = session?.replyTarget || to;
      const settings = this._getSettings();
      const finalText = settings.enableEmojis ? text : this._stripEmojis(text);

      if (typeof this.messageManager?.sendText === 'function') {
        return await this.messageManager.sendText({
          clientId,
          to: targetJid,
          body: finalText,
        });
      }
      if (typeof this.messageManager?.sendMessage === 'function') {
        return await this.messageManager.sendMessage({
          clientId,
          to: targetJid,
          messageType: 'text',
          text: finalText,
          body: finalText,
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
    const userName = session.userName || phone;
    const settings = this._getSettings();
    if (session.type === 'remote') {
      const msg = `Session Timed Out:\nHello ${userName}, your remote session has ended due to 5 minutes of inactivity.\nSend '${settings.remoteTriggers?.[0] || 'remote'}' to start a new session.`;
      await this._sendMessage(session.clientId, target, msg);
    } else if (session.type === 'cast') {
      const msg = `Cast Session Timed Out:\nHello ${userName}, your broadcast session has ended due to 5 minutes of inactivity.\nSend '${settings.castTriggers?.[0] || 'cast'}' whenever you are ready.`;
      await this._sendMessage(session.clientId, target, msg);
    }
  }

  async _isAuthorized(clientId, phone, senderJid) {
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
      const rawOwnerLid = conn.lid || conn.sock?.user?.lid || conn.sock?.authState?.creds?.me?.lid;
      const ownerLid = rawOwnerLid ? String(rawOwnerLid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null;
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

      // If sender is an @lid and not yet matched, dynamically resolve unmapped authorized numbers using onWhatsApp
      if (senderJid && senderJid.endsWith('@lid') && conn.sock && typeof conn.sock.onWhatsApp === 'function') {
        const config = this.configManager.getConfig();
        const unmapped = (config.authorizedNumbers || []).filter((item) => !item.lid && item.phone);
        for (const item of unmapped) {
          try {
            const results = await conn.sock.onWhatsApp(item.phone);
            if (Array.isArray(results) && results[0]?.lid) {
              const resLid = results[0].lid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
              item.lid = resLid;
              await this.configManager.save();
              if (resLid === cleanJid || resLid === cleanPhone) {
                return true;
              }
            }
          } catch {
            // USync query failed, continue
          }
        }
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
    const settings = this._getSettings();
    const userName = this._getUserName(clientId, phone, senderJid);

    // 1. Explicit Session Termination (matches endTriggers: /end, end, exit, stop, etc.)
    if (this._matchesTrigger(rawText, settings.endTriggers)) {
      if (session) {
        const target = session.replyTarget || replyTarget;
        this._destroySession(phone);
        const exitMsg = this._render('sessionEnded', { userName, userPhone: phone });
        return this._sendMessage(clientId, target, exitMsg);
      } else {
        return this._sendMessage(
          clientId,
          replyTarget,
          this._render('sessionEnded', { userName, userPhone: phone })
        );
      }
    }

    // 2. Global Help command (matches helpTriggers: /help, help, info, etc.)
    if (this._matchesTrigger(rawText, settings.helpTriggers)) {
      const helpMsg = this._render('helpText', { userName, userPhone: phone });
      return this._sendMessage(clientId, session?.replyTarget || replyTarget, helpMsg);
    }

    // 3. Trigger: Remote (matches remoteTriggers: remote, lumi, control, /remote, etc.)
    if (this._matchesTrigger(rawText, settings.remoteTriggers)) {
      if (!(await this._isAuthorized(clientId, phone, msg.senderJid))) {
        this.configManager.recordDeniedAttempt?.(phone || msg.senderJid, { senderName: msg.senderName });
        const deniedMsg = this._render('accessDenied', { userPhone: phone, userName });
        return this._sendMessage(clientId, replyTarget, deniedMsg);
      }
      return this._startRemoteSession(clientId, phone, replyTarget);
    }

    // 4. Trigger: Cast (matches castTriggers: cast, broadcast, speak, /cast, etc.)
    if (this._matchesTrigger(rawText, settings.castTriggers)) {
      if (!(await this._isAuthorized(clientId, phone, msg.senderJid))) {
        this.configManager.recordDeniedAttempt?.(phone || msg.senderJid, { senderName: msg.senderName });
        const deniedMsg = this._render('accessDenied', { userPhone: phone, userName });
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
  // REMOTE CONTROL FLOW
  // ==========================================

  async _startRemoteSession(clientId, phone, replyTarget = null) {
    const config = this.configManager.getConfig();
    const rooms = config.rooms || [];
    const target = replyTarget || phone;
    const settings = this._getSettings();
    const userName = this._getUserName(clientId, phone, target);

    if (rooms.length === 0) {
      const noRoomsMsg = this._render('noRooms', { userName, userPhone: phone });
      return this._sendMessage(clientId, target, noRoomsMsg);
    }

    const roomList = rooms
      .map((room, idx) => `${this._formatNum(idx + 1, settings.enableEmojis)} ${room.name}`)
      .join('\n');

    const prompt = this._render('remoteGreeting', {
      userName,
      userPhone: phone,
      roomList,
    });

    this._setSession(phone, {
      type: 'remote',
      state: 'ROOM_SELECT',
      clientId,
      replyTarget: target,
      userName,
    });

    return this._sendMessage(clientId, target, prompt);
  }

  async _handleRemoteFlow(session, msg) {
    const phone = session.phone;
    const clientId = session.clientId;
    const rawText = String(msg.text || '').trim();
    const config = this.configManager.getConfig();
    const rooms = config.rooms || [];
    const settings = this._getSettings();
    const userName = session.userName || this._getUserName(clientId, phone, session.replyTarget);

    // State: Room Selection
    if (session.state === 'ROOM_SELECT') {
      const roomNum = parseInt(rawText, 10);
      if (isNaN(roomNum) || roomNum < 1 || roomNum > rooms.length) {
        const invalidRoomMsg = this._render('invalidChoice', { userName });
        return this._sendMessage(clientId, phone, invalidRoomMsg);
      }

      const room = rooms[roomNum - 1];
      return this._showRoomDevices(session, room);
    }

    // State: Device Control inside a Room
    if (session.state === 'DEVICE_CONTROL') {
      // Check back triggers to return to room list
      if (this._matchesTrigger(rawText, settings.backTriggers)) {
        const roomList = rooms
          .map((room, idx) => `${this._formatNum(idx + 1, settings.enableEmojis)} ${room.name}`)
          .join('\n');
        const backPrompt = this._render('remoteGreeting', {
          userName,
          userPhone: phone,
          roomList,
        });

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
        const invalidCmdMsg = this._render('invalidChoice', { userName });
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
        const errPrompt = `Invalid Device Number: Please select between 1 and ${devices.length} (e.g. ${action} 1 or ${action} 1,2).`;
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
      let resultsText = '';
      if (validTargets.length === 1) {
        resultsText = `• ${validTargets[0].name}: turned ${action.toUpperCase()}`;
      } else {
        resultsText = validTargets
          .map((d) => `• ${d.name}: turned ${action.toUpperCase()}`)
          .join('\n');
      }

      const resultMsg = this._render('actionResult', {
        userName,
        roomName: room.name,
        results: resultsText,
      });

      // Refresh timeout and stay in room
      this._setSession(phone, session);
      return this._sendMessage(clientId, phone, resultMsg);
    }
  }

  async _showRoomDevices(session, room) {
    const devices = room.devices || [];
    const settings = this._getSettings();
    const userName = session.userName || this._getUserName(session.clientId, session.phone, session.replyTarget);

    if (devices.length === 0) {
      const emptyMsg = `${room.name}\nNo devices configured in this room yet.\nReply '${settings.backTriggers?.[0] || 'back'}' for rooms or '${settings.endTriggers?.[0] || 'end'}' to exit.`;
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
      deviceLines.push(`${this._formatNum(i + 1, settings.enableEmojis)} ${dev.name} [${stateStr}]`);
    }

    const prompt = this._render('deviceMenu', {
      userName,
      roomName: room.name,
      deviceList: deviceLines.join('\n'),
    });

    this._setSession(session.phone, {
      ...session,
      state: 'DEVICE_CONTROL',
      currentRoomId: room.id,
    });

    return this._sendMessage(session.clientId, session.phone, prompt);
  }

  // ==========================================
  // SPEAKER BROADCAST FLOW
  // ==========================================

  async _startCastSession(clientId, phone, replyTarget = null) {
    const config = this.configManager.getConfig();
    const speakers = config.speakers || [];
    const target = replyTarget || phone;
    const userName = this._getUserName(clientId, phone, target);

    if (speakers.length === 0) {
      const noSpeakersMsg = this._render('noSpeakers', { userName, userPhone: phone });
      return this._sendMessage(clientId, target, noSpeakersMsg);
    }

    const prompt = this._render('castGreeting', {
      userName,
      userPhone: phone,
    });

    this._setSession(phone, {
      type: 'cast',
      state: 'WAITING_AUDIO',
      clientId,
      replyTarget: target,
      userName,
    });

    return this._sendMessage(clientId, target, prompt);
  }

  async _handleCastFlow(session, msg) {
    const phone = session.phone;
    const clientId = session.clientId;
    const config = this.configManager.getConfig();
    const speakers = config.speakers || [];
    const settings = this._getSettings();
    const target = session.replyTarget || msg.senderJid || phone;
    const userName = session.userName || this._getUserName(clientId, phone, target);

    // State 1: Waiting for Audio/Voice note
    if (session.state === 'WAITING_AUDIO') {
      const isAudio = msg.messageType === 'voice_note' || msg.messageType === 'audio';

      if (!isAudio) {
        const audioReqMsg = this._render('invalidAudio', { userName });
        return this._sendMessage(clientId, target, audioReqMsg);
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
        const failMsg = `Audio Download Failed: Could not process the audio file. Please try recording again or send a valid .mp3 / .ogg file, or type '${settings.endTriggers?.[0] || 'end'}' to exit.`;
        return this._sendMessage(clientId, target, failMsg);
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
        const writeFailMsg = `Storage Error: Could not save broadcast audio to disk. Please check add-on permissions.`;
        return this._sendMessage(clientId, target, writeFailMsg);
      }

      let publicUrl = `/local/whatsapp_casts/${fileName}`;
      if (!this.castsDir.includes('/config/www')) {
        publicUrl = `/api/bot/casts/${fileName}`;
      }

      // Prepare speaker list menu
      const speakerLines = speakers.map((spk, idx) => `${this._formatNum(idx + 1, settings.enableEmojis)} ${spk.name}`);
      const allSpeakersNum = speakers.length + 1;
      speakerLines.push(`${this._formatNum(allSpeakersNum, settings.enableEmojis)} All Speakers (Whole House)`);

      const menuPrompt = this._render('castSelectSpeaker', {
        userName,
        speakerList: speakerLines.join('\n'),
      });

      this._setSession(phone, {
        ...session,
        state: 'SPEAKER_SELECT',
        replyTarget: target,
        savedAudio: {
          filePath,
          publicUrl,
          fileName,
        },
      });

      return this._sendMessage(clientId, target, menuPrompt);
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
        const invalidChoiceMsg = this._render('invalidChoice', { userName });
        return this._sendMessage(clientId, target, invalidChoiceMsg);
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
      const targetNames = selectedSpeakers.map((s) => s.name).join(', ');
      const confirmMsg = this._render('castSuccess', {
        userName,
        speakerName: targetNames,
      });

      // Cast completed - terminate session
      this._destroySession(phone);
      return this._sendMessage(clientId, target, confirmMsg);
    }
  }
}

module.exports = {
  InteractiveBot,
  SESSION_TIMEOUT_MS,
};
