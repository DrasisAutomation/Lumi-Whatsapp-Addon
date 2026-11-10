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
const { BotConfigManager } = require('./bot/config-manager');
const { HomeAssistantClient } = require('./bot/homeassistant-client');
const { InteractiveBot } = require('./bot/interactive-bot');

async function createWhatsAppServer({
  customConfig = null,
  socketFactory = null,
  authStateFactory = null,
  autoConnect = true,
} = {}) {
  const config = customConfig || loadAddonConfig();
  const logger = createLogger(config.logLevel);

  // Guard against unhandled Baileys query timeouts (e.g. 408 Boom) or network hiccups
  if (!globalThis.__lumi_process_guards_installed__) {
    globalThis.__lumi_process_guards_installed__ = true;
    process.on('unhandledRejection', (reason) => {
      const isBaileysOrNetwork =
        reason?.message === 'Timed Out' ||
        reason?.output?.statusCode === 408 ||
        reason?.data?.output?.statusCode === 408 ||
        reason?.code === 'ECONNRESET' ||
        reason?.code === 'ETIMEDOUT' ||
        reason?.code === 'EPIPE' ||
        reason?.code === 'EAI_AGAIN' ||
        (reason?.stack && (
          reason.stack.includes('@whiskeysockets/baileys') ||
          reason.stack.includes('generics.js') ||
          reason.stack.includes('socket.js') ||
          reason.stack.includes('noise-handler')
        ));

      if (isBaileysOrNetwork) {
        logger.warn(
          {
            message: reason?.message,
            code: reason?.code || reason?.output?.statusCode || reason?.data?.output?.statusCode,
            source: 'baileys/network',
          },
          'Handled background WhatsApp/Baileys timeout or network glitch safely (prevented container restart)'
        );
      }
    });
  }
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

  const botDataDir = config.dataDir || path.dirname(config.accountsRegistryPath);
  const botConfigManager = new BotConfigManager({
    dataDir: botDataDir,
    logger,
  });
  await botConfigManager.init();

  const haClient = new HomeAssistantClient({
    dryRun: process.env.DRY_RUN === 'true',
    logger,
  });

  const interactiveBot = new InteractiveBot({
    configManager: botConfigManager,
    haClient,
    messageManager,
    eventManager,
    dataDir: botDataDir,
    logger,
  });
  interactiveBot.init();

  const app = express();
  app.disable('x-powered-by');

  // Handle Home Assistant Ingress dynamic sub-path routing
  // Home Assistant forwards requests with X-Ingress-Path header (e.g. /api/hassio_ingress/<token>)
  // Normalizing req.url strips this prefix so all internal routes (/api/..., /css/..., /) match consistently
  app.use((req, res, next) => {
    const rawIngressPath = req.headers['x-ingress-path'];
    if (rawIngressPath) {
      const ingressPath = String(rawIngressPath).replace(/\/+$/, '');
      if (req.url === ingressPath) {
        req.url = '/';
      } else if (req.url.startsWith(`${ingressPath}/`)) {
        req.url = req.url.slice(ingressPath.length);
        if (!req.url.startsWith('/')) {
          req.url = `/${req.url}`;
        }
      }
    }
    next();
  });

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
    botConfigManager,
    haClient,
    interactiveBot,
  }));

  // Serve Frontend Dashboard assets with dynamic Ingress <base> injection
  const frontendDir = path.resolve(__dirname, '..', 'frontend');
  const indexHtmlPath = path.join(frontendDir, 'index.html');

  function sendIndexHtml(req, res) {
    const rawIngressPath = req.headers['x-ingress-path'];
    const baseHref = rawIngressPath
      ? `${String(rawIngressPath).replace(/\/+$/, '')}/`
      : './';
    const rawIndexHtml = require('node:fs').readFileSync(indexHtmlPath, 'utf8');
    const htmlWithBase = rawIndexHtml.replace(
      '<head>',
      `<head>\n  <base href="${baseHref}">`
    );
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(htmlWithBase);
  }

  app.get(['/', '/index.html'], sendIndexHtml);
  app.use('/', express.static(frontendDir, { index: false }));

  app.use(errorHandlerMiddleware(logger));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const rawIngressPath = request.headers?.['x-ingress-path'];
    if (rawIngressPath && typeof request.url === 'string') {
      const ingressPath = String(rawIngressPath).replace(/\/+$/, '');
      if (request.url === ingressPath) {
        request.url = '/';
      } else if (request.url.startsWith(`${ingressPath}/`)) {
        request.url = request.url.slice(ingressPath.length);
        if (!request.url.startsWith('/')) {
          request.url = `/${request.url}`;
        }
      }
    }

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
    interactiveBot?.close();
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
    botConfigManager,
    haClient,
    interactiveBot,
    close,
  };
}

module.exports = {
  createWhatsAppServer,
};
