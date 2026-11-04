'use strict';

const PERMANENT_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'INVALID_CLIENT_ID',
  'INVALID_RECIPIENT',
  'INVALID_GROUP_JID',
  'INVALID_USER_JID',
  'EMPTY_MESSAGE_TEXT',
  'MESSAGE_TOO_LONG',
  'INVALID_LOCATION',
  'INVALID_MEDIA_URL',
  'UNSUPPORTED_URL_PROTOCOL',
  'SSRF_BLOCKED',
  'PATH_TRAVERSAL_BLOCKED',
  'SYMLINK_ESCAPE_BLOCKED',
  'INVALID_MEDIA_PATH',
  'INVALID_MEDIA_CONTENT',
  'UNSUPPORTED_IMAGE_FORMAT',
  'UNSUPPORTED_VIDEO_FORMAT',
  'UNSUPPORTED_AUDIO_FORMAT',
  'FILE_NOT_FOUND',
  'MEDIA_TOO_LARGE',
  'ACCOUNT_LOGGED_OUT',
  'ACCOUNT_NOT_FOUND',
  'NUMBER_NOT_ON_WHATSAPP',
  'MESSAGE_EXPIRED',
]);

function isPermanentError(err) {
  if (!err) return false;
  if (err.permanent === true) return true;
  if (err.code && PERMANENT_ERROR_CODES.has(err.code)) return true;
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408 && err.statusCode !== 429) {
    return true;
  }
  return false;
}

function calculateBackoffDelayMs(attempt, baseDelayMs = 2000, maxDelayMs = 60000) {
  const exp = Math.min(attempt, 6);
  const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp));
  const jitter = Math.floor(raw * 0.15 * Math.random());
  return raw + jitter;
}

async function retryWithBackoff(fn, { maxRetries = 3, baseDelayMs = 2000, maxDelayMs = 60000, onRetry = null } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (isPermanentError(err) || attempt >= maxRetries) {
        throw err;
      }
      attempt += 1;
      const delayMs = calculateBackoffDelayMs(attempt - 1, baseDelayMs, maxDelayMs);
      if (typeof onRetry === 'function') {
        onRetry({ attempt, maxRetries, delayMs, error: err });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = {
  PERMANENT_ERROR_CODES,
  isPermanentError,
  calculateBackoffDelayMs,
  retryWithBackoff,
};
