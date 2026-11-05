'use strict';

const {
  validateClientId,
  normalizeRecipientJid,
  validateTextBody,
  validateLocationPayload,
  ValidationError,
} = require('../utils/validation');

class MessageManager {
  constructor({
    sessionManager,
    queueManager,
    mediaManager,
    eventManager,
    contactManager,
    logger,
  }) {
    this.sessionManager = sessionManager;
    this.queueManager = queueManager;
    this.mediaManager = mediaManager;
    this.eventManager = eventManager;
    this.contactManager = contactManager;
    this.logger = logger;

    this._wireEvents();
  }

  _wireEvents() {
    this.sessionManager.setQueueStatsProvider((clientId) =>
      this.queueManager.getAccountStats(clientId)
    );

    this.sessionManager.on('account_connected', (clientId) => {
      this.queueManager.notifyAccountConnected(clientId);
    });

    this.sessionManager.on('receipt_update', async ({ clientId, messageId, to, status }) => {
      const updated = await this.queueManager.updateReceiptStatus(clientId, messageId, status);
      this.eventManager.emitMessageStatus({
        clientId,
        messageId,
        to: updated?.to || to,
        status,
      });
    });

    this.queueManager.on('submitted', (item) => {
      const conn = this.sessionManager.accounts.get(item.clientId);
      if (conn) {
        conn.stats.messagesSent += 1;
        conn.stats.lastMessageAt = item.sentAt || new Date().toISOString();
        conn.stats.lastMessagePreview = `To ${item.to}: [${item.messageType}]`;
        conn.lastActiveAt = conn.stats.lastMessageAt;
      }
      this.eventManager.emitMessageSent({
        clientId: item.clientId,
        queueId: item.queueId,
        messageId: item.messageId,
        to: item.to,
        messageType: item.messageType,
        timestamp: item.sentAt,
      });
      this.eventManager.emitSendMessageResult({
        clientId: item.clientId,
        queueId: item.queueId,
        messageId: item.messageId,
        to: item.to,
        messageType: item.messageType,
        status: 'sent',
        timestamp: item.sentAt,
      });
    });

    this.queueManager.on('failed', (item) => {
      const conn = this.sessionManager.accounts.get(item.clientId);
      if (conn) {
        conn.stats.messagesFailed += 1;
      }
      this.eventManager.emitSendMessageResult({
        clientId: item.clientId,
        queueId: item.queueId,
        messageId: item.messageId,
        to: item.to,
        messageType: item.messageType,
        status: 'failed',
        error: item.lastError,
        timestamp: item.updatedAt,
      });
      this.eventManager.emitMessageStatus({
        clientId: item.clientId,
        messageId: item.messageId,
        to: item.to,
        status: 'failed',
        error: item.lastError,
        timestamp: item.updatedAt,
      });
    });
  }

  /**
   * Executor called by MessageQueueManager for each queued message.
   * Only reports success once Baileys confirms submission and returns a message key.
   */
  async executeQueueItem(item) {
    const conn = this.sessionManager.getConnection(item.clientId);
    if (conn.status === 'logged_out') {
      const err = new ValidationError(
        `Account "${item.clientId}" is logged out. Re-scan QR code in add-on UI.`,
        'ACCOUNT_LOGGED_OUT',
        401
      );
      err.permanent = true;
      throw err;
    }

    if (conn.status !== 'connected' || !conn.sock) {
      const err = new Error(`Account "${item.clientId}" is currently ${conn.status}; waiting for connection.`);
      err.code = 'ACCOUNT_NOT_CONNECTED';
      err.permanent = false;
      throw err;
    }

    const jid = normalizeRecipientJid(item.to, { allowGroup: true });
    const { messageType, payload } = item;

    let baileysContent;
    if (messageType === 'text') {
      baileysContent = { text: payload.text };
    } else if (messageType === 'location') {
      baileysContent = {
        location: {
          degreesLatitude: payload.degreesLatitude,
          degreesLongitude: payload.degreesLongitude,
          name: payload.name,
          address: payload.address,
        },
      };
    } else if (['image', 'video', 'document', 'audio'].includes(messageType)) {
      const built = await this.mediaManager.buildBaileysMediaMessage({
        mediaCategory: messageType,
        source: payload.source,
        base64: payload.base64,
        caption: payload.caption,
        fileName: payload.fileName,
        ptt: payload.ptt,
        clientId: item.clientId,
      });
      baileysContent = built.baileysContent;
    } else {
      throw new ValidationError(`Unsupported messageType: ${messageType}`, 'INVALID_MESSAGE_TYPE', 400);
    }

    const response = await conn.sock.sendMessage(jid, baileysContent);
    if (!response || !response.key || !response.key.id) {
      const err = new Error('WhatsApp library did not confirm message submission.');
      err.code = 'UNCONFIRMED_SUBMISSION';
      err.permanent = false;
      throw err;
    }

    // Save message to connection messageStore so Baileys getMessage callback can handle decryption retries
    conn.saveMessage(response);

    return {
      whatsappMessageId: response.key.id,
      timestamp: new Date().toISOString(),
    };
  }

