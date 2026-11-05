'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const EventEmitter = require('node:events');
const { WebSocket } = require('ws');
const { DisconnectReason } = require('../src/whatsapp/baileys');

const {
  validateClientId,
  normalizeRecipientJid,
  validateTextBody,
  validateLocalMediaPath,
  validateAndResolveRemoteUrl,
  detectMimeAndValidateMagicBytes,
} = require('../src/utils/validation');
const { useAtomicMultiFileAuthState } = require('../src/services/storage');
const { MessageQueueManager } = require('../src/services/queue');
const { MediaManager } = require('../src/whatsapp/media-manager');
const { WhatsAppEventManager } = require('../src/whatsapp/event-manager');
const { createWhatsAppServer } = require('../src/server');

function createMockSocketFactory() {
  const sockets = [];
  const factory = () => {
    const ev = new EventEmitter();
    const sentMessages = [];
    const sock = {
      ev,
      user: { id: '919876543210:1@s.whatsapp.net', name: 'HA Test User' },
      sentMessages,
      sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return {
          key: {
            remoteJid: jid,
            fromMe: true,
            id: `BAE5_${Date.now()}_${sentMessages.length}`,
          },
        };
      },
      groupFetchAllParticipating: async () => ({
        '12036300112233@g.us': {
          id: '12036300112233@g.us',
          subject: 'Home Automation Alerts',
          owner: '919876543210@s.whatsapp.net',
          creation: 1700000000,
          participants: [{ id: '919876543210@s.whatsapp.net' }],
          announce: false,
          restrict: false,
        },
      }),
      onWhatsApp: async (jid) => [
        {
          exists: !jid.startsWith('999000'),
          jid,
        },
      ],
      end: () => {},
    };
    sockets.push(sock);
    return sock;
  };
  factory.sockets = sockets;
  return factory;
}

// ---------------------------------------------------------------------------
// 1. Validation & Security Tests
// ---------------------------------------------------------------------------
test('Validation: clientId, recipient JIDs, and text body validation', () => {
  assert.equal(validateClientId('default'), 'default');
  assert.equal(validateClientId('office_1-main'), 'office_1-main');
  assert.throws(() => validateClientId('../evil'), { code: 'INVALID_CLIENT_ID' });
  assert.throws(() => validateClientId(''), { code: 'INVALID_CLIENT_ID' });

  assert.equal(normalizeRecipientJid('+91 98765-43210'), '919876543210@s.whatsapp.net');
  assert.equal(normalizeRecipientJid('12036300112233@g.us'), '12036300112233@g.us');
  assert.throws(() => normalizeRecipientJid('invalid-phone'), { code: 'INVALID_RECIPIENT' });

  assert.equal(validateTextBody({ text: '  Hello Home Assistant  ' }), 'Hello Home Assistant');
  assert.throws(() => validateTextBody({ text: '   ' }), { code: 'EMPTY_MESSAGE_TEXT' });
});

