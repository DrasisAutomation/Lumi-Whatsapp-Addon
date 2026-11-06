'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, readJsonSafe } = require('../services/storage');

function createDefaultSettings() {
  return {
    remoteTriggers: ['remote', 'lumi', 'control', '/remote'],
    castTriggers: ['cast', 'broadcast', 'speak', '/cast'],
    statusTriggers: ['status', '/status', 'state', '/state'],
    endTriggers: ['end', 'exit', '/end', 'stop', 'quit', 'close'],
    backTriggers: ['back', '/back', 'rooms', 'menu'],
    helpTriggers: ['help', '/help', 'info', 'commands'],
    enableEmojis: false,
    includeUserName: true,
    templates: {
      remoteGreeting: "LUMI SMART HOME REMOTE\nWelcome {{userName}}.\nSelect a room by replying with its number:\n\n{{roomList}}\n\n─────────────────────\nReply with a room number (e.g. 1) or '{{primaryEndTrigger}}' to exit.",
      deviceMenu: "{{roomName}} Devices\nUser: {{userName}}\n─────────────────────\n{{deviceList}}\n\n─────────────────────\nHow to Control:\n• On / Off: on 1 | off 1 | ON-1\n• Curtains: open 1 | close 1 | stop 1 | 1 50%\n• Locks: lock 1 | unlock 1\n• Brightness & Color: dim 1 40% | color 1 blue | warm 1\n• AC & Climate: temp 1 24 | cool 22\n• Or reply with device number (e.g. 1) for detailed controls!\n• Navigation: '{{primaryBackTrigger}}' (Rooms) | '{{primaryEndTrigger}}' (Exit)",
      deviceSubmenu: "{{deviceName}} [{{deviceStatus}}]\nRoom: {{roomName}}\n─────────────────────\nControls for this device:\n{{controlHints}}\n\n─────────────────────\nReply with an action above, '{{primaryBackTrigger}}' for room devices, or '{{primaryEndTrigger}}' to exit.",
      actionResult: "{{roomName}}\nUpdated by {{userName}}:\n─────────────────────\n{{results}}\n\n─────────────────────\nControl more devices, '{{primaryBackTrigger}}' for rooms, or '{{primaryEndTrigger}}' to exit.",
      statusReport: "LUMI HOME STATUS\nUser: {{userName}}\n─────────────────────\n{{statusSummary}}\n\n─────────────────────\nSend '{{primaryRemoteTrigger}}' for controls or '{{primaryCastTrigger}}' to broadcast.",
      noDevicesStatus: "LUMI HOME STATUS\nHello {{userName}}.\nNo devices configured yet.\nPlease configure rooms and devices in the Lumi Remote Builder.",
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
    },
  };
}

function createDefaultConfig() {
  return {
    version: '1.0',
    exportedAt: null,
    authorizedNumbers: [],
    rooms: [],
    speakers: [],
    settings: createDefaultSettings(),
  };
}

class BotConfigManager {
  constructor({ dataDir, logger }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.filePath = path.join(dataDir, 'lumi_remote_config.json');
    this.config = createDefaultConfig();
    this.recentDenied = new Map(); // id -> { id, senderJid, senderName, timestamp }
  }

