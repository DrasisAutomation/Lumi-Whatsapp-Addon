'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, readJsonSafe } = require('../services/storage');

function createDefaultConfig() {
  return {
    version: '1.0',
    exportedAt: null,
    authorizedNumbers: [],
    rooms: [],
    speakers: [],
  };
}

class BotConfigManager {
  constructor({ dataDir, logger }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.filePath = path.join(dataDir, 'lumi_remote_config.json');
    this.config = createDefaultConfig();
  }

  async init() {
    try {
      const data = await readJsonSafe(this.filePath, null);
      if (data && typeof data === 'object') {
        this.config = {
          version: data.version || '1.0',
          exportedAt: data.exportedAt || null,
          authorizedNumbers: Array.isArray(data.authorizedNumbers) ? data.authorizedNumbers : [],
          rooms: Array.isArray(data.rooms) ? data.rooms : [],
          speakers: Array.isArray(data.speakers) ? data.speakers : [],
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

  async save(newConfig = null) {
    if (newConfig) {
      this.config = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        authorizedNumbers: Array.isArray(newConfig.authorizedNumbers) ? newConfig.authorizedNumbers : [],
        rooms: Array.isArray(newConfig.rooms) ? newConfig.rooms : [],
        speakers: Array.isArray(newConfig.speakers) ? newConfig.speakers : [],
      };
    }
    await writeJsonAtomic(this.filePath, this.config);
  }

  isAuthorized(rawPhone) {
    if (!this.config.authorizedNumbers || this.config.authorizedNumbers.length === 0) {
      // If no authorized numbers are configured, all numbers are blocked by default for security
      return false;
    }
    const cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
    return this.config.authorizedNumbers.some((item) => {
      const authClean = String(item.phone || '').replace(/[^0-9]/g, '');
      return authClean === cleanPhone;
    });
  }

  async addAuthorizedNumber(phone, name = '') {
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 7) {
      throw new Error('Please enter a valid numeric phone number with country code (10-15 digits).');
    }
    const existingIdx = this.config.authorizedNumbers.findIndex((a) => {
      return String(a.phone).replace(/[^0-9]/g, '') === cleanPhone;
    });
    const entry = {
      phone: cleanPhone,
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
}

module.exports = { BotConfigManager };