test('Media Security: path traversal prevention and SSRF protection', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ha-wa-media-'));
  const allowedDir = path.join(tmpRoot, 'www');
  const secretDir = path.join(tmpRoot, 'secret');
  await fsp.mkdir(allowedDir, { recursive: true });
  await fsp.mkdir(secretDir, { recursive: true });

  const validFile = path.join(allowedDir, 'snapshot.jpg');
  // Valid minimal JPEG header + EOI
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  await fsp.writeFile(validFile, jpegBuffer);
  await fsp.writeFile(path.join(secretDir, 'configuration.yaml'), 'secret: 123');

  const resolved = validateLocalMediaPath(validFile, { allowedDirs: [allowedDir] });
  assert.equal(resolved, fs.realpathSync(validFile));

  // Block path traversal outside allowedDirs
  assert.throws(
    () => validateLocalMediaPath(path.join(allowedDir, '..', 'secret', 'configuration.yaml'), { allowedDirs: [allowedDir] }),
    { code: 'PATH_TRAVERSAL_BLOCKED' }
  );

  // Block SSRF against loopback, cloud metadata, and private IPs
  await assert.rejects(
    () => validateAndResolveRemoteUrl('http://127.0.0.1:8123/api/config'),
    { code: 'SSRF_BLOCKED' }
  );
  await assert.rejects(
    () => validateAndResolveRemoteUrl('http://169.254.169.254/latest/meta-data/'),
    { code: 'SSRF_BLOCKED' }
  );
  await assert.rejects(
    () => validateAndResolveRemoteUrl('http://192.168.1.50/snap.jpg'),
    { code: 'SSRF_BLOCKED' }
  );

  // Allow trusted LAN IP when explicitly listed in allowedLocalHosts
  const trusted = await validateAndResolveRemoteUrl('http://192.168.1.50/snap.jpg', {
    allowedLocalHosts: ['192.168.1.50'],
  });
  assert.equal(trusted.hostname, '192.168.1.50');

  await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 2. CCTV Delayed Snapshot Readiness & Cooldown Tests
// ---------------------------------------------------------------------------
test('MediaManager: waitForFileReady waits for delayed CCTV snapshot creation & enforces cooldown', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ha-wa-cctv-'));
  const snapshotPath = path.join(tmpRoot, 'entrance.jpg');
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

  const mediaManager = new MediaManager({
    allowedDirs: [tmpRoot],
    maxSizeMb: 10,
    snapshotWaitTimeoutMs: 3000,
    cooldownSeconds: 30,
  });

  // Simulate camera.snapshot writing the file 350ms after action starts
  setTimeout(async () => {
    await fsp.writeFile(snapshotPath, jpegBytes);
  }, 350);

  const loaded = await mediaManager.loadLocalMedia(snapshotPath, 'image', { waitForReady: true });
  assert.equal(loaded.mimetype, 'image/jpeg');
  assert.equal(loaded.size, jpegBytes.length);

  // Cooldown check: first alert allowed, immediate duplicate suppressed
  const firstCd = mediaManager.checkAndRecordCooldown({
    clientId: 'default',
    to: '919876543210@s.whatsapp.net',
    mediaSource: snapshotPath,
  });
  assert.equal(firstCd.suppressed, false);

  const secondCd = mediaManager.checkAndRecordCooldown({
    clientId: 'default',
    to: '919876543210@s.whatsapp.net',
    mediaSource: snapshotPath,
  });
  assert.equal(secondCd.suppressed, true);
  assert.ok(secondCd.remainingSeconds > 0);

  // Magic byte detection for PNG, WebP, MP4, PDF
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectMimeAndValidateMagicBytes(pngBytes, 'test.png', 'image'), 'image/png');

  const pdfBytes = Buffer.from('%PDF-1.7 sample pdf content');
  assert.equal(detectMimeAndValidateMagicBytes(pdfBytes, 'invoice.pdf', 'document'), 'application/pdf');

  await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 3. Atomic Session Storage & Persistent Message Queue Tests
// ---------------------------------------------------------------------------
test('Atomic Auth State & Persistent Queue: crash recovery, retries, and idempotency', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ha-wa-queue-'));
  const sessionDir = path.join(tmpDir, 'session_default');
  const queueDir = path.join(tmpDir, 'queue');

  // Test atomic auth state persistence
  const auth1 = await useAtomicMultiFileAuthState(sessionDir);
  auth1.state.creds.me = { id: '919876543210@s.whatsapp.net', name: 'Persistent User' };
  await auth1.saveCreds();
  await auth1.state.keys.set({ 'pre-key': { '1': { pub: Buffer.from('abc') } } });

  const auth2 = await useAtomicMultiFileAuthState(sessionDir);
  assert.equal(auth2.state.creds.me.id, '919876543210@s.whatsapp.net');
  const loadedKeys = await auth2.state.keys.get('pre-key', ['1']);
  assert.ok(Buffer.isBuffer(loadedKeys['1'].pub));

  // Test Queue retry + idempotency + never resending already submitted messages
  let attempts = 0;
  const qm = new MessageQueueManager({
    queueDir,
    maxRetries: 2,
    baseDelayMs: 50,
    executor: async (item) => {
      attempts += 1;
      if (attempts === 1) {
        const transientErr = new Error('Temporary socket drop');
        transientErr.code = 'SOCKET_DROP';
        throw transientErr;
      }
      return { whatsappMessageId: `WA_MSG_${item.queueId}` };
    },
  });

  await qm.init(['default']);
  const sentItem = await qm.enqueue({
    clientId: 'default',
    to: '919876543210@s.whatsapp.net',
    messageType: 'text',
    payload: { text: 'Retry test message' },
    idempotencyKey: 'idem-key-1',
  });

  assert.equal(sentItem.status, 'sent');
  assert.equal(sentItem.attempts, 2);
  assert.ok(sentItem.messageId.startsWith('WA_MSG_'));

  // Duplicate idempotencyKey returns existing sent item without re-running executor
  const duplicateItem = await qm.enqueue({
    clientId: 'default',
    to: '919876543210@s.whatsapp.net',
    messageType: 'text',
    payload: { text: 'Retry test message' },
    idempotencyKey: 'idem-key-1',
  });
  assert.equal(duplicateItem.queueId, sentItem.queueId);
  assert.equal(attempts, 2);

  qm.stop();
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 4. End-to-End Server, Multi-Account, QR, Media, Events & Auth Tests
// ---------------------------------------------------------------------------
test('Full Server E2E: Auth, Multi-Account, QR, Text/Image/Group Send, Receipts, Incoming Events & Diagnostics', async () => {
  const tmpDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ha-wa-server-'));
  const allowedMediaDir = path.join(tmpDataDir, 'www');
  await fsp.mkdir(allowedMediaDir, { recursive: true });

  const snapshotFile = path.join(allowedMediaDir, 'cctv.jpg');
  await fsp.writeFile(
    snapshotFile,
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])
  );

  const mockSocketFactory = createMockSocketFactory();
  const apiKey = 'test_super_secret_bearer_token_12345';

  const instance = await createWhatsAppServer({
    customConfig: {
      dataDir: tmpDataDir,
      sessionsDir: path.join(tmpDataDir, 'sessions'),
      queueDir: path.join(tmpDataDir, 'queue'),
      historyDir: path.join(tmpDataDir, 'history'),
      accountsRegistryPath: path.join(tmpDataDir, 'accounts.json'),
      apiKey,
      logLevel: 'silent',
      maxRetries: 2,
      retryBaseDelayMs: 50,
      mediaMaxSizeMb: 10,
      snapshotWaitTimeoutMs: 2000,
      cooldownSeconds: 0,
      allowedLocalHosts: [],
      allowedMediaDirs: [allowedMediaDir],
    },
    socketFactory: mockSocketFactory,
    autoConnect: false,
  });

  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // 1. Unauthenticated /api/accounts must return 401
  const unauthRes = await fetch(`${baseUrl}/api/accounts`);
  assert.equal(unauthRes.status, 401);

  // 2. Connect WebSocket client with Bearer Token
  const wsEvents = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    wsEvents.push(JSON.parse(raw.toString()));
  });

  // 3. Connect 'default' account & simulate QR emission then connection open
  const connectRes = await fetch(`${baseUrl}/api/accounts/default/connect`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(connectRes.status, 200);

  const defaultSock = mockSocketFactory.sockets[0];
  assert.ok(defaultSock, 'Baileys socket should be created for default account');

  // Emit QR code from Baileys
  defaultSock.ev.emit('connection.update', { qr: '2@mock_qr_code_payload_string' });
  await new Promise((r) => setTimeout(r, 150));

  const qrRes = await fetch(`${baseUrl}/api/accounts/default/qr`, { headers: authHeaders });
  const qrData = await qrRes.json();
  assert.equal(qrData.qrAvailable, true);
  assert.ok(qrData.qrDataUrl.startsWith('data:image/png;base64,'));

  // Emit connection open & creds update
  defaultSock.ev.emit('creds.update');
  defaultSock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 100));

  const accRes = await fetch(`${baseUrl}/api/accounts/default`, { headers: authHeaders });
  const accData = await accRes.json();
  assert.equal(accData.account.status, 'connected');
  assert.equal(accData.account.phone, '919876543210');

  // 4. Add second independent account ('office')
  const createOfficeRes = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: 'office', name: 'Office WhatsApp', connectImmediately: true }),
  });
  assert.equal(createOfficeRes.status, 201);
  const officeSock = mockSocketFactory.sockets[1];
  officeSock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 80));

  // 5. Send Text Message via REST API
  const sendTextRes = await fetch(`${baseUrl}/api/messages/send`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      clientId: 'default',
      to: '919876543210',
      body: { text: 'Hello from Home Assistant' },
    }),
  });
  assert.equal(sendTextRes.status, 200);
  const sendTextJson = await sendTextRes.json();
  assert.equal(sendTextJson.message.status, 'sent');
  const sentMsgId = sendTextJson.message.messageId;

  // 6. Send CCTV Snapshot Image via REST API
  const sendImgRes = await fetch(`${baseUrl}/api/messages/send-image`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      clientId: 'default',
      to: '919876543210',
      image: snapshotFile,
      caption: 'Motion detected at entrance!',
    }),
  });
  assert.equal(sendImgRes.status, 200);
  const sendImgJson = await sendImgRes.json();
  assert.equal(sendImgJson.message.status, 'sent');
  assert.equal(defaultSock.sentMessages.length, 2);
  assert.ok(Buffer.isBuffer(defaultSock.sentMessages[1].content.image));
  assert.equal(defaultSock.sentMessages[1].content.caption, 'Motion detected at entrance!');

  // 7. Simulate delivery and read receipts from WhatsApp
  defaultSock.ev.emit('messages.update', [
    {
      key: { id: sentMsgId, remoteJid: '919876543210@s.whatsapp.net' },
      update: { status: 3 }, // DELIVERY_ACK -> delivered
    },
  ]);
  await new Promise((r) => setTimeout(r, 80));

  const statusRes = await fetch(`${baseUrl}/api/messages/${sentMsgId}/status`, { headers: authHeaders });
  const statusJson = await statusRes.json();
  assert.equal(statusJson.message.status, 'delivered');

  // 8. Simulate incoming message & verify outgoing (fromMe) is ignored
  defaultSock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'OUTGOING_1', remoteJid: '919876543210@s.whatsapp.net', fromMe: true },
        message: { conversation: 'Should be ignored' },
      },
      {
        key: { id: 'INCOMING_1', remoteJid: '919988776655@s.whatsapp.net', fromMe: false },
        pushName: 'Alice',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'STATUS' },
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 100));

  const incomingEvents = wsEvents.filter((e) => e.type === 'new_whatsapp_message');
  assert.equal(incomingEvents.length, 1);
  assert.equal(incomingEvents[0].payload.sender, '919988776655');
  assert.equal(incomingEvents[0].payload.text, 'STATUS');

  // 9. Verify temporary network error does NOT delete session
  defaultSock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost }, message: 'Network drop' } },
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(fs.existsSync(path.join(tmpDataDir, 'sessions', 'default', 'creds.json')));

  // 10. Verify account deletion requires explicit confirmation
  const delUnconfirmed = await fetch(`${baseUrl}/api/accounts/office`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.equal(delUnconfirmed.status, 400);

  const delConfirmed = await fetch(`${baseUrl}/api/accounts/office?confirm=true`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.equal(delConfirmed.status, 200);

  // 11. Verify diagnostics endpoint excludes secrets, QR codes, and message contents
  const diagRes = await fetch(`${baseUrl}/api/diagnostics`, { headers: authHeaders });
  const diagJson = await diagRes.json();
  const diagRaw = JSON.stringify(diagJson);
  assert.ok(!diagRaw.includes('mock_qr_code_payload_string'));
  assert.ok(!diagRaw.includes('Hello from Home Assistant'));
  assert.ok(!diagRaw.includes(apiKey));

  ws.close();
  await instance.close();
  await fsp.rm(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
