'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { writeJsonAtomic, readJsonSafe, ensureDir } = require('./storage');
const { isPermanentError, calculateBackoffDelayMs } = require('./retry');

const DEFAULT_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Persistent Per-Account Sequential Message Queue.
 * Guarantees:
 * - Independent queue per clientId
 * - Sequential processing per account (prevents Signal ratchet race conditions)
 * - Configurable retry limits with exponential backoff
 * - Duplicate/idempotency prevention (never resends an already-submitted WhatsApp message)
 * - Message expiry & failure history
 * - Disk persistence & automatic recovery across restarts
 */
class MessageQueueManager extends EventEmitter {
  constructor({
    queueDir,
    executor,
    maxRetries = 3,
    baseDelayMs = 2000,
    expiryMs = DEFAULT_EXPIRY_MS,
    maxHistoryPerAccount = 250,
    logger,
  }) {
    super();
    this.queueDir = queueDir;
    this.executor = executor; // async (item) => { whatsappMessageId, timestamp }
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.expiryMs = expiryMs;
    this.maxHistoryPerAccount = maxHistoryPerAccount;
    this.logger = logger;

    this.queues = new Map(); // clientId -> Array<QueueItem>
    this.processing = new Map(); // clientId -> boolean
    this.timers = new Map(); // clientId -> Timeout
    this.idempotencyIndex = new Map(); // idempotencyKey -> QueueItem
    this.failureHistory = []; // Array of recent failure diagnostics
    this.stopped = false;
  }

  async init(clientIds = []) {
    await ensureDir(this.queueDir);
    for (const clientId of clientIds) {
      await this.loadAccountQueue(clientId);
    }
  }

  _queueFilePath(clientId) {
    return path.join(this.queueDir, `${clientId}.queue.json`);
  }

  async loadAccountQueue(clientId) {
    const filePath = this._queueFilePath(clientId);
    const saved = await readJsonSafe(filePath, { items: [] });
    const items = Array.isArray(saved?.items) ? saved.items : [];

    // Recover interrupted 'sending' items:
    // CRITICAL: If item already has submittedToWhatsApp=true, do NOT resend it! Mark it 'sent'.
    // Otherwise reset 'sending' back to 'queued' for retry.
    for (const item of items) {
      if (item.status === 'sending') {
        if (item.submittedToWhatsApp) {
          item.status = 'sent';
        } else {
          item.status = 'queued';
        }
      }
      if (item.idempotencyKey) {
        this.idempotencyIndex.set(`${clientId}:${item.idempotencyKey}`, item);
      }
    }

    this.queues.set(clientId, items);
    await this._persistAccountQueue(clientId);
    this._scheduleProcessing(clientId, 50);
  }

  async _persistAccountQueue(clientId) {
    const items = this.queues.get(clientId) || [];
    // Keep all active items + bounded completed/failed items
    const active = items.filter((i) => i.status === 'queued' || i.status === 'sending');
    const finished = items
      .filter((i) => i.status !== 'queued' && i.status !== 'sending')
      .slice(-this.maxHistoryPerAccount);
    const merged = [...finished, ...active];
    this.queues.set(clientId, merged);
    await writeJsonAtomic(this._queueFilePath(clientId), {
      clientId,
      updatedAt: new Date().toISOString(),
      items: merged,
    });
  }

  async enqueue({
    clientId,
    to,
    messageType,
    payload,
    idempotencyKey = null,
    waitForSubmission = true,
    timeoutMs = 30000,
  }) {
    if (!this.queues.has(clientId)) {
      await this.loadAccountQueue(clientId);
    }

    if (idempotencyKey) {
      const compositeKey = `${clientId}:${idempotencyKey}`;
      const existing = this.idempotencyIndex.get(compositeKey);
      if (existing && existing.status !== 'failed') {
        return existing;
      }
    }

    const now = Date.now();
    const queueId = `q_${now}_${crypto.randomBytes(5).toString('hex')}`;
    const item = {
      queueId,
      messageId: queueId, // Updated to WhatsApp key.id once submitted
      clientId,
      to,
      messageType,
      payload,
      idempotencyKey,
      status: 'queued',
      submittedToWhatsApp: false,
      attempts: 0,
      maxRetries: this.maxRetries,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.expiryMs).toISOString(),
      nextAttemptAt: now,
      lastError: null,
    };

    const list = this.queues.get(clientId);
    list.push(item);
    if (idempotencyKey) {
      this.idempotencyIndex.set(`${clientId}:${idempotencyKey}`, item);
    }

