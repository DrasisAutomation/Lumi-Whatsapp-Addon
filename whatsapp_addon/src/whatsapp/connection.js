'use strict';

const EventEmitter = require('node:events');
const QRCode = require('qrcode');
const pino = require('pino');
const NodeCache = require('@cacheable/node-cache');
const { getBaileys, DisconnectReason } = require('./baileys');
const { MessageStore } = require('./message-store');
const { useAtomicMultiFileAuthState } = require('../services/storage');
const { calculateBackoffDelayMs } = require('../services/retry');
const { BAILEYS_STATUS_MAP } = require('./event-manager');

class WhatsAppAccountConnection extends EventEmitter {
  constructor({
    clientId,
    name,
    sessionDir,
    eventManager,
    contactManager,
    diagnostics,
    logger,
    socketFactory = null,
    authStateFactory = null,
  }) {
    super();
    this.clientId = clientId;
    this.name = name || clientId;
    this.sessionDir = sessionDir;
    this.eventManager = eventManager;
    this.contactManager = contactManager;
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.socketFactory = socketFactory;
    this.authStateFactory = authStateFactory || useAtomicMultiFileAuthState;

    this.sock = null;
    this.status = 'disconnected'; // disconnected | connecting | qr_ready | connected | reconnecting | logged_out | error
    this.sessionHealth = 'uninitialized'; // uninitialized | healthy | pairing | degraded | invalid_logged_out
    this.phone = null;
    this.jid = null;
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.qrExpiresAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastActiveAt = null;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manualDisconnect = false;

    this.messageStore = new MessageStore({
      clientId: this.clientId,
      sessionDir: this.sessionDir,
      logger: this.logger,
    });
    const CacheClass = NodeCache.default || NodeCache;
    this.msgRetryCounterCache = new CacheClass({
      stdTTL: 3600,
      useClones: false,
    });

    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      messagesFailed: 0,
      lastMessagePreview: null,
      lastMessageAt: null,
    };