  async sendText({ clientId = 'default', to, body, idempotencyKey = null }) {
    const validClientId = validateClientId(clientId);
    this.sessionManager.getAccount(validClientId);
    const jid = normalizeRecipientJid(to, { allowGroup: true });
    const text = validateTextBody(body);

    return this.queueManager.enqueue({
      clientId: validClientId,
      to: jid,
      messageType: 'text',
      payload: { text },
      idempotencyKey,
    });
  }

  async sendMedia({
    clientId = 'default',
    to,
    mediaCategory = 'image',
    source,
    base64 = null,
    caption = '',
    fileName = null,
    ptt = false,
    cooldownSeconds = undefined,
    idempotencyKey = null,
  }) {
    const validClientId = validateClientId(clientId);
    this.sessionManager.getAccount(validClientId);
    const jid = normalizeRecipientJid(to, { allowGroup: true });

    // Check optional cooldown for snapshot/media alerts
    if (source) {
      const cd = this.mediaManager.checkAndRecordCooldown({
        clientId: validClientId,
        to: jid,
        mediaSource: source,
        cooldownSecondsOverride: cooldownSeconds,
      });
      if (cd.suppressed) {
        return {
          status: 'cooldown_suppressed',
          suppressed: true,
          remainingSeconds: cd.remainingSeconds,
          clientId: validClientId,
          to: jid,
          messageType: mediaCategory,
        };
      }
    }

    // Pre-validate media input before queuing so invalid paths/SSRF fail fast with 400/403/404
    await this.mediaManager.resolveMediaInput({
      source,
      base64,
      fileName,
      mediaCategory,
      clientId: validClientId,
    });

    return this.queueManager.enqueue({
      clientId: validClientId,
      to: jid,
      messageType: mediaCategory,
      payload: {
        source: source || null,
        base64: base64 || null,
        caption: typeof caption === 'string' ? caption.slice(0, 4096) : '',
        fileName: fileName || null,
        ptt: Boolean(ptt),
      },
      idempotencyKey,
    });
  }

  async sendLocation({ clientId = 'default', to, latitude, longitude, name, address, idempotencyKey = null }) {
    const validClientId = validateClientId(clientId);
    this.sessionManager.getAccount(validClientId);
    const jid = normalizeRecipientJid(to, { allowGroup: true });
    const loc = validateLocationPayload({ latitude, longitude, name, address });

    return this.queueManager.enqueue({
      clientId: validClientId,
      to: jid,
      messageType: 'location',
      payload: loc,
      idempotencyKey,
    });
  }

  async sendGroupMessage({ clientId = 'default', groupId, body, idempotencyKey = null }) {
    const validClientId = validateClientId(clientId);
    this.sessionManager.getAccount(validClientId);
    const groupJid = normalizeRecipientJid(
      String(groupId || '').endsWith('@g.us') ? String(groupId) : `${groupId}@g.us`,
      { allowGroup: true }
    );
    if (!groupJid.endsWith('@g.us')) {
      throw new ValidationError('groupId must be a valid WhatsApp group JID (e.g. 1203630...@g.us).', 'INVALID_GROUP_JID', 400);
    }
    const text = validateTextBody(body);

    return this.queueManager.enqueue({
      clientId: validClientId,
      to: groupJid,
      messageType: 'text',
      payload: { text },
      idempotencyKey,
    });
  }
}

module.exports = {
  MessageManager,
};
