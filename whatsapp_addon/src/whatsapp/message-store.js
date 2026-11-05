'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

/**
 * In-memory LRU message store with asynchronous disk persistence.
 * Essential for Baileys E2EE decryption retry handling (getMessage callback).
 * Prevents recipient devices from getting stuck on "Waiting for this message. This may take a while."
 */
class MessageStore {
  constructor({ clientId, sessionDir, maxMessages = 1000, logger = null }) {
    this.clientId = clientId;
    this.sessionDir = sessionDir;
    this.maxMessages = maxMessages;
    this.logger = logger;
    this.storeFile = path.join(sessionDir, 'message_store.json');

    // Primary map: messageId -> messageContent
    this.messages = new Map();
    // Key order for LRU eviction
    this.keys = [];
    this._saveScheduled = false;

    this._loadFromDiskSync();
  }

  _loadFromDiskSync() {
    try {
      if (fs.existsSync(this.storeFile)) {
        const raw = fs.readFileSync(this.storeFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.keyId && item.message) {
              this._put(item.keyId, item.message, item.compositeKey);
            }
          }
        }
      }
    } catch (err) {
      this.logger?.warn(
        { err: err.message, clientId: this.clientId },
        'Could not load existing message_store.json; starting fresh'
      );
    }
  }

  _put(keyId, message, compositeKey = null) {
    if (!keyId || !message) return;

    if (this.messages.has(keyId)) {
      this.messages.set(keyId, message);
      if (compositeKey) this.messages.set(compositeKey, message);
      return;
    }

    if (this.keys.length >= this.maxMessages) {
      const oldest = this.keys.shift();
      if (oldest) {
        this.messages.delete(oldest.keyId);
        if (oldest.compositeKey) {
          this.messages.delete(oldest.compositeKey);
        }
      }
    }

    this.messages.set(keyId, message);
    if (compositeKey) {
      this.messages.set(compositeKey, message);
    }
    this.keys.push({ keyId, compositeKey });
  }

  saveMessage(webMessage) {
    if (!webMessage) return;

    const key = webMessage.key;
    const message = webMessage.message;
    if (!key || !key.id || !message) return;

    const keyId = key.id;
    const compositeKey = key.remoteJid ? `${key.remoteJid}:${key.id}` : null;

    this._put(keyId, message, compositeKey);
    this._scheduleSave();
  }

  getMessage(key) {
    if (!key) return undefined;

    const keyId = typeof key === 'string' ? key : key.id;
    const remoteJid = key.remoteJid;

    if (remoteJid && keyId) {
      const compositeKey = `${remoteJid}:${keyId}`;
      if (this.messages.has(compositeKey)) {
        return this.messages.get(compositeKey);
      }
    }

    if (keyId && this.messages.has(keyId)) {
      return this.messages.get(keyId);
    }

    return undefined;
  }

  _scheduleSave() {
    if (this._saveScheduled) return;
    this._saveScheduled = true;

    setTimeout(async () => {
      this._saveScheduled = false;
      try {
        const serializable = [];
        for (const entry of this.keys) {
          const msg = this.messages.get(entry.keyId);
          if (msg) {
            serializable.push({
              keyId: entry.keyId,
              compositeKey: entry.compositeKey,
              message: msg,
            });
          }
        }
        await fsp.mkdir(this.sessionDir, { recursive: true });
        const tempFile = `${this.storeFile}.tmp`;
        await fsp.writeFile(tempFile, JSON.stringify(serializable), 'utf8');
        await fsp.rename(tempFile, this.storeFile);
      } catch (err) {
        this.logger?.debug(
          { err: err.message, clientId: this.clientId },
          'Failed to persist message store'
        );
      }
    }, 1500).unref?.();
  }
}

module.exports = { MessageStore };