  async init() {
    try {
      const data = await readJsonSafe(this.filePath, null);
      if (data && typeof data === 'object') {
        const defSettings = createDefaultSettings();
        this.config = {
          version: data.version || '1.0',
          exportedAt: data.exportedAt || null,
          authorizedNumbers: Array.isArray(data.authorizedNumbers) ? data.authorizedNumbers : [],
          rooms: Array.isArray(data.rooms) ? data.rooms : [],
          speakers: Array.isArray(data.speakers) ? data.speakers : [],
          settings: {
            ...defSettings,
            ...(data.settings || {}),
            templates: {
              ...defSettings.templates,
              ...((data.settings && data.settings.templates) || {}),
            },
          },
        };
        this.logger?.info({ rooms: this.config.rooms.length, authorized: this.config.authorizedNumbers.length }, 'Loaded Bot & Remote configuration');
      } else {
        await this.save();
      }
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Could not read bot config; using defaults');
      this.config = createDefaultConfig();
    }
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  getSettings() {
    const def = createDefaultSettings();
    return {
      ...def,
      ...(this.config.settings || {}),
      templates: {
        ...def.templates,
        ...((this.config.settings && this.config.settings.templates) || {}),
      },
    };
  }

  async updateSettings(newSettings = {}) {
    const current = this.getSettings();
    this.config.settings = {
      ...current,
      ...newSettings,
      templates: {
        ...current.templates,
        ...(newSettings.templates || {}),
      },
    };
    await this.save();
    return this.getSettings();
  }

  async resetSettingsToDefault() {
    this.config.settings = createDefaultSettings();
    await this.save();
    return this.getSettings();
  }

  getAuthorizedEntry(rawPhone, rawJid = null) {
    if (!this.config.authorizedNumbers || this.config.authorizedNumbers.length === 0) {
      return null;
    }
    const cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
    const cleanJid = rawJid ? String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    return (
      this.config.authorizedNumbers.find((item) => {
        const authClean = String(item.phone || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const authLid = item.lid ? String(item.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
        return (
          (cleanPhone && authClean === cleanPhone) ||
          (cleanJid && authClean === cleanJid) ||
          (cleanPhone && authLid && cleanPhone === authLid) ||
          (cleanJid && authLid && cleanJid === authLid)
        );
      }) || null
    );
  }

  async save(newConfig = null) {
    if (newConfig) {
      const defSettings = createDefaultSettings();
      this.config = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        authorizedNumbers: Array.isArray(newConfig.authorizedNumbers) ? newConfig.authorizedNumbers : (this.config.authorizedNumbers || []),
        rooms: Array.isArray(newConfig.rooms) ? newConfig.rooms : (this.config.rooms || []),
        speakers: Array.isArray(newConfig.speakers) ? newConfig.speakers : (this.config.speakers || []),
        settings: newConfig.settings ? {
          ...defSettings,
          ...newConfig.settings,
          templates: {
            ...defSettings.templates,
            ...(newConfig.settings.templates || {}),
          },
        } : (this.config.settings || defSettings),
      };
    }
    await writeJsonAtomic(this.filePath, this.config);
  }

  isAuthorized(rawPhone, rawJid = null) {
    if (!this.config.authorizedNumbers || this.config.authorizedNumbers.length === 0) {
      // If no authorized numbers are configured, all numbers are blocked by default for security
      return false;
    }
    const cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
    const cleanJid = rawJid ? String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    return this.config.authorizedNumbers.some((item) => {
      const authClean = String(item.phone || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      const authLid = item.lid ? String(item.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      return (
        (cleanPhone && authClean === cleanPhone) ||
        (cleanJid && authClean === cleanJid) ||
        (cleanPhone && authLid && cleanPhone === authLid) ||
        (cleanJid && authLid && cleanJid === authLid)
      );
    });
  }

  recordDeniedAttempt(phoneOrJid, { senderName = null } = {}) {
    if (!phoneOrJid) return;
    const clean = String(phoneOrJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (!clean) return;
    this.recentDenied.set(clean, {
      id: clean,
      raw: phoneOrJid,
      senderName,
      timestamp: new Date().toISOString(),
    });
    if (this.recentDenied.size > 20) {
      const oldest = Array.from(this.recentDenied.keys())[0];
      this.recentDenied.delete(oldest);
    }
  }

  getRecentDenied() {
    return Array.from(this.recentDenied.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async addAuthorizedNumber(phone, name = '', { lid = null } = {}) {
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 7) {
      throw new Error('Please enter a valid numeric phone number or WhatsApp ID (7-16 digits).');
    }
    const cleanLid = lid ? String(lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null;
    const existingIdx = this.config.authorizedNumbers.findIndex((a) => {
      const aClean = String(a.phone).replace(/[^0-9]/g, '');
      const aLid = a.lid ? String(a.lid).replace(/[^0-9]/g, '') : null;
      return aClean === cleanPhone || (cleanLid && aLid === cleanLid);
    });
    const entry = {
      phone: cleanPhone,
      lid: cleanLid || (existingIdx >= 0 ? this.config.authorizedNumbers[existingIdx]?.lid : null) || null,
      name: name?.trim() || cleanPhone,
      addedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      this.config.authorizedNumbers[existingIdx] = entry;
    } else {
      this.config.authorizedNumbers.push(entry);
    }
    await this.save();
    return entry;
  }

  async removeAuthorizedNumber(phone) {
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    this.config.authorizedNumbers = this.config.authorizedNumbers.filter((a) => {
      return String(a.phone).replace(/[^0-9]/g, '') !== cleanPhone;
    });
    await this.save();
  }

  async addRoom(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      throw new Error('Room name cannot be empty.');
    }
    const id = `room_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const room = {
      id,
      name: cleanName,
      devices: [],
    };
    this.config.rooms.push(room);
    await this.save();
    return room;
  }

  async removeRoom(roomId) {
    this.config.rooms = this.config.rooms.filter((r) => r.id !== roomId);
    await this.save();
  }

  async addDevice(roomId, { name, entityId, type = 'switch' }) {
    const room = this.config.rooms.find((r) => r.id === roomId);
    if (!room) {
      throw new Error(`Room with ID "${roomId}" not found.`);
    }
    const cleanName = String(name || '').trim();
    const cleanEntity = String(entityId || '').trim();
    if (!cleanName || !cleanEntity) {
      throw new Error('Device name and Home Assistant entity ID are required.');
    }
    const id = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const device = {
      id,
      name: cleanName,
      entityId: cleanEntity,
      type: type || 'switch',
    };
    room.devices.push(device);
    await this.save();
    return device;
  }

  async removeDevice(roomId, deviceId) {
    const room = this.config.rooms.find((r) => r.id === roomId);
    if (!room) return;
    room.devices = room.devices.filter((d) => d.id !== deviceId);
    await this.save();
  }

  async addSpeaker({ name, entityId }) {
    const cleanName = String(name || '').trim();
    const cleanEntity = String(entityId || '').trim();
    if (!cleanName || !cleanEntity) {
      throw new Error('Speaker name and media_player entity ID are required.');
    }
    const id = `spk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const speaker = {
      id,
      name: cleanName,
      entityId: cleanEntity,
    };
    this.config.speakers.push(speaker);
    await this.save();
    return speaker;
  }

  async removeSpeaker(speakerId) {
    this.config.speakers = this.config.speakers.filter((s) => s.id !== speakerId);
    await this.save();
  }

  exportJson() {
    return JSON.stringify(
      {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        authorizedNumbers: this.config.authorizedNumbers,
        rooms: this.config.rooms,
        speakers: this.config.speakers,
      },
      null,
      2
    );
  }

  async importJson(rawJson) {
    let parsed;
    try {
      parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch (err) {
      throw new Error('Invalid JSON format: Could not parse backup file.');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON structure: Expected an object.');
    }

    this.config = {
      version: parsed.version || '1.0',
      exportedAt: new Date().toISOString(),
      authorizedNumbers: Array.isArray(parsed.authorizedNumbers) ? parsed.authorizedNumbers : [],
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
    };
    await this.save();
    return {
      roomsCount: this.config.rooms.length,
      authorizedCount: this.config.authorizedNumbers.length,
      speakersCount: this.config.speakers.length,
    };
  }

  getDemoConfig() {
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      authorizedNumbers: [
        {
          phone: '919876543210',
          name: 'Home Admin',
          addedAt: new Date().toISOString(),
        },
      ],
      rooms: [
        {
          id: 'room_living_room',
          name: 'Living Room',
          devices: [
            { id: 'dev_lr_light', name: 'Ceiling Light', type: 'light', entityId: 'light.living_room_light' },
            { id: 'dev_lr_fan', name: 'Ceiling Fan', type: 'fan', entityId: 'fan.living_room_fan' },
            { id: 'dev_lr_ac', name: 'Air Conditioner', type: 'climate', entityId: 'climate.living_room_ac' },
          ],
        },
        {
          id: 'room_bedroom',
          name: 'Master Bedroom',
          devices: [
            { id: 'dev_bed_lamp', name: 'Bedside Lamp', type: 'light', entityId: 'light.bedroom_lamp' },
            { id: 'dev_bed_fan', name: 'Exhaust Fan', type: 'switch', entityId: 'switch.bedroom_fan' },
          ],
        },
      ],
      speakers: [
        {
          id: 'spk_living_speaker',
          name: 'Living Room Speaker',
          entityId: 'media_player.living_room_speaker',
        },
        {
          id: 'spk_bedroom_echo',
          name: 'Bedroom Echo Dot',
          entityId: 'media_player.bedroom_speaker',
        },
      ],
    };
  }

  async loadDemoConfig() {
    const demo = this.getDemoConfig();
    this.config = demo;
    await this.save();
    return this.config;
  }
}

module.exports = { BotConfigManager };
