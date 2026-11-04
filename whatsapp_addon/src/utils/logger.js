'use strict';

const pino = require('pino');

const SENSITIVE_KEYS = [
  'api_key',
  'apiKey',
  'token',
  'authorization',
  'headers.authorization',
  'qr',
  'qrCode',
  'qrDataUrl',
  'creds',
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'advSecretKey',
  'body.text',
  'text',
  'caption',
];

function createLogger(level = process.env.LOG_LEVEL || 'info') {
  const validLevels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
  const normalizedLevel = validLevels.has(String(level).toLowerCase())
    ? String(level).toLowerCase()
    : 'info';

  return pino({
    level: normalizedLevel,
    redact: {
      paths: SENSITIVE_KEYS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
    },
  });
}

const defaultLogger = createLogger();

module.exports = {
  createLogger,
  logger: defaultLogger,
};
