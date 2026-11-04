'use strict';

const EventEmitter = require('node:events');

/**
 * Baileys WAMessageStatus enum mapping:
 * 0 = ERROR -> failed
 * 1 = PENDING -> sending
 * 2 = SERVER_ACK -> sent
 * 3 = DELIVERY_ACK -> delivered
 * 4 = READ -> read
 * 5 = PLAYED -> played
 */
const BAILEYS_STATUS_MAP = {
  0: 'failed',
  1: 'sending',
  2: 'sent',
  3: 'delivered',
  4: 'read',
  5: 'played',
  ERROR: 'failed',
  PENDING: 'sending',
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'played',
};

class WhatsAppEventManager extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.seenIncomingMessageIds = new Map(); // key -> timestamp
    this.seenStatusUpdates = new Map(); // key -> status
    this.maxDedupEntries = 2000;
  }

  _pruneMap(map) {
    if (map.size <= this.maxDedupEntries) return;
    const keysToRemove = Array.from(map.keys()).slice(0, Math.floor(this.maxDedupEntries / 3));
    for (const k of keysToRemove) {
      map.delete(k);
    }
  }

  /**
   * Extracts normalized incoming message info from a Baileys WAMessage.
   * Returns null if message is outgoing (fromMe), status@broadcast, or protocol message.
   */
  parseIncomingBaileysMessage(clientId, msg) {
    if (!msg || !msg.key) return null;
    if (msg.key.fromMe) return null; // Never treat outgoing messages as incoming!
    const remoteJid = msg.key.remoteJid || '';
    if (!remoteJid || remoteJid === 'status@broadcast') return null;

    const messageId = msg.key.id;
    if (!messageId) return null;

    const dedupKey = `${clientId}:${messageId}`;
    if (this.seenIncomingMessageIds.has(dedupKey)) {
      return null;
    }

    // Unwrap ephemeral / viewOnce containers if present
    let content = msg.message;
    if (!content) return null;
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    }
    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
    }
    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
    }

    let messageType = null;
    let text = '';

    if (typeof content.conversation === 'string') {
      messageType = 'text';
      text = content.conversation;
    } else if (content.extendedTextMessage) {
      messageType = 'text';
      text = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      messageType = 'image';
      text = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      messageType = 'video';
      text = content.videoMessage.caption || '';
    } else if (content.documentMessage || content.documentWithCaptionMessage) {
      messageType = 'document';
      const docMsg =
        content.documentMessage ||
        content.documentWithCaptionMessage?.message?.documentMessage ||
        {};
      text = docMsg.caption || docMsg.fileName || '';
    } else if (content.audioMessage) {
      messageType = content.audioMessage.ptt ? 'voice_note' : 'audio';
      text = '';
    } else {
      // Ignore protocolMessage, reactionMessage, senderKeyDistributionMessage, etc.
      return null;
    }

    this.seenIncomingMessageIds.set(dedupKey, Date.now());
    this._pruneMap(this.seenIncomingMessageIds);

    const isGroup = remoteJid.endsWith('@g.us');
    const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;
    const senderNumber = senderJid.replace(/@(s\.whatsapp\.net|lid|g\.us)$/, '');

    const rawTimestamp = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : Date.now();

    return {
      event: 'new_whatsapp_message',
      clientId,
      messageId,
      sender: senderNumber,
      senderJid,
      senderName: msg.pushName || senderNumber,
      isGroup,
      groupId: isGroup ? remoteJid : null,
      messageType,
      text,
      timestamp: new Date(rawTimestamp).toISOString(),
    };
  }

  emitIncomingMessage(parsedMessage) {
    if (!parsedMessage) return;
    this.emit('event', {
      type: 'new_whatsapp_message',
      timestamp: parsedMessage.timestamp,
      payload: parsedMessage,
    });
  }

  emitMessageSent({ clientId, queueId, messageId, to, messageType, timestamp }) {
    const ts = timestamp || new Date().toISOString();
    this.emit('event', {
      type: 'whatsapp_message_sent',
      timestamp: ts,
      payload: {
        clientId,
        queueId,
        messageId,
        recipient: to,
        messageType,
        status: 'sent',
        timestamp: ts,
      },
    });
  }

  emitSendMessageResult({ clientId, queueId, messageId, to, messageType, status, error = null, timestamp }) {
    const ts = timestamp || new Date().toISOString();
    this.emit('event', {
      type: 'whatsapp_send_message_result',
      timestamp: ts,
      payload: {
        clientId,
        queueId,
        messageId,
        recipient: to,
        messageType,
        status,
        error,
        timestamp: ts,
      },
    });
  }

  emitMessageStatus({ clientId, messageId, to, status, error = null, timestamp }) {
    if (!messageId || !status) return false;
    const dedupKey = `${clientId}:${messageId}:${status}`;
    if (this.seenStatusUpdates.has(dedupKey)) {
      return false;
    }
    this.seenStatusUpdates.set(dedupKey, Date.now());
    this._pruneMap(this.seenStatusUpdates);

    const ts = timestamp || new Date().toISOString();
    this.emit('event', {
      type: 'whatsapp_message_status',
      timestamp: ts,
      payload: {
        clientId,
        messageId,
        recipient: to || null,
        status,
        error,
        timestamp: ts,
      },
    });
    return true;
  }

  emitConnectionUpdate({ clientId, status, phone, qrAvailable, lastConnectedAt, error = null }) {
    const ts = new Date().toISOString();
    this.emit('event', {
      type: 'whatsapp_connection_update',
      timestamp: ts,
      payload: {
        clientId,
        status,
        phone: phone || null,
        qrAvailable: Boolean(qrAvailable),
        lastConnectedAt: lastConnectedAt || null,
        error,
        timestamp: ts,
      },
    });
  }

  emitQrUpdate({ clientId, qrDataUrl, expiresAt }) {
    const ts = new Date().toISOString();
    this.emit('event', {
      type: 'qr_update',
      timestamp: ts,
      payload: {
        clientId,
        qrDataUrl,
        expiresAt,
        timestamp: ts,
      },
    });
  }
}

module.exports = {
  BAILEYS_STATUS_MAP,
  WhatsAppEventManager,
};