    this.sentMessageIds = new Map();
    this.maxSentIds = 2000;
  }

  recordSentMessageId(messageId) {
    if (!messageId) return;
    this.sentMessageIds.set(messageId, Date.now());
    if (this.sentMessageIds.size > this.maxSentIds) {
      const oldestKeys = Array.from(this.sentMessageIds.keys()).slice(0, 500);
      for (const k of oldestKeys) {
        this.sentMessageIds.delete(k);
      }
    }
  }

  isBotSentMessage(messageId) {
    if (!messageId) return false;
    return this.sentMessageIds.has(messageId);
  }

  isSelfChat(remoteJid) {
    if (!remoteJid) return false;
    const cleanRemote = String(remoteJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const cleanPhone = this.phone ? String(this.phone).replace(/[^0-9]/g, '') : '';
    const cleanJid = this.jid ? String(this.jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    const cleanLid = this.sock?.user?.lid ? String(this.sock.user.lid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';

    if (cleanRemote && (cleanRemote === cleanPhone || cleanRemote === cleanJid || (cleanLid && cleanRemote === cleanLid))) {
      return true;
    }
    return false;
  }

  async connect({ regenerateQr = false } = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock && (this.status === 'connected' || this.status === 'connecting') && !regenerateQr) {
      return this.getSummary();
    }

    if (this.sock) {
      await this._cleanupSocket();
    }

    this.manualDisconnect = false;
    this.status = 'connecting';
    this.lastError = null;
    this._emitState();

    try {
      const baileys = await getBaileys();
      const makeWASocket = baileys.default || baileys.makeWASocket;
      const {
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
        Browsers,
      } = baileys;

      const { state, saveCreds } = await this.authStateFactory(this.sessionDir);

      let version = [2, 3000, 1015901307];
      if (!this.socketFactory) {
        try {
          const latest = await fetchLatestBaileysVersion();
          if (latest?.version) {
            version = latest.version;
          }
        } catch {
          // Use fallback protocol version if offline during startup
        }
      }

      const silentPino = pino({ level: 'silent' });
      const createSocket = this.socketFactory || makeWASocket;

      const sock = createSocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentPino),
        },
        printQRInTerminal: false,
        logger: silentPino,
        browser: Browsers.ubuntu(`LumiWhatsapp-${this.clientId}`),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        msgRetryCounterCache: this.msgRetryCounterCache,
        getMessage: async (key) => {
          try {
            return this.messageStore.getMessage(key);
          } catch {
            return undefined;
          }
        },
        patchMessageBeforeSending: (message) => {
          const requiresPatch = Boolean(
            message.buttonsMessage ||
            message.templateMessage ||
            message.listMessage
          );
          if (requiresPatch) {
            message = {
              viewOnceMessage: {
                message: {
                  messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                  },
                  ...message,
                },
              },
            };
          }
          return message;
        },
      });

      this.sock = sock;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          this.logger?.error({ err, clientId: this.clientId }, 'Failed to persist credentials update');
        }
      });

      sock.ev.on('connection.update', async (update) => {
        await this._handleConnectionUpdate(update);
      });

      sock.ev.on('messages.upsert', async (upsert) => {
        await this._handleMessagesUpsert(upsert);
      });

      sock.ev.on('messages.update', async (updates) => {
        await this._handleMessagesUpdate(updates);
      });

      sock.ev.on('contacts.upsert', (contacts) => {
        this.contactManager?.upsertContacts(this.clientId, contacts);
      });

      sock.ev.on('contacts.update', (contacts) => {
        this.contactManager?.upsertContacts(this.clientId, contacts);
      });

      return this.getSummary();
    } catch (err) {
      this.status = 'error';
      this.sessionHealth = 'degraded';
      this.lastError = {
        code: err.code || 'CONNECT_INIT_ERROR',
        message: err.message,
        timestamp: new Date().toISOString(),
      };
      this.diagnostics?.recordConnectionError({
        clientId: this.clientId,
        code: this.lastError.code,
        message: err.message,
      });
      this._emitState();
      throw err;
    }
  }

  async _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrRaw = qr;
        this.qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 300,
        });
        this.qrExpiresAt = new Date(Date.now() + 60000).toISOString();
        this.status = 'qr_ready';
        this.sessionHealth = 'pairing';
        this.eventManager?.emitQrUpdate({
          clientId: this.clientId,
          qrDataUrl: this.qrDataUrl,
          expiresAt: this.qrExpiresAt,
        });
        this._emitState();
      } catch (err) {
        this.logger?.error({ err, clientId: this.clientId }, 'Failed to render QR code');
      }
    }

    if (connection === 'open') {
      this.status = 'connected';
      this.sessionHealth = 'healthy';
      this.qrRaw = null;
      this.qrDataUrl = null;
      this.qrExpiresAt = null;
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastActiveAt = this.lastConnectedAt;
      this.lastError = null;

      const userJid = this.sock?.user?.id || '';
      if (userJid) {
        this.jid = userJid;
        this.phone = userJid.split(':')[0].split('@')[0];
      }

      this._emitState();
      this.emit('connected', this.clientId);
    }

    if (connection === 'close') {
      this.lastDisconnectedAt = new Date().toISOString();
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode ||
        null;
      const errMessage = lastDisconnect?.error?.message || 'Connection closed';

      if (this.manualDisconnect) {
        this.status = 'disconnected';
        this._emitState();
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        // Explicit logout from phone: do NOT auto-loop; mark session invalid and inform user
        this.status = 'logged_out';
        this.sessionHealth = 'invalid_logged_out';
        this.qrRaw = null;
        this.qrDataUrl = null;
        this.lastError = {
          code: 'LOGGED_OUT',
          statusCode,
          message: 'Session was unlinked from WhatsApp on the phone. Please reconnect and scan a new QR code.',
          timestamp: this.lastDisconnectedAt,
        };
        this.diagnostics?.recordAuthError({
          clientId: this.clientId,
          code: 'LOGGED_OUT',
          message: this.lastError.message,
        });
        this._emitState();
        return;
      }

      // Temporary network or server error: NEVER delete session! Reconnect with backoff.
      this.status = 'reconnecting';
      this.sessionHealth = 'degraded';
      this.reconnectAttempts += 1;
      this.lastError = {
        code: `DISCONNECTED_${statusCode || 'NETWORK'}`,
        statusCode,
        message: errMessage,
        timestamp: this.lastDisconnectedAt,
      };
      this.diagnostics?.recordConnectionError({
        clientId: this.clientId,
        code: this.lastError.code,
        statusCode,
        message: errMessage,
      });
      this._emitState();

      const delayMs =
        statusCode === DisconnectReason.restartRequired
          ? 500
          : calculateBackoffDelayMs(this.reconnectAttempts - 1, 2000, 60000);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.manualDisconnect) {
          this.connect().catch((err) => {
            this.logger?.warn({ err, clientId: this.clientId }, 'Reconnect attempt failed');
          });
        }
      }, delayMs);
    }
  }

  saveMessage(webMessage) {
    this.messageStore?.saveMessage(webMessage);
  }

  async _handleMessagesUpsert(upsert) {
    if (!upsert || (upsert.type !== 'notify' && upsert.type !== 'append')) return;
    if (upsert.type !== 'notify') return;

    const messages = Array.isArray(upsert.messages) ? upsert.messages : [];
    for (const msg of messages) {
      if (msg && msg.key && msg.key.id && msg.message) {
        this.messageStore?.saveMessage(msg);
      }
      const parsed = this.eventManager?.parseIncomingBaileysMessage(this.clientId, msg, { connection: this });
      if (parsed) {
        this.stats.messagesReceived += 1;
        this.stats.lastMessageAt = parsed.timestamp;
        this.stats.lastMessagePreview =
          parsed.text
            ? `${parsed.senderName || parsed.sender}: ${parsed.text.slice(0, 80)}`
            : `${parsed.senderName || parsed.sender}: [${parsed.messageType}]`;
        this.lastActiveAt = parsed.timestamp;
        this.eventManager.emitIncomingMessage(parsed);
        this.emit('incoming_message', parsed);
      }
    }
  }

  async _handleMessagesUpdate(updates) {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      const messageId = item?.key?.id;
      const remoteJid = item?.key?.remoteJid;
      const rawStatus = item?.update?.status;
      if (!messageId || rawStatus === undefined || rawStatus === null) continue;
      const mappedStatus = BAILEYS_STATUS_MAP[rawStatus];
      if (mappedStatus) {
        this.lastActiveAt = new Date().toISOString();
        this.emit('receipt_update', {
          clientId: this.clientId,
          messageId,
          to: remoteJid ? remoteJid.replace(/@(s\.whatsapp\.net|lid)$/, '') : null,
          status: mappedStatus,
        });
      }
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this._cleanupSocket();
    this.status = 'disconnected';
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.qrExpiresAt = null;
    this.lastDisconnectedAt = new Date().toISOString();
    this._emitState();
    return this.getSummary();
  }

  async _cleanupSocket() {
    if (!this.sock) return;
    const oldSock = this.sock;
    this.sock = null;
    try {
      oldSock.ev?.removeAllListeners?.();
      oldSock.end?.(undefined);
    } catch {
      // Ignore socket close errors
    }
  }

  _emitState() {
    this.eventManager?.emitConnectionUpdate({
      clientId: this.clientId,
      status: this.status,
      phone: this.phone,
      qrAvailable: Boolean(this.qrDataUrl),
      lastConnectedAt: this.lastConnectedAt,
      error: this.lastError,
    });
    this.emit('state_change', this.getSummary());
  }

  getQrInfo() {
    return {
      clientId: this.clientId,
      status: this.status,
      qrAvailable: Boolean(this.qrDataUrl),
      qrDataUrl: this.qrDataUrl,
      qrExpiresAt: this.qrExpiresAt,
    };
  }

  getSummary(queueStats = { pending: 0, sent: 0, failed: 0 }) {
    return {
      clientId: this.clientId,
      name: this.name,
      status: this.status,
      connected: this.status === 'connected',
      sessionHealth: this.sessionHealth,
      phone: this.phone,
      jid: this.jid,
      qrAvailable: Boolean(this.qrDataUrl),
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastActiveAt: this.lastActiveAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      stats: {
        messagesSent: Math.max(this.stats.messagesSent, queueStats.sent || 0),
        messagesReceived: this.stats.messagesReceived,
        messagesPending: queueStats.pending || 0,
        messagesFailed: Math.max(this.stats.messagesFailed, queueStats.failed || 0),
        lastMessage: this.stats.lastMessagePreview || 'None',
        lastMessageAt: this.stats.lastMessageAt,
      },
    };
  }
}

module.exports = {
  WhatsAppAccountConnection,
};
