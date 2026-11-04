'use strict';

const { normalizeRemoteIp } = require('./auth');

function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function createRateLimiter({ windowMs = 60000, maxRequests = 180 } = {}) {
  const buckets = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of buckets.entries()) {
      if (now >= entry.resetAt) {
        buckets.delete(ip);
      }
    }
  }, windowMs);
  cleanupTimer.unref?.();

  return (req, res, next) => {
    const ip = normalizeRemoteIp(req) || 'unknown';
    const now = Date.now();
    let entry = buckets.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, entry);
    }

    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));

    if (entry.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down and retry shortly.',
        },
      });
    }

    return next();
  };
}

function createRequestTimeoutMiddleware(timeoutMs = 35000) {
  return (req, res, next) => {
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({
          ok: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'Request timed out.',
          },
        });
      }
    });
    next();
  };
}

function errorHandlerMiddleware(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const statusCode =
      Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : err.type === 'entity.too.large'
          ? 413
          : 500;

    const code = err.code || (statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR');
    const message =
      statusCode >= 500 && !err.expose
        ? err.message || 'An unexpected server error occurred.'
        : err.message || 'Request failed.';

    if (statusCode >= 500) {
      logger?.error({ err, path: req.path, method: req.method }, 'API error');
    } else {
      logger?.warn({ code, statusCode, path: req.path, method: req.method }, message);
    }

    if (!res.headersSent) {
      res.status(statusCode).json({
        ok: false,
        error: {
          code,
          message,
        },
      });
    }
  };
}

module.exports = {
  securityHeadersMiddleware,
  createRateLimiter,
  createRequestTimeoutMiddleware,
  errorHandlerMiddleware,
};
