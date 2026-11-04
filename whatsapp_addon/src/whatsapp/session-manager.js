'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');
const { validateClientId, ValidationError } = require('../utils/validation');
const { writeJsonAtomic, readJsonSafe, ensureDir } = require('../services/storage');
const { WhatsAppAccountConnection } = require('./connection');

class SessionManager extends EventEmitter {
  constructor({
    sessionsDir,
    registryPath,
    eventManager,
    contactManager,
    diagnostics,
    logger,
    socketFactory = null,
    authStateFactory = null,
  }) {
    super();
    this.sessionsDir = sessionsDir;
    this.registryPath = registryPath;
    this.eventManager = eventManager;
    this.contactManager = contactManager;
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.socketFactory = socketFactory;
    this.authStateFactory = authStateFactory;

    this.accounts = new Map(); // clientId -> WhatsAppAccountConnection
    this.queueStatsProvider = null; // (clientId) => { pending, sent, failed }
  }

  setQueueStatsProvider(fn) {
    this.queueStatsProvider = fn;
  }

  async init({ autoConnect = true } = {}) {
    await ensureDir(this.sessionsDir);
    const saved = await readJsonSafe(this.registryPath, { accounts: [] });
    const list = Array.isArray(saved?.accounts) ? saved.accounts : [];

    // Ensure 'default' account exists out of the box so users can pair immediately
    if (list.length === 0) {
      list.push({
        clientId: 'default',
        name: 'Default Account',
        autoConnect: false,
        createdAt: new Date().toISOString(),
      });
    }

    for (const meta of list) {
      const conn = this._createConnectionInstance(meta.clientId, meta.name);
      if (meta.phone) conn.phone = meta.phone;
      if (meta.lastConnectedAt) conn.lastConnectedAt = meta.lastConnectedAt;
      if (meta.stats) {
        conn.stats = { ...conn.stats, ...meta.stats };
      }
      this.accounts.set(meta.clientId, conn);

      // Auto-connect if session credentials already exist on disk
      const credsPath = path.join(this.sessionsDir, meta.clientId, 'creds.json');
      if (autoConnect && (meta.autoConnect || fs.existsSync(credsPath))) {
        conn.connect().catch((err) => {
          this.logger?.warn({ err, clientId: meta.clientId }, 'Auto-connect on startup failed');
        });
      }
    }

    await this._saveRegistry();
  }

  _createConnectionInstance(clientId, name) {
    const sessionDir = path.join(this.sessionsDir, clientId);
    const conn = new WhatsAppAccountConnection({
      clientId,
      name: name || clientId,
      sessionDir,
      eventManager: this.eventManager,
      contactManager: this.contactManager,
      diagnostics: this.diagnostics,
      logger: this.logger,
      socketFactory: this.socketFactory,
      authStateFactory: this.authStateFactory,
    });

    conn.on('connected', (cId) => {
      this._saveRegistry().catch(() => {});
      this.emit('account_connected', cId);
    });

    conn.on('state_change', () => {
      this._saveRegistry().catch(() => {});
    });

    conn.on('receipt_update', (update) => {
      this.emit('receipt_update', update);
    });

    conn.on('incoming_message', (msg) => {
      this._saveRegistry().catch(() => {});
      this.emit('incoming_message', msg);
    });

    return conn;
  }

  async _saveRegistry() {
    const accounts = [];
    for (const conn of this.accounts.values()) {
      accounts.push({
        clientId: conn.clientId,
        name: conn.name,
        phone: conn.phone,
        autoConnect: conn.status === 'connected',
        lastConnectedAt: conn.lastConnectedAt,
        stats: conn.stats,
      });
    }
    await writeJsonAtomic(this.registryPath, {
      updatedAt: new Date().toISOString(),
      accounts,
    });
  }

  listAccounts() {
    const result = [];
    for (const conn of this.accounts.values()) {
      const qStats = this.queueStatsProvider
        ? this.queueStatsProvider(conn.clientId)
        : { pending: 0, sent: 0, failed: 0 };
      result.push(conn.getSummary(qStats));
    }
    return result;
  }

  getAccount(clientId) {
    const id = validateClientId(clientId);
    const conn = this.accounts.get(id);
    if (!conn) {
      throw new ValidationError(`WhatsApp account "${id}" not found.`, 'ACCOUNT_NOT_FOUND', 404);
    }
    const qStats = this.queueStatsProvider
      ? this.queueStatsProvider(id)
      : { pending: 0, sent: 0, failed: 0 };
    return conn.getSummary(qStats);
  }

  getConnection(clientId) {
    const id = validateClientId(clientId);
    const conn = this.accounts.get(id);
    if (!conn) {
      throw new ValidationError(`WhatsApp account "${id}" not found.`, 'ACCOUNT_NOT_FOUND', 404);
    }
    return conn;
  }

  async createAccount({ clientId, name, connectImmediately = true }) {
    const id = validateClientId(clientId);
    if (this.accounts.has(id)) {
      throw new ValidationError(`WhatsApp account "${id}" already exists.`, 'ACCOUNT_ALREADY_EXISTS', 409);
    }

    const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : id;
    const conn = this._createConnectionInstance(id, displayName);
    this.accounts.set(id, conn);
    await this._saveRegistry();
    this.emit('account_created', id);

    if (connectImmediately) {
      await conn.connect();
    }

    return this.getAccount(id);
  }

  async connectAccount(clientId, { regenerateQr = false, resetSession = false } = {}) {
    const conn = this.getConnection(clientId);
    if (resetSession) {
      await conn.disconnect();
      const sessionDir = path.join(this.sessionsDir, conn.clientId);
      await fsp.rm(sessionDir, { recursive: true, force: true });
      await ensureDir(sessionDir);
    }
    await conn.connect({ regenerateQr: regenerateQr || resetSession });
    await this._saveRegistry();
    return this.getAccount(clientId);
  }

  async disconnectAccount(clientId) {
    const conn = this.getConnection(clientId);
    await conn.disconnect();
    await this._saveRegistry();
    return this.getAccount(clientId);
  }

  async deleteAccount(clientId, { confirmed = false } = {}) {
    const id = validateClientId(clientId);
    if (!confirmed) {
      throw new ValidationError(
        'Explicit confirmation (confirm=true) is required to delete an account and its session.',
        'CONFIRMATION_REQUIRED',
        400
      );
    }
    const conn = this.getConnection(id);
    await conn.disconnect();
    this.accounts.delete(id);
    this.contactManager?.clearAccount(id);

    const sessionDir = path.join(this.sessionsDir, id);
    await fsp.rm(sessionDir, { recursive: true, force: true });
    await this._saveRegistry();
    this.emit('account_deleted', id);
    return { deleted: true, clientId: id };
  }

  async stopAll() {
    for (const conn of this.accounts.values()) {
      await conn.disconnect();
    }
  }
}

module.exports = {
  SessionManager,
};
