'use strict';

const crypto = require('node:crypto');

const SUPERVISOR_INGRESS_IPS = new Set([
  '172.30.32.2',
  '::ffff:172.30.32.2',
]);

function normalizeRemoteIp(reqOrSocket) {
  const raw =
    reqOrSocket?.socket?.remoteAddress ||
    reqOrSocket?.connection?.remoteAddress ||
    reqOrSocket?.remoteAddress ||
    '';
  return String(raw).trim();
}

function isSupervisorIngressRequest(req) {
  return Boolean(req.headers?.['x-ingress-path'] || req.headers?.['x-hassio-key']);
}

function verifyBearerToken(providedToken, expectedToken) {
  if (typeof providedToken !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }
  const a = Buffer.from(providedToken.trim(), 'utf8');
  const b = Buffer.from(expectedToken.trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function extractTokenFromRequest(req) {
  const authHeader = req.headers?.authorization || '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerToken = req.headers?.['x-whatsapp-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  if (typeof req.url === 'string' && req.url.includes('?')) {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const queryToken = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('apiKey');
      if (queryToken) {
        return queryToken.trim();
      }
    } catch {
      // Ignore URL parse error
    }
  }
  return null;
}

function isRequestAuthenticated(req, apiKey) {
  if (isSupervisorIngressRequest(req)) {
    return true;
  }
  const token = extractTokenFromRequest(req);
  if (!token) {
    return false;
  }
  return verifyBearerToken(token, apiKey);
}

function createAuthMiddleware(apiKey) {
  return (req, res, next) => {
    if (isRequestAuthenticated(req, apiKey)) {
      return next();
    }
    return res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Valid Bearer authentication token or Home Assistant Ingress session is required.',
      },
    });
  };
}

module.exports = {
  SUPERVISOR_INGRESS_IPS,
  normalizeRemoteIp,
  isSupervisorIngressRequest,
  verifyBearerToken,
  extractTokenFromRequest,
  isRequestAuthenticated,
  createAuthMiddleware,
};
