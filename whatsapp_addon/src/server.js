'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLogger } = require('./utils/logger');
const { loadAddonConfig } = require('./services/storage');
const { HealthDiagnostics } = require('./diagnostics/health');
const { WhatsAppEventManager } = require('./whatsapp/event-manager');
const { ContactManager } = require('./whatsapp/contact-manager');
const { MediaManager } = require('./whatsapp/media-manager');
const { SessionManager } = require('./whatsapp/session-manager');
const { MessageQueueManager } = require('./services/queue');
const { MessageManager } = require('./whatsapp/message-manager');
const {
  isRequestAuthenticated,
  createAuthMiddleware,
} = require('./api/auth');
const {
  securityHeadersMiddleware,
  createRateLimiter,
  createRequestTimeoutMiddleware,
  errorHandlerMiddleware,
} = require('./api/middleware');
const { createApiRouter } = require('./api/routes');

async function createWhatsAppServer({
  customConfig = null,
  socketFactory = null,
  authStateFactory = null,
  autoConnect = true,
} = {}) {
  const config = customConfig || loadAddonConfig();
  const logger = createLogger(config.logLevel);
  const diagnostics = new HealthDiagnostics();
  const eventManager = new WhatsAppEventManager({ logger });
  const contactManager = new ContactManager({ logger });

  const mediaManager = new MediaManager({
    allowedDirs: config.allowedMediaDirs,
    allowedLocalHosts: config.allowedLocalHosts,
    maxSizeMb: config.mediaMaxSizeMb,
    snapshotWaitTimeoutMs: config.snapshotWaitTimeoutMs,
    cooldownSeconds: config.cooldownSeconds,
    diagnostics,
    logger,
  });

  const sessionManager = new SessionManager({
    sessionsDir: config.sessionsDir,
    registryPath: config.accountsRegistryPath,
    eventManager,
    contactManager,
    diagnostics,
    logger,
    socketFactory,
    authStateFactory,
  });

  let messageManager;
  const queueManager = new MessageQueueManager({
    queueDir: config.queueDir,
    executor: async (item) => messageManager.executeQueueItem(item),
    maxRetries: config.maxRetries,
    baseDelayMs: config.retryBaseDelayMs,
    logger,
  });

  queueManager.on('retry_scheduled', (info) => {
    diagnostics.recordRetry(info);
  });

  messageManager = new MessageManager({
    sessionManager,
    queueManager,
    mediaManager,
    eventManager,
    contactManager,
    logger,
  });

  await sessionManager.init({ autoConnect });
  const initialClientIds = sessionManager.listAccounts().map((a) => a.clientId);
  await queueManager.init(initialClientIds);

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeadersMiddleware);
  app.use(createRequestTimeoutMiddleware(35000));
  app.use(createRateLimiter({ windowMs: 60000, maxRequests: 240 }));
  app.use(express.json({ limit: `${Math.min(config.mediaMaxSizeMb + 10, 70)}mb` }));

  const authMiddleware = createAuthMiddleware(config.apiKey);

  // Public local container health probe ONLY from 127.0.0.1 for Docker HEALTHCHECK;
  // all external/network callers still require Bearer token or Supervisor Ingress
  app.get('/api/health', (req, res, next) => {
    const remoteIp = req.socket?.remoteAddress || '';
    const isLocalLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    if (isLocalLoopback || isRequestAuthenticated(req, config.apiKey)) {
      const summary = diagnostics.getHealthSummary(sessionManager, queueManager);
      return res.json({ ok: true, ...summary });
    }
    return authMiddleware(req, res, next);
  });

  // Protect all /api/* routes with Bearer Token or Supervisor Ingress authentication
  app.use('/api', authMiddleware, createApiRouter({
    sessionManager,
    messageManager,
    queueManager,
    contactManager,
    diagnostics,
    config,
  }));

  // Protect Frontend Dashboard: Must be accessed via Home Assistant Ingress or authenticated session
  const frontendDir = path.resolve(__dirname, '..', 'frontend');
  app.use(
    '/',
    (req, res, next) => {
      if (isRequestAuthenticated(req, config.apiKey)) {
        return next();
      }
      return res.status(401).json({
        ok: false,
        error: {
          code: 'INGRESS_REQUIRED',
          message: 'Direct unauthenticated access is disabled. Open the Web UI via Home Assistant Ingress or provide a valid Bearer token.',
        },
      });
    },
    express.static(frontendDir)
  );

  app.use(errorHandlerMiddleware(logger));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!isRequestAuthenticated(request, config.apiKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'initial_state',
        timestamp: new Date().toISOString(),
        payload: {
          health: diagnostics.getHealthSummary(sessionManager, queueManager),
          accounts: sessionManager.listAccounts(),
        },
      })
    );
  });

  const broadcastEvent = (envelope) => {
    const serialized = JSON.stringify(envelope);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(serialized);
      }
    }
  };

  eventManager.on('event', broadcastEvent);
  queueManager.on('status_change', (item) => {
    broadcastEvent({
      type: 'queue_item_update',
      timestamp: new Date().toISOString(),
      payload: item,
    });
  });

  const close = async () => {
    queueManager.stop();
    await sessionManager.stopAll();
    for (const client of wss.clients) {
      client.terminate();
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return {
    app,
    server,
    wss,
    config,
    logger,
    diagnostics,
    eventManager,
    contactManager,
    mediaManager,
    sessionManager,
    queueManager,
    messageManager,
    close,
  };
}

module.exports = {
  createWhatsAppServer,
};
