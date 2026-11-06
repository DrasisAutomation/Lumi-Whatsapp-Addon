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
  deviceMenu: "{{roomName}} Devices\nUser: {{userName}}\n─────────────────────\n{{deviceList}}\n\n─────────────────────\nHow to Control:\n• On / Off: on 1 | off 1 | ON-1\n• Curtains: open 1 | close 1 | stop 1 | 1 50%\n• Smart Locks: lock 1 | unlock 1\n• Brightness & Color: dim 1 40% | color 1 blue | warm 1\n• AC & Climate: temp 1 24 | cool 22\n• Live Status: type 'status' anytime\n• Or reply with device number (e.g. 1) for detailed controls!\n• Navigation: '{{primaryBackTrigger}}' (Rooms) | '{{primaryEndTrigger}}' (Exit)",
  deviceSubmenu: "{{deviceName}} [{{deviceStatus}}]\nRoom: {{roomName}}\n─────────────────────\nControls for this device:\n{{controlHints}}\n\n─────────────────────\nReply with an action above, '{{primaryBackTrigger}}' for room devices, or '{{primaryEndTrigger}}' to exit.",
  actionResult: "{{roomName}}\nUpdated by {{userName}}:\n─────────────────────\n{{results}}\n\n─────────────────────\nControl more devices, '{{primaryBackTrigger}}' for rooms, or '{{primaryEndTrigger}}' to exit.",
  statusReport: "LUMI HOME STATUS\nUser: {{userName}}\n─────────────────────\n{{statusSummary}}\n\n─────────────────────\nSend '{{primaryRemoteTrigger}}' for controls or '{{primaryCastTrigger}}' to broadcast.",
  noDevicesStatus: "LUMI HOME STATUS\nHello {{userName}}.\nNo devices configured yet.\nPlease configure rooms and devices in the Lumi Remote Builder.",
  castGreeting: "LUMI SPEAKER BROADCAST\nHello {{userName}}.\nPlease record a Voice Note or send an Audio File (.mp3, .ogg, .m4a) to play on your smart home speakers.\n─────────────────────\nType '{{primaryEndTrigger}}' to exit.",
  castSelectSpeaker: "Audio Received! Select Speaker:\nUser: {{userName}}\n─────────────────────\n{{speakerList}}\n\n─────────────────────\nHow to Play:\n• Single: 1 (or play 1, play-1)\n• Multiple: 1,2 (or play 1,2, play-1,2,4)\n• All speakers: play all (or all)\n• Audio plays at speaker's current volume.\n• Type '{{primaryEndTrigger}}' to exit.",
  castSuccess: "Broadcast Active:\nTarget: {{speakerName}}\nRequested by: {{userName}}\nVolume: Current Speaker Volume\nStatus: Playing Now",
  accessDenied: "Access Denied:\nWhatsApp ID / Phone (+{{userPhone}}) is not authorized.\n\nTo authorize:\n1. Open Lumi Whatsapp Web UI > Authorized Numbers\n2. Add {{userPhone}}",
  sessionEnded: "Session Ended.\nThank you {{userName}}! Send '{{primaryRemoteTrigger}}' anytime to control devices.",
  helpText: "Lumi Remote Commands:\n• {{primaryRemoteTrigger}} - Open main smart home remote\n• status - View live status of all devices & sensors\n• 1, 2, 3... - Select room number\n• on 1 / off 1 - Toggle device #1\n• lock 1 / unlock 1 - Lock/unlock smart door lock\n• open 1 / close 1 - Open/close curtain\n• dim 1 30% / color 1 blue - Adjust lights\n• {{primaryBackTrigger}} - Go back to room list\n• {{primaryEndTrigger}} - Exit remote session",
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

    // 4.5. Trigger: Status (matches statusTriggers: status, /status, state, /state, etc.)
    const statusTriggers = settings.statusTriggers || ['status', '/status', 'state', '/state'];
    if (this._matchesTrigger(rawText, statusTriggers)) {
      if (!(await this._isAuthorized(clientId, phone, msg.senderJid))) {
        this.configManager.recordDeniedAttempt?.(phone || msg.senderJid, { senderName: msg.senderName });
        const deniedMsg = this._render('accessDenied', { userPhone: phone, userName });
        return this._sendMessage(clientId, replyTarget, deniedMsg);
      }
      return this._handleStatusCommand(clientId, phone, session?.replyTarget || replyTarget);
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

    // State: Device Submenu (Drill-down parameter control for a single device)
    if (session.state === 'DEVICE_SUBMENU') {
      const room = rooms.find((r) => r.id === session.currentRoomId);
      if (!room) {
        return this._startRemoteSession(clientId, phone);
      }

      // Back trigger returns to device list for this room
      if (this._matchesTrigger(rawText, settings.backTriggers)) {
        return this._showRoomDevices(session, room);
      }

      const dev = (room.devices || []).find((d) => d.entityId === session.selectedDeviceId);
      if (!dev) {
        return this._showRoomDevices(session, room);
      }

      const action = this._parseSubmenuCommand(rawText, dev);
      if (!action) {
        const invalidCmdMsg = this._render('invalidChoice', { userName });
        return this._sendMessage(clientId, phone, invalidCmdMsg);
      }

      const resText = await this._executeParsedAction(dev, action);
      const resultMsg = `${room.name}\nUpdated by ${userName}:\n─────────────────────\n• ${resText}\n\n─────────────────────\nControl more devices, '${settings.backTriggers?.[0] || 'back'}' for rooms, or '${settings.endTriggers?.[0] || 'end'}' to exit.`;

      this._setSession(phone, session);
      return this._sendMessage(clientId, phone, resultMsg);
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
          selectedDeviceId: null,
        });
        return this._sendMessage(clientId, phone, backPrompt);
      }

      const room = rooms.find((r) => r.id === session.currentRoomId);
      if (!room) {
        return this._startRemoteSession(clientId, phone);
      }

      const devices = room.devices || [];

      // 1. Drill-down check: single number e.g. "1" or "#1"
      const singleNumMatch = rawText.match(/^#?([0-9]+)$/);
      if (singleNumMatch) {
        const idx = parseInt(singleNumMatch[1], 10);
        if (idx >= 1 && idx <= devices.length) {
          return this._showDeviceSubmenu(session, room, devices[idx - 1]);
        }
      }

      // Check status triggers inside room
      const statusTriggers = settings.statusTriggers || ['status', '/status', 'state', '/state'];
      if (this._matchesTrigger(rawText, statusTriggers)) {
        return this._handleStatusCommand(clientId, phone, session.replyTarget || phone);
      }

      // 2. Parse commands (on/off, open/close, dim/bright, color, temp, etc.)
      const parsed = this._parseDeviceCommand(rawText, devices);
      if (!parsed) {
        const invalidCmdMsg = this._render('invalidChoice', { userName });
        return this._sendMessage(clientId, phone, invalidCmdMsg);
      }

      let resultsText = '';

      if (parsed.kind === 'multi_power') {
        for (const dev of parsed.devices) {
          if (parsed.action === 'on') {
            await this.haClient.turnOn(dev.entityId);
          } else {
            await this.haClient.turnOff(dev.entityId);
          }
        }
        resultsText = parsed.devices
          .map((d) => `• ${d.name}: turned ${parsed.action.toUpperCase()}`)
          .join('\n');
      } else if (parsed.kind === 'lock_multi') {
        for (const dev of parsed.devices) {
          if (parsed.action === 'lock') {
            if (typeof this.haClient.lock === 'function') {
              await this.haClient.lock(dev.entityId);
            } else {
              await this.haClient.callService('lock', 'lock', { entity_id: dev.entityId });
            }
          } else {
            if (typeof this.haClient.unlock === 'function') {
              await this.haClient.unlock(dev.entityId);
            } else {
              await this.haClient.callService('lock', 'unlock', { entity_id: dev.entityId });
            }
          }
        }
        resultsText = parsed.devices
          .map((d) => `• ${d.name}: ${parsed.action === 'lock' ? 'LOCKED' : 'UNLOCKED'}`)
          .join('\n');
      } else if (parsed.kind === 'cover_multi') {
        const cmdUpper = parsed.cmd.toUpperCase();
        for (const dev of parsed.devices) {
          if (parsed.cmd === 'open') {
            if (typeof this.haClient.openCover === 'function') {
              await this.haClient.openCover(dev.entityId);
            } else {
              await this.haClient.turnOn(dev.entityId);
            }
          } else if (parsed.cmd === 'close') {
            if (typeof this.haClient.closeCover === 'function') {
              await this.haClient.closeCover(dev.entityId);
            } else {
              await this.haClient.turnOff(dev.entityId);
            }
          } else {
            if (typeof this.haClient.stopCover === 'function') {
              await this.haClient.stopCover(dev.entityId);
            }
          }
        }
        resultsText = parsed.devices
          .map((d) => `• ${d.name}: ${cmdUpper === 'OPEN' ? 'opened' : (cmdUpper === 'CLOSE' ? 'closed' : 'stopped')}`)
          .join('\n');
      } else if (parsed.kind === 'single_action') {
        const res = await this._executeParsedAction(parsed.device, parsed.action);
        resultsText = `• ${res}`;
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

  async _handleStatusCommand(clientId, phone, replyTarget = null) {
    const config = this.configManager.getConfig();
    const rooms = config.rooms || [];
    const target = replyTarget || phone;
    const settings = this._getSettings();
    const userName = this._getUserName(clientId, phone, target);

    let totalDevices = 0;
    const roomBlocks = [];

    for (let rIdx = 0; rIdx < rooms.length; rIdx++) {
      const room = rooms[rIdx];
      const devices = room.devices || [];
      if (devices.length === 0) continue;

      const deviceLines = [];
      for (let dIdx = 0; dIdx < devices.length; dIdx++) {
        totalDevices++;
        const dev = devices[dIdx];
        let stateStr = 'OFF';
        try {
          const st = await this.haClient.getEntityState(dev.entityId);
          stateStr = this._formatDeviceState(dev, st);
        } catch {
          stateStr = 'OFF';
        }
        deviceLines.push(`  • ${dev.name}: [${stateStr}]`);
      }

      if (deviceLines.length > 0) {
        roomBlocks.push(`${room.name}:\n${deviceLines.join('\n')}`);
      }
    }

    if (totalDevices === 0) {
      const emptyMsg = this._render('noDevicesStatus', { userName, userPhone: phone });
      return this._sendMessage(clientId, target, emptyMsg);
    }

    const summaryText = roomBlocks.join('\n\n');
    const msg = this._render('statusReport', {
      userName,
      userPhone: phone,
      statusSummary: summaryText,
    });

    return this._sendMessage(clientId, target, msg);
  }

  _formatDeviceState(dev, st) {
    if (!st || st.state === 'unavailable' || st.state === 'unknown') {
      return 'OFF';
    }
    const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');
    const rawState = String(st.state || '').toLowerCase();
    const attrs = st.attributes || {};

    // 1. Smart Locks
    if (domain === 'lock') {
      if (rawState === 'locked') return 'Locked';
      if (rawState === 'unlocked') return 'Unlocked';
      if (rawState === 'locking') return 'Locking...';
      if (rawState === 'unlocking') return 'Unlocking...';
      if (rawState === 'jammed') return 'JAMMED';
      return rawState.toUpperCase();
    }

    // 2. Binary Sensors (Door, Window, Motion, Smoke, Moisture, etc.)
    if (domain === 'binary_sensor') {
      const dc = String(attrs.device_class || '').toLowerCase();
      const isOn = rawState === 'on';
      if (['door', 'window', 'garage_door', 'opening'].includes(dc)) {
        return isOn ? 'Open' : 'Closed';
      }
      if (['motion', 'occupancy', 'presence'].includes(dc)) {
        return isOn ? 'Motion' : 'Clear';
      }
      if (['smoke', 'gas', 'carbon_monoxide', 'problem', 'safety', 'tamper'].includes(dc)) {
        return isOn ? 'ALERT' : 'Normal';
      }
      if (['moisture'].includes(dc)) {
        return isOn ? 'Wet / Leak' : 'Dry';
      }
      if (['lock'].includes(dc)) {
        return isOn ? 'Unlocked' : 'Locked';
      }
      return isOn ? 'ON' : 'OFF';
    }

    // 3. Environmental & Value Sensors
    if (domain === 'sensor') {
      const unit = attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : '';
      return `${st.state}${unit}`;
    }

    // 4. Curtains / Covers
    if (domain === 'cover') {
      if (attrs.current_position !== undefined && attrs.current_position !== null) {
        const pos = Math.round(Number(attrs.current_position));
        if (pos === 0) return 'Closed';
        return `Open - ${pos}%`;
      }
      return rawState === 'open' ? 'Open' : (rawState === 'closed' ? 'Closed' : rawState.toUpperCase());
    }

    // 5. Lights
    if (domain === 'light') {
      if (rawState === 'on') {
        if (attrs.brightness !== undefined && attrs.brightness !== null) {
          const pct = Math.max(1, Math.min(100, Math.round((Number(attrs.brightness) / 255) * 100)));
          return `ON - ${pct}%`;
        }
        return 'ON';
      }
      return 'OFF';
    }

    // 6. Climate / AC
    if (domain === 'climate') {
      if (rawState === 'off') {
        return 'OFF';
      }
      const mode = rawState.toUpperCase();
      const targetTemp = attrs.temperature !== undefined && attrs.temperature !== null ? `${attrs.temperature}°C` : '';
      return targetTemp ? `${mode} - ${targetTemp}` : mode;
    }

    // 7. Media Players
    if (domain === 'media_player') {
      return rawState.toUpperCase();
    }

    // 8. Scenes & Scripts
    if (['scene', 'script', 'automation'].includes(domain)) {
      return rawState === 'on' ? 'ACTIVE' : 'READY';
    }

    if (rawState === 'on' || rawState === 'playing') return 'ON';
    return 'OFF';
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
        stateStr = this._formatDeviceState(dev, st);
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
      selectedDeviceId: null,
    });

    return this._sendMessage(session.clientId, session.phone, prompt);
  }

  async _showDeviceSubmenu(session, room, dev) {
    const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');
    let st = null;
    try {
      st = await this.haClient.getEntityState(dev.entityId);
    } catch {
      st = null;
    }
    const deviceStatus = this._formatDeviceState(dev, st);
    const settings = this._getSettings();
    const userName = session.userName || this._getUserName(session.clientId, session.phone, session.replyTarget);

    let controlHints = '';
    if (domain === 'lock') {
      controlHints =
`• Lock: 'lock' | 'on'
• Unlock: 'unlock' | 'off'
• Status: 'status'`;
    } else if (domain === 'sensor' || domain === 'binary_sensor') {
      controlHints =
`• Sensor Monitor (Read-Only)
• Current Live Reading: [${deviceStatus}]
• Entity ID: ${dev.entityId}
• Send 'status' for all devices, or '${settings.backTriggers?.[0] || 'back'}' for room menu.`;
    } else if (domain === 'cover') {
      controlHints =
`• Open: 'open' | 'open 100%'
• Close: 'close' | 'close 0%'
• Stop: 'stop'
• Set Position: '50%' | 'pos 50%' | '25%'`;
    } else if (domain === 'light') {
      controlHints =
`• Power: 'on' | 'off'
• Brightness: '30%' | 'dim 20%' | 'bright 80%'
• Color: 'red' | 'blue' | 'green' | 'warm' | 'cool' | 'white'
• Color Temp: 'temp 3000k' | '2700k'`;
    } else if (domain === 'climate') {
      controlHints =
`• Power: 'on' | 'off'
• Set Temp: '24' | 'temp 24' | '22.5'
• Mode: 'cool' | 'heat' | 'fan' | 'auto'
• Quick combo: 'cool 22' | 'heat 25'`;
    } else if (['scene', 'script', 'automation'].includes(domain)) {
      controlHints =
`• Run: 'activate' | 'run' | 'on'
• Trigger: 'trigger'`;
    } else {
      controlHints =
`• Power: 'on' | 'off'
• Toggle: 'toggle'`;
    }

    const prompt = this._render('deviceSubmenu', {
      userName,
      roomName: room.name,
      deviceName: dev.name,
      deviceStatus,
      controlHints,
    });

    this._setSession(session.phone, {
      ...session,
      state: 'DEVICE_SUBMENU',
      currentRoomId: room.id,
      selectedDeviceId: dev.entityId,
      selectedDeviceName: dev.name,
    });

    return this._sendMessage(session.clientId, session.phone, prompt);
  }

  _parseDeviceCommand(rawText, devices = []) {
    if (!rawText || !devices.length) return null;
    const text = rawText.trim();

    // 1. Check Standard On / Off (single or multi): on 1, off 1, ON-1, on 1,2,3, off 1,2
    const onOffMatch = text.match(/^(on|off)[\s-]*([0-9,\s]+)$/i);
    if (onOffMatch) {
      const action = onOffMatch[1].toLowerCase();
      const indices = onOffMatch[2]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const validTargets = [];
      for (const idx of indices) {
        if (idx >= 1 && idx <= devices.length) {
          validTargets.push(devices[idx - 1]);
        }
      }
      if (validTargets.length > 0) {
        return {
          kind: 'multi_power',
          action,
          devices: validTargets,
        };
      }
    }

    // 1b. Smart Locks: lock 1, unlock 1, lock-1, unlock-1, lock 1,2, unlock 1,2
    const lockMatch = text.match(/^(lock|unlock)[\s-]*([0-9,\s]+)$/i);
    if (lockMatch) {
      const action = lockMatch[1].toLowerCase();
      const indices = lockMatch[2]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const validTargets = [];
      for (const idx of indices) {
        if (idx >= 1 && idx <= devices.length) {
          validTargets.push(devices[idx - 1]);
        }
      }
      if (validTargets.length > 0) {
        return {
          kind: 'lock_multi',
          action,
          devices: validTargets,
        };
      }
    }

    // 2. Open / Close / Stop (Curtains / Covers)
    // e.g. open 1, close 1, stop 1, open-1, close-2, open 1,2, close 1,2
    const coverBasicMatch = text.match(/^(open|close|stop)[\s-]*([0-9,\s]+)$/i);
    if (coverBasicMatch) {
      const cmd = coverBasicMatch[1].toLowerCase();
      const indices = coverBasicMatch[2]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const validTargets = [];
      for (const idx of indices) {
        if (idx >= 1 && idx <= devices.length) {
          validTargets.push(devices[idx - 1]);
        }
      }
      if (validTargets.length > 0) {
        return {
          kind: 'cover_multi',
          cmd, // 'open' | 'close' | 'stop'
          devices: validTargets,
        };
      }
    }

    // 3. Cover Position: open 1 50%, pos 1 50%, pos-1 50%, position 1 50%, curtain 1 50%, curtain-1 50%
    const coverPosMatch = text.match(/^(?:pos|position|curtain|open|close)[\s-]*([0-9]+)[\s-]+([0-9]{1,3})%?$/i);
    if (coverPosMatch) {
      const idx = parseInt(coverPosMatch[1], 10);
      const pos = Math.max(0, Math.min(100, parseInt(coverPosMatch[2], 10)));
      if (idx >= 1 && idx <= devices.length) {
        return {
          kind: 'single_action',
          device: devices[idx - 1],
          action: { kind: 'cover_position', position: pos },
        };
      }
    }

    // 4. Light Brightness: dim 1 30%, bright 1 80%, brightness 1 50%, dim-1 30%
    const dimMatch = text.match(/^(?:dim|bright|brightness)[\s-]*([0-9]+)[\s-]+([0-9]{1,3})%?$/i);
    if (dimMatch) {
      const idx = parseInt(dimMatch[1], 10);
      const pct = Math.max(0, Math.min(100, parseInt(dimMatch[2], 10)));
      if (idx >= 1 && idx <= devices.length) {
        return {
          kind: 'single_action',
          device: devices[idx - 1],
          action: { kind: 'light_brightness', pct },
        };
      }
    }

    // 5. Percentage Shorthand: e.g. "1 50%" or "1 50" (if target device is cover or light)
    const shorthandPctMatch = text.match(/^([0-9]+)[\s-]+([0-9]{1,3})%?$/);
    if (shorthandPctMatch) {
      const idx = parseInt(shorthandPctMatch[1], 10);
      const val = Math.max(0, Math.min(100, parseInt(shorthandPctMatch[2], 10)));
      if (idx >= 1 && idx <= devices.length) {
        const dev = devices[idx - 1];
        const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');
        if (domain === 'cover') {
          return {
            kind: 'single_action',
            device: dev,
            action: { kind: 'cover_position', position: val },
          };
        } else if (domain === 'light') {
          return {
            kind: 'single_action',
            device: dev,
            action: { kind: 'light_brightness', pct: val },
          };
        }
      }
    }

    // 6. Color commands: color 1 blue, color-1 red, color 1 green
    const colorMatch = text.match(/^color[\s-]*([0-9]+)[\s-]+([a-z_]+|#[0-9a-f]{3,6})$/i);
    if (colorMatch) {
      const idx = parseInt(colorMatch[1], 10);
      const color = colorMatch[2].toLowerCase();
      if (idx >= 1 && idx <= devices.length) {
        return {
          kind: 'single_action',
          device: devices[idx - 1],
          action: { kind: 'light_color', color },
        };
      }
    }

    // 7. Warm / Cool / White shortcuts: warm 1, cool 1, white 1, warm-1, cool-1, white-1
    const warmCoolMatch = text.match(/^(warm|cool|white)[\s-]*([0-9]+)$/i);
    if (warmCoolMatch) {
      const type = warmCoolMatch[1].toLowerCase();
      const idx = parseInt(warmCoolMatch[2], 10);
      if (idx >= 1 && idx <= devices.length) {
        let kelvin = 3000;
        let label = 'Warm White (2700K)';
        if (type === 'warm') { kelvin = 2700; label = 'Warm White (2700K)'; }
        else if (type === 'cool') { kelvin = 5000; label = 'Cool White (5000K)'; }
        else if (type === 'white') { kelvin = 4000; label = 'Neutral White (4000K)'; }
        return {
          kind: 'single_action',
          device: devices[idx - 1],
          action: { kind: 'light_temp', kelvin, label },
        };
      }
    }

    // 8. Temp commands: temp 1 3000k (light) OR temp 1 24 (climate)
    const tempMatch = text.match(/^(?:temp|temperature)[\s-]*([0-9]+)[\s-]+([0-9]+(?:\.[0-9]+)?)(?:c|k)?$/i);
    if (tempMatch) {
      const idx = parseInt(tempMatch[1], 10);
      const val = parseFloat(tempMatch[2]);
      if (idx >= 1 && idx <= devices.length) {
        const dev = devices[idx - 1];
        const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');
        if (domain === 'light' || val > 1000) {
          const kelvin = val < 1000 ? 3000 : Math.round(val);
          return {
            kind: 'single_action',
            device: dev,
            action: { kind: 'light_temp', kelvin, label: `${kelvin}K` },
          };
        } else {
          return {
            kind: 'single_action',
            device: dev,
            action: { kind: 'climate_temp', temp: val },
          };
        }
      }
    }

    // 9. Climate Modes: cool 1 22, cool 1, heat 1 26, heat 1, fan 1, mode 1 cool
    const climateModeMatch = text.match(/^(cool|heat|fan|auto|mode)[\s-]*([0-9]+)(?:[\s-]+([a-z]+|[0-9]+(?:\.[0-9]+)?))?$/i);
    if (climateModeMatch) {
      const rawMode = climateModeMatch[1].toLowerCase();
      const idx = parseInt(climateModeMatch[2], 10);
      const extra = climateModeMatch[3] ? climateModeMatch[3].toLowerCase() : null;

      if (idx >= 1 && idx <= devices.length) {
        const dev = devices[idx - 1];
        let mode = rawMode === 'mode' ? extra : (rawMode === 'fan' ? 'fan_only' : rawMode);
        let temp = null;
        if (extra && !isNaN(parseFloat(extra))) {
          temp = parseFloat(extra);
        }
        return {
          kind: 'single_action',
          device: dev,
          action: { kind: 'climate_mode', mode: mode || 'cool', temp },
        };
      }
    }

    // 10. Room-wide Climate Shorthand: "ac 24", "ac cool 22", "ac off"
    const acMatch = text.match(/^ac[\s-]+([a-z]+|[0-9]+(?:\.[0-9]+)?)(?:[\s-]+([0-9]+(?:\.[0-9]+)?))?$/i);
    if (acMatch) {
      // Find first climate device in this room
      const climateDev = devices.find((d) => (d.entityId && d.entityId.startsWith('climate.')) || d.type === 'climate');
      if (climateDev) {
        const p1 = acMatch[1].toLowerCase();
        const p2 = acMatch[2] ? parseFloat(acMatch[2]) : null;
        if (!isNaN(parseFloat(p1))) {
          return {
            kind: 'single_action',
            device: climateDev,
            action: { kind: 'climate_temp', temp: parseFloat(p1) },
          };
        } else if (p1 === 'off') {
          return {
            kind: 'single_action',
            device: climateDev,
            action: { kind: 'turn_off' },
          };
        } else {
          return {
            kind: 'single_action',
            device: climateDev,
            action: { kind: 'climate_mode', mode: p1 === 'fan' ? 'fan_only' : p1, temp: p2 },
          };
        }
      }
    }

    return null;
  }

  _parseSubmenuCommand(rawText, dev) {
    if (!rawText || !dev) return null;
    const text = rawText.trim().toLowerCase();
    const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');

    // 1. Universal Power on / off
    if (text === 'on') {
      if (domain === 'lock') return { kind: 'lock' };
      if (domain === 'cover') return { kind: 'cover_open' };
      if (domain === 'scene') return { kind: 'scene_activate' };
      if (domain === 'script') return { kind: 'script_run' };
      return { kind: 'turn_on' };
    }
    if (text === 'off') {
      if (domain === 'lock') return { kind: 'unlock' };
      if (domain === 'cover') return { kind: 'cover_close' };
      return { kind: 'turn_off' };
    }

    // 1b. Smart Locks
    if (domain === 'lock') {
      if (text === 'lock' || text === 'l') return { kind: 'lock' };
      if (text === 'unlock' || text === 'un') return { kind: 'unlock' };
      if (text === 'open') return { kind: 'lock_open' };
      if (text === 'status') return { kind: 'sensor_read' };
    }

    // 1c. Sensors & Binary Sensors (Read-only monitors)
    if (domain === 'sensor' || domain === 'binary_sensor') {
      return { kind: 'sensor_read' };
    }

    // 1d. Scenes & Scripts
    if (domain === 'scene') {
      if (['activate', 'run', 'start', 'trigger'].includes(text)) return { kind: 'scene_activate' };
    }
    if (domain === 'script' || domain === 'automation') {
      if (['activate', 'run', 'start', 'trigger'].includes(text)) return { kind: 'script_run' };
    }

    // 2. Cover / Curtains
    if (domain === 'cover') {
      if (text === 'open') return { kind: 'cover_open' };
      if (text === 'close') return { kind: 'cover_close' };
      if (text === 'stop') return { kind: 'cover_stop' };

      const posMatch = text.match(/^(?:pos|position|open)?[\s-]*([0-9]{1,3})%?$/i);
      if (posMatch) {
        const val = Math.max(0, Math.min(100, parseInt(posMatch[1], 10)));
        return { kind: 'cover_position', position: val };
      }
    }

    // 3. Light
    if (domain === 'light') {
      // Percent brightness: 50%, 50, dim 30%, bright 80%
      const brMatch = text.match(/^(?:dim|bright|brightness)?[\s-]*([0-9]{1,3})%?$/i);
      if (brMatch) {
        const val = Math.max(0, Math.min(100, parseInt(brMatch[1], 10)));
        return { kind: 'light_brightness', pct: val };
      }

      // Color names: red, blue, green, etc.
      const colors = ['red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'cyan', 'magenta', 'white', 'gold'];
      if (colors.includes(text) || text.startsWith('#')) {
        return { kind: 'light_color', color: text };
      }

      // Warm / Cool
      if (text === 'warm' || text === 'warm white') {
        return { kind: 'light_temp', kelvin: 2700, label: 'Warm White (2700K)' };
      }
      if (text === 'cool' || text === 'cool white') {
        return { kind: 'light_temp', kelvin: 5000, label: 'Cool White (5000K)' };
      }

      // Temperature Kelvin: 3000k, 2700k, temp 3000k
      const kMatch = text.match(/^(?:temp)?[\s-]*([0-9]{4})k?$/i);
      if (kMatch) {
        const kelvin = parseInt(kMatch[1], 10);
        return { kind: 'light_temp', kelvin, label: `${kelvin}K` };
      }
    }

    // 4. Climate
    if (domain === 'climate') {
      // Numeric temp: 24, 24c, 24°c, temp 24
      const tMatch = text.match(/^(?:temp|temperature)?[\s-]*([0-9]{2}(?:\.[0-9]+)?)(?:c|°c)?$/i);
      if (tMatch) {
        return { kind: 'climate_temp', temp: parseFloat(tMatch[1]) };
      }

      // Mode: cool, heat, fan, auto, cool 22, heat 26
      const cmMatch = text.match(/^(cool|heat|fan|auto)(?:[\s-]+([0-9]{2}(?:\.[0-9]+)?))?$/i);
      if (cmMatch) {
        const mode = cmMatch[1].toLowerCase() === 'fan' ? 'fan_only' : cmMatch[1].toLowerCase();
        const temp = cmMatch[2] ? parseFloat(cmMatch[2]) : null;
        return { kind: 'climate_mode', mode, temp };
      }
    }

    return null;
  }

  async _executeParsedAction(dev, action) {
    const domain = dev.entityId ? dev.entityId.split('.')[0] : (dev.type || '');

    switch (action.kind) {
      case 'turn_on': {
        if (domain === 'cover' && typeof this.haClient.openCover === 'function') {
          await this.haClient.openCover(dev.entityId);
          return `${dev.name}: opened`;
        }
        await this.haClient.turnOn(dev.entityId);
        return `${dev.name}: turned ON`;
      }
      case 'turn_off': {
        if (domain === 'cover' && typeof this.haClient.closeCover === 'function') {
          await this.haClient.closeCover(dev.entityId);
          return `${dev.name}: closed`;
        }
        await this.haClient.turnOff(dev.entityId);
        return `${dev.name}: turned OFF`;
      }
      case 'cover_open': {
        if (typeof this.haClient.openCover === 'function') {
          await this.haClient.openCover(dev.entityId);
        } else {
          await this.haClient.turnOn(dev.entityId);
        }
        return `${dev.name}: opened`;
      }
      case 'cover_close': {
        if (typeof this.haClient.closeCover === 'function') {
          await this.haClient.closeCover(dev.entityId);
        } else {
          await this.haClient.turnOff(dev.entityId);
        }
        return `${dev.name}: closed`;
      }
      case 'cover_stop': {
        if (typeof this.haClient.stopCover === 'function') {
          await this.haClient.stopCover(dev.entityId);
        }
        return `${dev.name}: stopped`;
      }
      case 'cover_position': {
        if (typeof this.haClient.setCoverPosition === 'function') {
          await this.haClient.setCoverPosition(dev.entityId, action.position);
        }
        return `${dev.name}: position set to ${action.position}%`;
      }
      case 'light_brightness': {
        if (typeof this.haClient.setLight === 'function') {
          await this.haClient.setLight(dev.entityId, { brightness_pct: action.pct });
        } else {
          await this.haClient.turnOn(dev.entityId, { brightness_pct: action.pct });
        }
        return `${dev.name}: brightness set to ${action.pct}%`;
      }
      case 'light_color': {
        if (typeof this.haClient.setLight === 'function') {
          await this.haClient.setLight(dev.entityId, { color_name: action.color });
        } else {
          await this.haClient.turnOn(dev.entityId, { color_name: action.color });
        }
        return `${dev.name}: color set to ${action.color}`;
      }
      case 'light_temp': {
        if (typeof this.haClient.setLight === 'function') {
          await this.haClient.setLight(dev.entityId, { color_temp_kelvin: action.kelvin });
        } else {
          await this.haClient.turnOn(dev.entityId, { color_temp_kelvin: action.kelvin });
        }
        const label = action.label || `${action.kelvin}K`;
        return `${dev.name}: warmth set to ${label}`;
      }
      case 'climate_temp': {
        if (typeof this.haClient.setClimate === 'function') {
          await this.haClient.setClimate(dev.entityId, { temperature: action.temp });
        }
        return `${dev.name}: temperature set to ${action.temp}°C`;
      }
      case 'climate_mode': {
        if (typeof this.haClient.setClimate === 'function') {
          await this.haClient.setClimate(dev.entityId, {
            hvac_mode: action.mode,
            temperature: action.temp,
          });
        }
        return `${dev.name}: set to ${action.mode.toUpperCase()}${action.temp ? ` at ${action.temp}°C` : ''}`;
      }
      case 'lock': {
        if (typeof this.haClient.lock === 'function') {
          await this.haClient.lock(dev.entityId);
        } else {
          await this.haClient.callService('lock', 'lock', { entity_id: dev.entityId });
        }
        return `${dev.name}: LOCKED`;
      }
      case 'unlock': {
        if (typeof this.haClient.unlock === 'function') {
          await this.haClient.unlock(dev.entityId);
        } else {
          await this.haClient.callService('lock', 'unlock', { entity_id: dev.entityId });
        }
        return `${dev.name}: UNLOCKED`;
      }
      case 'lock_open': {
        if (typeof this.haClient.openLock === 'function') {
          await this.haClient.openLock(dev.entityId);
        } else {
          await this.haClient.callService('lock', 'open', { entity_id: dev.entityId });
        }
        return `${dev.name}: unlatched / opened`;
      }
      case 'sensor_read': {
        let st = null;
        try {
          st = await this.haClient.getEntityState(dev.entityId);
        } catch {}
        const liveVal = this._formatDeviceState(dev, st);
        return `${dev.name}: live reading [${liveVal}]`;
      }
      case 'scene_activate': {
        if (typeof this.haClient.activateScene === 'function') {
          await this.haClient.activateScene(dev.entityId);
        } else {
          await this.haClient.turnOn(dev.entityId);
        }
        return `${dev.name}: activated`;
      }
      case 'script_run': {
        if (typeof this.haClient.runScript === 'function') {
          await this.haClient.runScript(dev.entityId);
        } else {
          await this.haClient.turnOn(dev.entityId);
        }
        return `${dev.name}: executed`;
      }
      default: {
        await this.haClient.turnOn(dev.entityId);
        return `${dev.name}: updated`;
      }
    }
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

      // Check if user already provided speaker selection in audio caption / text
      // e.g. "play 1", "play-1", "Play 1", "PLAY 1", "Play 1,2,4", "play-1,2,4", "play all"
      const captionText = String(msg.caption || msg.text || '').trim();
      const directSpeakers = this._parseSpeakerSelection(captionText, speakers);

      if (directSpeakers.length > 0) {
        const audioUrl = publicUrl;
        for (const spk of directSpeakers) {
          try {
            await this.haClient.playMedia(spk.entityId, audioUrl, 'music');
          } catch (err) {
            this.logger?.warn({ err: err.message, speaker: spk }, 'Failed to trigger speaker playback from caption');
          }
        }
        const targetNames = directSpeakers.map((s) => s.name).join(', ');
        const confirmMsg = this._render('castSuccess', {
          userName,
          speakerName: targetNames,
        });
        this._destroySession(phone);
        return this._sendMessage(clientId, target, confirmMsg);
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
    // Supports: "play 1", "play-1", "Play 1", "PLAY 1", "Play 1,2,4", "play-1,2,4", "1", "1,2", "all", "play all", etc.
    if (session.state === 'SPEAKER_SELECT') {
      const rawText = String(msg.text || '').trim();
      const selectedSpeakers = this._parseSpeakerSelection(rawText, speakers);

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

  _parseSpeakerSelection(rawText, speakers = []) {
    if (!rawText || typeof rawText !== 'string') return [];
    const allSpeakersNum = speakers.length + 1;
    // Strips "play", "play-", "cast", "cast-", "speak", "speak-" with optional spaces or hyphens
    const clean = rawText
      .trim()
      .toLowerCase()
      .replace(/^(play|cast|speak)[\s-]*/i, '')
      .trim();

    if (!clean) return [];

    if (clean === 'all' || clean === String(allSpeakersNum) || clean === '-all' || clean.endsWith('all')) {
      return [...speakers];
    }

    // Split by commas, slashes, plus signs, or whitespace: e.g. "1,2,4", "1-2-4", "1 2 4", "1/2/4"
    const tokens = clean
      .replace(/^[-\s]+/, '')
      .split(/[/,+\s]+/)
      .map((s) => s.replace(/^-/, '').trim())
      .filter(Boolean);

    const selected = [];
    for (const t of tokens) {
      if (t === 'all' || t === String(allSpeakersNum)) {
        return [...speakers];
      }
      const num = parseInt(t, 10);
      if (!isNaN(num) && num >= 1 && num <= speakers.length) {
        const spk = speakers[num - 1];
        if (!selected.includes(spk)) {
          selected.push(spk);
        }
      }
    }
    return selected;
  }
}

module.exports = {
  InteractiveBot,
  SESSION_TIMEOUT_MS,
};
