'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { WhatsAppAccountConnection } = require('../src/whatsapp/connection');

test('WhatsAppConnection: prekey count query timeout is safely intercepted with resilient fallback', async () => {
  const tmpDir = path.join(os.tmpdir(), `test_conn_timeout_${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  let rawQueryCalled = false;

  // Mock socket factory that simulates Baileys makeWASocket
  const mockSocketFactory = (config) => {
    assert.equal(config.defaultQueryTimeoutMs, 180_000, 'defaultQueryTimeoutMs should be set to 180s');
    assert.equal(config.connectTimeoutMs, 60_000, 'connectTimeoutMs should be set to 60s');
    assert.equal(config.keepAliveIntervalMs, 25_000, 'keepAliveIntervalMs should be 25s');

    return {
      ev: {
        on: () => {},
      },
      ws: {
        on: () => {},
      },
      query: async (node) => {
        rawQueryCalled = true;
        // Simulate Baileys Boom Timed Out error on prekey count query
        const err = new Error('Timed Out');
        err.output = { statusCode: 408 };
        throw err;
      },
      user: { id: '919876543210:1@s.whatsapp.net' },
    };
  };

  const mockAuthStateFactory = async () => ({
    state: {
      creds: { me: { id: '919876543210:1@s.whatsapp.net' } },
      keys: {},
    },
    saveCreds: async () => {},
  });

  const conn = new WhatsAppAccountConnection({
    clientId: 'test-timeout',
    sessionDir: tmpDir,
    socketFactory: mockSocketFactory,
    authStateFactory: mockAuthStateFactory,
  });

  await conn.connect();
  assert.ok(conn.sock, 'Socket should be created');

  // Trigger pre-key count query on sock.query
  const preKeyQueryNode = {
    tag: 'iq',
    attrs: { xmlns: 'encrypt', type: 'get' },
    content: [{ tag: 'count', attrs: {} }],
  };

  const result = await conn.sock.query(preKeyQueryNode);
  assert.ok(rawQueryCalled, 'Raw query should have been called');
  assert.equal(result.tag, 'iq');
  assert.equal(result.content[0].tag, 'count');
  assert.equal(result.content[0].attrs.value, '100', 'Should return fallback prekey count');

  // Trigger non-prekey query: should rethrow normally
  const otherQueryNode = {
    tag: 'iq',
    attrs: { xmlns: 'other', type: 'get' },
  };

  await assert.rejects(
    async () => {
      await conn.sock.query(otherQueryNode);
    },
    { message: 'Timed Out' }
  );

  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
