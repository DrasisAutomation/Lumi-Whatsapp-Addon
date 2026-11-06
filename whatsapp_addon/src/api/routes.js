'use strict';

const path = require('node:path');
const express = require('express');
const { validateClientId } = require('../utils/validation');

function createApiRouter({
  sessionManager,
  messageManager,
  queueManager,
  contactManager,
  diagnostics,
  config,
  botConfigManager,
  haClient,
  interactiveBot,
}) {
  const router = express.Router();

  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  // 1. GET /api/health
  router.get(
    '/health',
    asyncHandler(async (req, res) => {
      const summary = diagnostics.getHealthSummary(sessionManager, queueManager);
      res.json({ ok: true, ...summary });
    })
  );

  // 2. GET /api/accounts
  router.get(
    '/accounts',
    asyncHandler(async (req, res) => {
      const accounts = sessionManager.listAccounts();
      res.json({ ok: true, accounts });
    })
  );

  // 3. GET /api/accounts/:clientId
  router.get(
    '/accounts/:clientId',
    asyncHandler(async (req, res) => {
      const account = sessionManager.getAccount(req.params.clientId);
      res.json({ ok: true, account });
    })
  );

  // 4. POST /api/accounts
  router.post(
    '/accounts',
    asyncHandler(async (req, res) => {
      const { clientId, name, connectImmediately = true } = req.body || {};
      const account = await sessionManager.createAccount({
        clientId,
        name,
        connectImmediately: Boolean(connectImmediately),
      });
      await queueManager.loadAccountQueue(account.clientId);
      res.status(201).json({ ok: true, account });
    })
  );

  // 5. POST /api/accounts/:clientId/connect
  router.post(
    '/accounts/:clientId/connect',
    asyncHandler(async (req, res) => {
      const { regenerateQr = false, resetSession = false } = req.body || {};
      const account = await sessionManager.connectAccount(req.params.clientId, {
        regenerateQr: Boolean(regenerateQr),
        resetSession: Boolean(resetSession),
      });
      res.json({ ok: true, account });
    })
  );

  // 6. POST /api/accounts/:clientId/disconnect
  router.post(
    '/accounts/:clientId/disconnect',
    asyncHandler(async (req, res) => {
      const account = await sessionManager.disconnectAccount(req.params.clientId);
      res.json({ ok: true, account });
    })
  );

  // 7. DELETE /api/accounts/:clientId
  router.delete(
    '/accounts/:clientId',
    asyncHandler(async (req, res) => {
      const confirmed =
        req.query.confirm === 'true' ||
        req.body?.confirm === true ||
        req.body?.confirm === 'true';
      const result = await sessionManager.deleteAccount(req.params.clientId, { confirmed });
      await queueManager.removeAccountQueue(result.clientId);
      res.json({ ok: true, ...result });
    })
  );

  // 8. GET /api/accounts/:clientId/qr
  router.get(
    '/accounts/:clientId/qr',
    asyncHandler(async (req, res) => {
      const conn = sessionManager.getConnection(req.params.clientId);
      res.json({ ok: true, ...conn.getQrInfo() });
    })
  );

  // 9. POST /api/messages/send (Text, or generic message dispatch)
  router.post(
    '/messages/send',
    asyncHandler(async (req, res) => {
      const { clientId = 'default', to, body, text, idempotencyKey } = req.body || {};
      const result = await messageManager.sendText({
        clientId,
        to,
        body: body !== undefined ? body : text,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 10. POST /api/messages/send-image
  router.post(
    '/messages/send-image',
    asyncHandler(async (req, res) => {
      const {
        clientId = 'default',
        to,
        image,
        source,
        base64,
        caption = '',
        fileName,
        cooldownSeconds,
        idempotencyKey,
      } = req.body || {};
      const result = await messageManager.sendMedia({
        clientId,
        to,
        mediaCategory: 'image',
        source: image || source,
        base64,
        caption,
        fileName,
        cooldownSeconds,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 11. POST /api/messages/send-video
  router.post(
    '/messages/send-video',
    asyncHandler(async (req, res) => {
      const {
        clientId = 'default',
        to,
        video,
        source,
        base64,
        caption = '',
        fileName,
        idempotencyKey,
      } = req.body || {};
      const result = await messageManager.sendMedia({
        clientId,
        to,
        mediaCategory: 'video',
        source: video || source,
        base64,
        caption,
        fileName,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 12. POST /api/messages/send-document
  router.post(
    '/messages/send-document',
    asyncHandler(async (req, res) => {
      const {
        clientId = 'default',
        to,
        document,
        source,
        base64,
        caption = '',
        fileName,
        idempotencyKey,
      } = req.body || {};
      const result = await messageManager.sendMedia({
        clientId,
        to,
        mediaCategory: 'document',
        source: document || source,
        base64,
        caption,
        fileName,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 13. POST /api/messages/send-audio
  router.post(
    '/messages/send-audio',
    asyncHandler(async (req, res) => {
      const {
        clientId = 'default',
        to,
        audio,
        source,
        base64,
        ptt = false,
        fileName,
        idempotencyKey,
      } = req.body || {};
      const result = await messageManager.sendMedia({
        clientId,
        to,
        mediaCategory: 'audio',
        source: audio || source,
        base64,
        ptt,
        fileName,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 14. POST /api/messages/send-location
  router.post(
    '/messages/send-location',
    asyncHandler(async (req, res) => {
      const { clientId = 'default', to, latitude, longitude, name, address, idempotencyKey } =
        req.body || {};
      const result = await messageManager.sendLocation({
        clientId,
        to,
        latitude,
        longitude,
        name,
        address,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 15. POST /api/messages/send-group
  router.post(
    '/messages/send-group',
    asyncHandler(async (req, res) => {
      const { clientId = 'default', groupId, to, body, text, idempotencyKey } = req.body || {};
      const result = await messageManager.sendGroupMessage({
        clientId,
        groupId: groupId || to,
        body: body !== undefined ? body : text,
        idempotencyKey,
      });
      res.json({ ok: true, message: result });
    })
  );

  // 16. GET /api/messages
  router.get(
    '/messages',
    asyncHandler(async (req, res) => {
      const clientId = req.query.clientId ? validateClientId(req.query.clientId) : null;
      const limit = Number(req.query.limit) || 100;
      const messages = queueManager.getMessages({ clientId, limit });
      res.json({ ok: true, messages });
    })
  );

  // 17. GET /api/messages/:messageId/status
  router.get(
    '/messages/:messageId/status',
    asyncHandler(async (req, res) => {
      const item = queueManager.getMessageById(req.params.messageId);
      if (!item) {
        return res.status(404).json({
          ok: false,
          error: { code: 'MESSAGE_NOT_FOUND', message: 'Message ID not found.' },
        });
      }
      return res.json({ ok: true, message: item });
    })
  );

  // 18. GET /api/contacts
  router.get(
    '/contacts',
    asyncHandler(async (req, res) => {
      const clientId = validateClientId(req.query.clientId || 'default');
      sessionManager.getAccount(clientId);
      const contacts = contactManager.getContacts(clientId);
      res.json({ ok: true, clientId, contacts });
    })
  );

  // 19. GET /api/groups
  router.get(
    '/groups',
    asyncHandler(async (req, res) => {
      const clientId = validateClientId(req.query.clientId || 'default');
      const conn = sessionManager.getConnection(clientId);
      const groups = await contactManager.getGroups(clientId, conn.sock);
      res.json({ ok: true, clientId, groups });
    })
  );

  // 20. POST /api/contacts/check
  router.post(
    '/contacts/check',
    asyncHandler(async (req, res) => {
      const { clientId = 'default', number, to } = req.body || {};
      const validClientId = validateClientId(clientId);
      const conn = sessionManager.getConnection(validClientId);
      const result = await contactManager.checkNumber(validClientId, conn.sock, number || to);
      res.json({ ok: true, clientId: validClientId, ...result });
    })
  );

  // 21. GET /api/diagnostics
  router.get(
    '/diagnostics',
    asyncHandler(async (req, res) => {
      const report = diagnostics.getFullDiagnostics(sessionManager, queueManager);
      // Include masked API token info only for Ingress sessions so user can copy token if auto-generated
      const isIngress = Boolean(req.headers['x-ingress-path']);
      res.json({
        ok: true,
        ...report,
        integrationSetup: isIngress
          ? {
              internalUrl: 'http://127.0.0.1:8653',
              fallbackUrls: ['http://localhost:8653', 'http://local-whatsapp:8653'],
              apiKey: config.apiKey,
            }
          : {
              internalUrl: 'http://127.0.0.1:8653',
              fallbackUrls: ['http://localhost:8653', 'http://local-whatsapp:8653'],
            },
      });
    })
  );

  // ==========================================
  // BOT & REMOTE CONTROL API ROUTES
  // ==========================================

  // 22. GET /api/bot/config
  router.get(
    '/bot/config',
    asyncHandler(async (req, res) => {
      const currentConfig = botConfigManager ? botConfigManager.getConfig() : {};
      res.json({ ok: true, config: currentConfig });
    })
  );

  // 23. POST /api/bot/config
  router.post(
    '/bot/config',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      await botConfigManager.save(req.body);
      res.json({ ok: true, config: botConfigManager.getConfig() });
    })
  );

  // 24. GET /api/bot/export
  router.get(
    '/bot/export',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      const rawJson = botConfigManager.exportJson();
      res.setHeader('Content-Disposition', 'attachment; filename="lumi_remote_config.json"');
      res.setHeader('Content-Type', 'application/json');
      res.send(rawJson);
    })
  );

  // 25. POST /api/bot/import
  router.post(
    '/bot/import',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      const summary = await botConfigManager.importJson(req.body);
      res.json({ ok: true, ...summary, config: botConfigManager.getConfig() });
    })
  );

  // 25b. POST /api/bot/demo (Loads sample/demo rooms, devices, speakers, and authorized numbers)
  router.post(
    '/bot/demo',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      const demoConfig = await botConfigManager.loadDemoConfig();
      res.json({ ok: true, message: 'Demo configuration loaded successfully', config: demoConfig });
    })
  );

  // 25c. Bot Customizer & Template Settings
  router.get(
    '/bot/settings',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      res.json({ ok: true, settings: botConfigManager.getSettings() });
    })
  );

  router.post(
    '/bot/settings',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      const updated = await botConfigManager.updateSettings(req.body);
      res.json({ ok: true, message: 'Bot settings updated successfully', settings: updated });
    })
  );

  router.post(
    '/bot/settings/reset',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.status(503).json({ ok: false, error: 'Bot config manager not initialized' });
      }
      const reset = await botConfigManager.resetSettingsToDefault();
      res.json({ ok: true, message: 'Bot settings reset to clean defaults', settings: reset });
    })
  );

  // 26. GET /api/bot/ha-entities
  router.get(
    '/bot/ha-entities',
    asyncHandler(async (req, res) => {
      if (!haClient) {
        return res.json({ ok: true, entities: [] });
      }
      const requestedDomains = req.query.domains
        ? req.query.domains.split(',')
        : ['light', 'switch', 'fan', 'climate', 'cover', 'media_player', 'scene', 'script', 'input_boolean'];
      const entities = await haClient.getEntities(requestedDomains);
      res.json({ ok: true, count: entities.length, entities });
    })
  );

  // 27. Authorized Numbers CRUD
  router.get(
    '/bot/recent-denied',
    asyncHandler(async (req, res) => {
      if (!botConfigManager) {
        return res.json({ ok: true, recentDenied: [] });
      }
      res.json({ ok: true, recentDenied: botConfigManager.getRecentDenied() });
    })
  );

  router.post(
    '/bot/authorized-numbers',
    asyncHandler(async (req, res) => {
      const { phone, name, lid } = req.body || {};
      let resolvedLid = lid || null;
      if (!resolvedLid && phone) {
        try {
          const conn = sessionManager?.getConnection('default') || sessionManager?.accounts?.get('default');
          if (conn?.sock && typeof conn.sock.onWhatsApp === 'function') {
            const results = await conn.sock.onWhatsApp(phone);
            if (Array.isArray(results) && results[0]?.lid) {
              resolvedLid = results[0].lid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            }
          }
        } catch {
          // Ignore lookup failures
        }
      }
      const entry = await botConfigManager.addAuthorizedNumber(phone, name, { lid: resolvedLid });
      res.status(201).json({ ok: true, entry, config: botConfigManager.getConfig() });
    })
  );

  router.delete(
    '/bot/authorized-numbers/:phone',
    asyncHandler(async (req, res) => {
      await botConfigManager.removeAuthorizedNumber(req.params.phone);
      res.json({ ok: true, config: botConfigManager.getConfig() });
    })
  );

  // 28. Rooms CRUD
  router.post(
    '/bot/rooms',
    asyncHandler(async (req, res) => {
      const { name } = req.body || {};
      const room = await botConfigManager.addRoom(name);
      res.status(201).json({ ok: true, room, config: botConfigManager.getConfig() });
    })
  );

  router.delete(
    '/bot/rooms/:roomId',
    asyncHandler(async (req, res) => {
      await botConfigManager.removeRoom(req.params.roomId);
      res.json({ ok: true, config: botConfigManager.getConfig() });
    })
  );

  router.post(
    '/bot/rooms/:roomId/devices',
    asyncHandler(async (req, res) => {
      const { name, entityId, type } = req.body || {};
      const device = await botConfigManager.addDevice(req.params.roomId, { name, entityId, type });
      res.status(201).json({ ok: true, device, config: botConfigManager.getConfig() });
    })
  );

  router.delete(
    '/bot/rooms/:roomId/devices/:deviceId',
    asyncHandler(async (req, res) => {
      await botConfigManager.removeDevice(req.params.roomId, req.params.deviceId);
      res.json({ ok: true, config: botConfigManager.getConfig() });
    })
  );

  // 29. Speakers CRUD
  router.post(
    '/bot/speakers',
    asyncHandler(async (req, res) => {
      const { name, entityId } = req.body || {};
      const speaker = await botConfigManager.addSpeaker({ name, entityId });
      res.status(201).json({ ok: true, speaker, config: botConfigManager.getConfig() });
    })
  );

  router.delete(
    '/bot/speakers/:speakerId',
    asyncHandler(async (req, res) => {
      await botConfigManager.removeSpeaker(req.params.speakerId);
      res.json({ ok: true, config: botConfigManager.getConfig() });
    })
  );

  // 30. Local cast audio fallback serving
  router.get(
    '/bot/casts/:filename',
    (req, res) => {
      const filename = path.basename(req.params.filename);
      const castsDir = interactiveBot?.castsDir;
      if (!castsDir) return res.status(404).send('Not Found');
      const targetPath = path.join(castsDir, filename);
      res.sendFile(targetPath, (err) => {
        if (err && !res.headersSent) {
          res.status(404).send('Audio not found');
        }
      });
    }
  );

  return router;
}

module.exports = {
  createApiRouter,
};