    await this._persistAccountQueue(clientId);
    this.emit('status_change', { ...item, payload: undefined });

    let submissionPromise = null;
    if (waitForSubmission) {
      submissionPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          // Return current queued item if still waiting in queue
          resolve(item);
        }, timeoutMs);

        const onSubmitted = (updated) => {
          if (updated.queueId === queueId) {
            cleanup();
            resolve(updated);
          }
        };

        const onFailed = (updated) => {
          if (updated.queueId === queueId) {
            cleanup();
            const err = new Error(updated.lastError?.message || 'Failed to send WhatsApp message');
            err.code = updated.lastError?.code || 'SEND_FAILED';
            err.queueItem = updated;
            reject(err);
          }
        };

        const cleanup = () => {
          clearTimeout(timer);
          this.removeListener('submitted', onSubmitted);
          this.removeListener('failed', onFailed);
        };

        this.on('submitted', onSubmitted);
        this.on('failed', onFailed);
      });
    }

    this._scheduleProcessing(clientId, 0);

    return waitForSubmission ? submissionPromise : item;
  }

  notifyAccountConnected(clientId) {
    this._scheduleProcessing(clientId, 50);
  }

  _scheduleProcessing(clientId, delayMs = 0) {
    if (this.stopped) return;
    if (this.timers.has(clientId)) {
      clearTimeout(this.timers.get(clientId));
    }
    const timer = setTimeout(() => {
      this.timers.delete(clientId);
      this._processLoop(clientId).catch((err) => {
        this.logger?.error({ err, clientId }, 'Unexpected error in queue processor');
      });
    }, Math.max(0, delayMs));
    this.timers.set(clientId, timer);
  }

  async _processLoop(clientId) {
    if (this.stopped || this.processing.get(clientId)) {
      return;
    }
    this.processing.set(clientId, true);

    try {
      const items = this.queues.get(clientId) || [];
      while (!this.stopped) {
        const now = Date.now();
        const nextItem = items.find((i) => i.status === 'queued' && i.nextAttemptAt <= now);

        if (!nextItem) {
          // Check if there are future delayed items
          const delayedItems = items.filter((i) => i.status === 'queued' && i.nextAttemptAt > now);
          if (delayedItems.length > 0) {
            const earliest = Math.min(...delayedItems.map((i) => i.nextAttemptAt));
            this._scheduleProcessing(clientId, earliest - now);
          }
          break;
        }

        // Check message expiry before attempting submission
        if (new Date(nextItem.expiresAt).getTime() <= now) {
          nextItem.status = 'failed';
          nextItem.updatedAt = new Date().toISOString();
          nextItem.lastError = {
            code: 'MESSAGE_EXPIRED',
            message: 'Message expired in queue before it could be delivered.',
            timestamp: nextItem.updatedAt,
          };
          this._recordFailure(nextItem);
          await this._persistAccountQueue(clientId);
          this.emit('status_change', { ...nextItem, payload: undefined });
          this.emit('failed', nextItem);
          continue;
        }

        // Never resend a message already submitted to WhatsApp
        if (nextItem.submittedToWhatsApp) {
          nextItem.status = 'sent';
          nextItem.updatedAt = new Date().toISOString();
          await this._persistAccountQueue(clientId);
          this.emit('submitted', nextItem);
          continue;
        }

        nextItem.status = 'sending';
        nextItem.attempts += 1;
        nextItem.updatedAt = new Date().toISOString();
        await this._persistAccountQueue(clientId);
        this.emit('status_change', { ...nextItem, payload: undefined });

        try {
          const result = await this.executor(nextItem);
          nextItem.submittedToWhatsApp = true;
          nextItem.status = 'sent';
          if (result && result.whatsappMessageId) {
            nextItem.messageId = result.whatsappMessageId;
          }
          nextItem.sentAt = new Date().toISOString();
          nextItem.updatedAt = nextItem.sentAt;
          nextItem.lastError = null;
          // Scrub raw media buffer/base64 from stored payload after successful send
          if (nextItem.payload && nextItem.payload.base64) {
            delete nextItem.payload.base64;
          }
          await this._persistAccountQueue(clientId);
          this.emit('status_change', { ...nextItem, payload: undefined });
          this.emit('submitted', nextItem);
        } catch (err) {
          const permanent = isPermanentError(err);
          const exhausted = nextItem.attempts > nextItem.maxRetries;

          nextItem.updatedAt = new Date().toISOString();
          nextItem.lastError = {
            code: err.code || 'SEND_ERROR',
            message: err.message || 'Unknown send error',
            permanent,
            attempt: nextItem.attempts,
            timestamp: nextItem.updatedAt,
          };

          if (permanent || exhausted) {
            nextItem.status = 'failed';
            this._recordFailure(nextItem);
            await this._persistAccountQueue(clientId);
            this.emit('status_change', { ...nextItem, payload: undefined });
            this.emit('failed', nextItem);
          } else {
            const backoffMs = calculateBackoffDelayMs(nextItem.attempts - 1, this.baseDelayMs);
            nextItem.status = 'queued';
            nextItem.nextAttemptAt = Date.now() + backoffMs;
            await this._persistAccountQueue(clientId);
            this.emit('status_change', { ...nextItem, payload: undefined });
            this.emit('retry_scheduled', {
              clientId,
              queueId: nextItem.queueId,
              attempt: nextItem.attempts,
              maxRetries: nextItem.maxRetries,
              backoffMs,
              error: nextItem.lastError,
            });
            // If account is temporarily disconnected, pause loop until backoff timer
            this._scheduleProcessing(clientId, backoffMs);
            break;
          }
        }
      }
    } finally {
      this.processing.set(clientId, false);
    }
  }

  async updateReceiptStatus(clientId, whatsappMessageId, newStatus) {
    const validReceiptHierarchy = {
      queued: 1,
      sending: 2,
      sent: 3,
      delivered: 4,
      read: 5,
      played: 6,
    };
    const items = this.queues.get(clientId) || [];
    const target = items.find((i) => i.messageId === whatsappMessageId || i.queueId === whatsappMessageId);
    if (!target) {
      return null;
    }

    const currentRank = validReceiptHierarchy[target.status] || 0;
    const nextRank = validReceiptHierarchy[newStatus] || 0;

    if (nextRank > currentRank) {
      target.status = newStatus;
      target.updatedAt = new Date().toISOString();
      await this._persistAccountQueue(clientId);
      this.emit('status_change', { ...target, payload: undefined });
    }
    return target;
  }

  _recordFailure(item) {
    this.failureHistory.push({
      queueId: item.queueId,
      messageId: item.messageId,
      clientId: item.clientId,
      to: item.to,
      messageType: item.messageType,
      attempts: item.attempts,
      error: item.lastError,
      timestamp: item.updatedAt,
    });
    if (this.failureHistory.length > 100) {
      this.failureHistory.shift();
    }
  }

  getAccountStats(clientId) {
    const items = this.queues.get(clientId) || [];
    let pending = 0;
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      if (item.status === 'queued' || item.status === 'sending') {
        pending += 1;
      } else if (item.status === 'failed') {
        failed += 1;
      } else {
        sent += 1;
      }
    }
    return { pending, sent, failed };
  }

  getMessages({ clientId = null, limit = 100 } = {}) {
    const all = [];
    for (const [cId, items] of this.queues.entries()) {
      if (clientId && cId !== clientId) continue;
      for (const item of items) {
        all.push({
          queueId: item.queueId,
          messageId: item.messageId,
          clientId: item.clientId,
          to: item.to,
          messageType: item.messageType,
          status: item.status,
          attempts: item.attempts,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          lastError: item.lastError,
        });
      }
    }
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all.slice(0, Math.min(Number(limit) || 100, 500));
  }

  getMessageById(messageId) {
    for (const items of this.queues.values()) {
      const found = items.find((i) => i.messageId === messageId || i.queueId === messageId);
      if (found) {
        return {
          queueId: found.queueId,
          messageId: found.messageId,
          clientId: found.clientId,
          to: found.to,
          messageType: found.messageType,
          status: found.status,
          submittedToWhatsApp: found.submittedToWhatsApp,
          attempts: found.attempts,
          createdAt: found.createdAt,
          updatedAt: found.updatedAt,
          lastError: found.lastError,
        };
      }
    }
    return null;
  }

  getDiagnostics() {
    const perAccount = {};
    for (const clientId of this.queues.keys()) {
      perAccount[clientId] = {
        ...this.getAccountStats(clientId),
        isProcessing: Boolean(this.processing.get(clientId)),
      };
    }
    return {
      accounts: perAccount,
      recentFailures: this.failureHistory.slice(-25),
    };
  }

  async removeAccountQueue(clientId) {
    if (this.timers.has(clientId)) {
      clearTimeout(this.timers.get(clientId));
      this.timers.delete(clientId);
    }
    this.queues.delete(clientId);
    this.processing.delete(clientId);
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

module.exports = {
  MessageQueueManager,
};
