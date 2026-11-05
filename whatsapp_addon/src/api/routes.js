'use strict';

const express = require('express');
const { validateClientId } = require('../utils/validation');

function createApiRouter({
  sessionManager,
  messageManager,
  queueManager,
  contactManager,
  diagnostics,
  config,
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

  return router;
}

module.exports = {
  createApiRouter,
};
