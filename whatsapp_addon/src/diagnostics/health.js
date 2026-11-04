'use strict';

const os = require('node:os');
const pkg = require('../../package.json');

/**
 * Diagnostics & Health Collector.
 * Tracks connection errors, authentication errors, media upload failures,
 * retry telemetry, and runtime metrics while guaranteeing zero exposure
 * of QR codes, private keys, tokens, or private message contents.
 */
class HealthDiagnostics {
  constructor() {
    this.startedAt = Date.now();
    this.connectionErrors = [];
    this.authErrors = [];
    this.mediaErrors = [];
    this.retryEvents = [];
    this.maxEvents = 50;
  }

  _pushBounded(arr, entry) {
    arr.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    if (arr.length > this.maxEvents) {
      arr.shift();
    }
  }

  recordConnectionError({ clientId, code, message, statusCode }) {
    this._pushBounded(this.connectionErrors, {
      clientId,
      code: String(code || 'CONNECTION_ERROR'),
      statusCode: statusCode || null,
      message: this._sanitizeText(message),
    });
  }

  recordAuthError({ clientId, code, message }) {
    this._pushBounded(this.authErrors, {
      clientId,
      code: String(code || 'AUTH_ERROR'),
      message: this._sanitizeText(message),
    });
  }

  recordMediaError({ clientId, mediaType, sourceType, code, message }) {
    this._pushBounded(this.mediaErrors, {
      clientId,
      mediaType: String(mediaType || 'unknown'),
      sourceType: String(sourceType || 'unknown'),
      code: String(code || 'MEDIA_ERROR'),
      message: this._sanitizeText(message),
    });
  }

  recordRetry({ clientId, queueId, attempt, maxRetries, backoffMs, error }) {
    this._pushBounded(this.retryEvents, {
      clientId,
      queueId,
      attempt,
      maxRetries,
      backoffMs,
      errorCode: error?.code || 'RETRY',
      errorMessage: this._sanitizeText(error?.message),
    });
  }

  _sanitizeText(text) {
    if (!text) return '';
    // Strip any accidental bearer token or base64 data
    return String(text)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_QR_OR_IMAGE]')
      .slice(0, 300);
  }

  getHealthSummary(sessionManager, queueManager) {
    const accounts = sessionManager ? sessionManager.listAccounts() : [];
    const connectedCount = accounts.filter((a) => a.status === 'connected').length;
    const disconnectedCount = accounts.length - connectedCount;

    return {
      status: 'ok',
      version: pkg.version,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      accountsTotal: accounts.length,
      accountsConnected: connectedCount,
      accountsDisconnected: disconnectedCount,
      queue: queueManager ? queueManager.getDiagnostics().accounts : {},
    };
  }

  getFullDiagnostics(sessionManager, queueManager) {
    const health = this.getHealthSummary(sessionManager, queueManager);
    const accounts = sessionManager
      ? sessionManager.listAccounts().map((a) => ({
          clientId: a.clientId,
          name: a.name,
          status: a.status,
          sessionHealth: a.sessionHealth,
          lastConnectedAt: a.lastConnectedAt,
          lastDisconnectedAt: a.lastDisconnectedAt,
          lastError: a.lastError,
          reconnectAttempts: a.reconnectAttempts || 0,
          stats: a.stats,
        }))
      : [];

    return {
      health,
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryRssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        loadAvg: os.loadavg(),
      },
      sessions: accounts,
      queue: queueManager ? queueManager.getDiagnostics() : {},
      connectionErrors: this.connectionErrors.slice().reverse(),
      authErrors: this.authErrors.slice().reverse(),
      mediaUploadFailures: this.mediaErrors.slice().reverse(),
      retryAttempts: this.retryEvents.slice().reverse(),
    };
  }
}

module.exports = {
  HealthDiagnostics,
};
