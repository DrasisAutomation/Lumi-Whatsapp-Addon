'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { BotConfigManager } = require('../src/bot/config-manager');
const { HomeAssistantClient } = require('../src/bot/homeassistant-client');
const { InteractiveBot } = require('../src/bot/interactive-bot');
const { createWhatsAppServer } = require('../src/server');

// Helper to clean up temporary test directories
async function cleanupDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {
    // Ignore cleanup error on Windows lock
  }
}

test('BotConfigManager: Rooms, Devices, Speakers, Authorized Numbers & JSON Backup/Restore', async () => {
  const tmpDir = path.join(os.tmpdir(), `lumi_cfg_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    const configMgr = new BotConfigManager({ dataDir: tmpDir });
    await configMgr.init();

    // 1. Initial State
    assert.deepEqual(configMgr.getConfig().authorizedNumbers, []);
    assert.deepEqual(configMgr.getConfig().rooms, []);
    assert.deepEqual(configMgr.getConfig().speakers, []);
    assert.equal(configMgr.isAuthorized('917904598574'), false);

    // 2. Authorized Numbers
    await configMgr.addAuthorizedNumber('917904598574', 'Mohan Admin');
    assert.equal(configMgr.isAuthorized('917904598574'), true);
    assert.equal(configMgr.isAuthorized('+91 79045 98574'), true);
    assert.equal(configMgr.isAuthorized('19999999999'), false);

    // 3. Add Room & Devices
    const livingRoom = await configMgr.addRoom('Living Room');
    assert.ok(livingRoom.id);
    assert.equal(livingRoom.name, 'Living Room');

    const dev1 = await configMgr.addDevice(livingRoom.id, {
      name: 'Ceiling Light',
      entityId: 'light.living_room_ceiling',
      type: 'light',
    });
    assert.ok(dev1.id);
    assert.equal(dev1.name, 'Ceiling Light');

    const dev2 = await configMgr.addDevice(livingRoom.id, {
      name: 'Ceiling Fan',
      entityId: 'fan.living_room_fan',
      type: 'fan',
    });
    assert.equal(dev2.name, 'Ceiling Fan');

    // 4. Add Speakers
    const spk1 = await configMgr.addSpeaker({
      name: 'Living Room Nest Audio',
      entityId: 'media_player.living_room_nest',
    });
    assert.ok(spk1.id);
    assert.equal(spk1.name, 'Living Room Nest Audio');

    // 5. Export JSON
    const exportedJson = configMgr.exportJson();
    assert.ok(typeof exportedJson === 'string');
    const parsed = JSON.parse(exportedJson);
    assert.equal(parsed.rooms.length, 1);
    assert.equal(parsed.rooms[0].devices.length, 2);
    assert.equal(parsed.speakers.length, 1);
    assert.equal(parsed.authorizedNumbers.length, 1);

    // 6. Import JSON into fresh manager
    const newTmpDir = path.join(os.tmpdir(), `lumi_cfg_import_${Date.now()}`);
    await fsp.mkdir(newTmpDir, { recursive: true });
    const freshMgr = new BotConfigManager({ dataDir: newTmpDir });
    await freshMgr.init();
    assert.equal(freshMgr.getConfig().rooms.length, 0);

    const importRes = await freshMgr.importJson(exportedJson);
    assert.equal(importRes.roomsCount, 1);
    assert.equal(importRes.speakersCount, 1);
    assert.equal(importRes.authorizedCount, 1);
    assert.equal(freshMgr.isAuthorized('917904598574'), true);
    assert.equal(freshMgr.getConfig().rooms[0].name, 'Living Room');
    assert.equal(freshMgr.getConfig().rooms[0].devices[0].name, 'Ceiling Light');

    await cleanupDir(newTmpDir);
  } finally {
    await cleanupDir(tmpDir);
  }
});

test('HomeAssistantClient: Safe dryRun execution & volume preservation', async () => {
  const client = new HomeAssistantClient({
    dryRun: true, // Dry run enabled
  });

  assert.equal(client.dryRun, true);

  // Turn on and off in dry-run mode
  const resOn = await client.turnOn('light.living_room');
  assert.equal(resOn.success, true);
  assert.equal(resOn.dryRun, true);
  assert.equal(resOn.domain, 'light');
  assert.equal(resOn.service, 'turn_on');

  const resOff = await client.turnOff('switch.kitchen_fan');
  assert.equal(resOff.success, true);
  assert.equal(resOff.dryRun, true);
  assert.equal(resOff.domain, 'switch');
  assert.equal(resOff.service, 'turn_off');

  // Play media: verifies media_player.play_media is called WITHOUT setting volume
  const resMedia = await client.playMedia('media_player.bedroom_speaker', '/local/whatsapp_casts/sample.mp3');
  assert.equal(resMedia.success, true);
  assert.equal(resMedia.domain, 'media_player');
  assert.equal(resMedia.service, 'play_media');
  assert.equal(resMedia.serviceData.entity_id, 'media_player.bedroom_speaker');
  assert.equal(resMedia.serviceData.media_content_id, '/local/whatsapp_casts/sample.mp3');
  assert.equal(resMedia.serviceData.volume_level, undefined); // Volume untouched!

  assert.equal(client.history.length, 3);
});

test('InteractiveBot: Full /remote and /cast conversational state machine', async () => {
  const tmpDir = path.join(os.tmpdir(), `lumi_bot_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const castsDir = path.join(tmpDir, 'casts');
  await fsp.mkdir(castsDir, { recursive: true });

  let bot = null;
  try {
    const configMgr = new BotConfigManager({ dataDir: tmpDir });
    await configMgr.init();
    await configMgr.addAuthorizedNumber('917904598574', 'Mohan Admin');

    const livingRoom = await configMgr.addRoom('Living Room');
    await configMgr.addDevice(livingRoom.id, {
      name: 'Ceiling Light',
      entityId: 'light.living_room_light',
      type: 'light',
    });
    await configMgr.addDevice(livingRoom.id, {
      name: 'Reading Lamp',
      entityId: 'light.reading_lamp',
      type: 'light',
    });
    await configMgr.addDevice(livingRoom.id, {
      name: 'Ceiling Fan',
      entityId: 'fan.living_room_fan',
      type: 'fan',
    });

    const bedroom = await configMgr.addRoom('Master Bedroom');
    await configMgr.addDevice(bedroom.id, {
      name: 'Bedroom AC',
      entityId: 'climate.bedroom_ac',
      type: 'climate',
    });

    await configMgr.addSpeaker({
      name: 'Living Room Speaker',
      entityId: 'media_player.living_room_speaker',
    });
    await configMgr.addSpeaker({
      name: 'Master Bedroom Echo Dot',
      entityId: 'media_player.bedroom_echo',
    });

    // Mock HA Client with live entity states
    const statesMap = {
      'light.living_room_light': 'off',
      'light.reading_lamp': 'on',
      'fan.living_room_fan': 'off',
      'climate.bedroom_ac': 'off',
    };

    const mockHaClient = {
      dryRun: true,
      serviceCalls: [],
      getEntityState: async (entityId) => ({
        entity_id: entityId,
        state: statesMap[entityId] || 'off',
        attributes: {},
      }),
      turnOn: async (entityId) => {
        statesMap[entityId] = 'on';
        mockHaClient.serviceCalls.push({ action: 'turn_on', entityId });
        return { success: true };
      },
      turnOff: async (entityId) => {
        statesMap[entityId] = 'off';
        mockHaClient.serviceCalls.push({ action: 'turn_off', entityId });
        return { success: true };
      },
      playMedia: async (entityId, mediaUrl) => {
        mockHaClient.serviceCalls.push({ action: 'play_media', entityId, mediaUrl });
        return { success: true };
      },
    };

    // Mock Message Manager capturing sent replies
    const sentReplies = [];
    const mockMsgManager = {
      sendMessage: async ({ clientId, to, messageType, text }) => {
        sentReplies.push({ clientId, to, messageType, text });
        return { messageId: `msg_${Date.now()}` };
      },
    };

    const eventManager = new EventEmitter();

    bot = new InteractiveBot({
      configManager: configMgr,
      haClient: mockHaClient,
      messageManager: mockMsgManager,
      eventManager,
      dataDir: tmpDir,
      castsDir,
    });
    bot.init();

    // ─────────────────────────────────────────────────────────
    // SCENARIO 1: Unauthorized user attempts /remote and /cast
    // ─────────────────────────────────────────────────────────
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210', // NOT in authorized list
      text: '/remote',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 1);
    assert.match(sentReplies[0].text, /⛔ \*Access Denied:\*/);
    assert.match(sentReplies[0].text, /not authorized to control Home Assistant/);

    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      text: '/cast',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 2);
    assert.match(sentReplies[1].text, /⛔ \*Access Denied:\*/);
    assert.match(sentReplies[1].text, /not authorized to broadcast to Home Assistant speakers/);

    // ─────────────────────────────────────────────────────────
    // SCENARIO 2: Authorized user /remote flow
    // ─────────────────────────────────────────────────────────
    sentReplies.length = 0;

    // Step A: Send /remote
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '/remote',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 1);
    assert.match(sentReplies[0].text, /🏠 \*LUMI SMART HOME REMOTE\*/);
    assert.match(sentReplies[0].text, /1️⃣ Living Room/);
    assert.match(sentReplies[0].text, /2️⃣ Master Bedroom/);

    // Step B: Select Room 1 (Living Room)
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '1',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 2);
    assert.match(sentReplies[1].text, /🛋️ \*Living Room Devices\*/);
    assert.match(sentReplies[1].text, /1️⃣ Ceiling Light: \*\[OFF\]\*/);
    assert.match(sentReplies[1].text, /2️⃣ Reading Lamp: \*\[ON\]\*/);
    assert.match(sentReplies[1].text, /3️⃣ Ceiling Fan: \*\[OFF\]\*/);

    // Step C: Trigger Single Device: on 1 or ON-1
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: 'on-1',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 3);
    assert.match(sentReplies[2].text, /✅ \*Action Executed:\*/);
    assert.match(sentReplies[2].text, /• \*Ceiling Light\*: turned \*ON\*/);
    assert.equal(statesMap['light.living_room_light'], 'on');

    // Step D: Trigger Batch Devices: off 1,2
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: 'off 1,2',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 4);
    assert.match(sentReplies[3].text, /✅ \*Batch Action Executed:\*/);
    assert.match(sentReplies[3].text, /• \*Ceiling Light\*: turned \*OFF\*/);
    assert.match(sentReplies[3].text, /• \*Reading Lamp\*: turned \*OFF\*/);
    assert.equal(statesMap['light.living_room_light'], 'off');
    assert.equal(statesMap['light.reading_lamp'], 'off');

    // Step E: Navigation /back returns to room list
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '/back',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 5);
    assert.match(sentReplies[4].text, /↩️ \*Returning to Room Selection:\*/);
    assert.match(sentReplies[4].text, /1️⃣ Living Room/);

    // Step F: /end exits session
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '/end',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 6);
    assert.match(sentReplies[5].text, /👋 \*Remote Session Ended\.\*/);

    // ─────────────────────────────────────────────────────────
    // SCENARIO 3: Authorized user /cast flow
    // ─────────────────────────────────────────────────────────
    sentReplies.length = 0;
    mockHaClient.serviceCalls.length = 0;

    // Step A: Send /cast
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '/cast',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 1);
    assert.match(sentReplies[0].text, /🎙️ \*LUMI SPEAKER BROADCAST \/ CAST\*/);
    assert.match(sentReplies[0].text, /Please record a \*Voice Note\* or send an \*Audio File\*/);

    // Step B: User sends text instead of audio -> Prompt warning
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: 'Hello play this',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 2);
    assert.match(sentReplies[1].text, /⚠️ \*Audio Required:\*/);

    // Step C: User sends audio file
    // Create dummy audio file on disk to simulate downloaded audio buffer
    const dummyAudioPath = path.join(castsDir, 'test_audio.ogg');
    await fsp.writeFile(dummyAudioPath, Buffer.from('RIFF_MOCK_AUDIO_DATA'));

    // Inject savedAudio in session for test
    const session = bot._getSession('917904598574');
    assert.ok(session);
    assert.equal(session.state, 'WAITING_AUDIO');

    session.state = 'SPEAKER_SELECT';
    session.savedAudio = {
      filePath: dummyAudioPath,
      publicUrl: '/api/bot/casts/test_audio.ogg',
      fileName: 'test_audio.ogg',
    };
    bot._setSession('917904598574', session);

    // Step D: Trigger Single Speaker: play 1
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: 'play 1',
      messageType: 'text',
    });
    assert.equal(sentReplies.length, 3);
    assert.match(sentReplies[2].text, /✅ \*Broadcasting Announcement:\*/);
    assert.match(sentReplies[2].text, /• Target: \*Living Room Speaker\*/);
    assert.match(sentReplies[2].text, /• Volume: \*Current Speaker Volume\*/);
    assert.equal(mockHaClient.serviceCalls.length, 1);
    assert.equal(mockHaClient.serviceCalls[0].entityId, 'media_player.living_room_speaker');

    // Step E: Multi-speaker / All test: start /cast again, choose 'play all'
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: '/cast',
      messageType: 'text',
    });
    const session2 = bot._getSession('917904598574');
    session2.state = 'SPEAKER_SELECT';
    session2.savedAudio = {
      filePath: dummyAudioPath,
      publicUrl: '/api/bot/casts/test_audio.ogg',
    };
    bot._setSession('917904598574', session2);

    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '917904598574',
      text: 'play all',
      messageType: 'text',
    });
    assert.match(sentReplies[sentReplies.length - 1].text, /✅ \*Multi-Speaker Broadcast Active:\*/);
    assert.match(sentReplies[sentReplies.length - 1].text, /Living Room Speaker/);
    assert.match(sentReplies[sentReplies.length - 1].text, /Master Bedroom Echo Dot/);
  } finally {
    bot.close();
    await cleanupDir(tmpDir);
  }
});

test('REST API: Bot Config, Rooms, Speakers, Authorized Numbers & Export/Import HTTP endpoints', async () => {
  const tmpDir = path.join(os.tmpdir(), `lumi_api_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const testApiKey = 'test_secret_bot_token_123';
  const customConfig = {
    apiKey: testApiKey,
    logLevel: 'silent',
    dataDir: tmpDir,
    sessionsDir: path.join(tmpDir, 'sessions'),
    accountsRegistryPath: path.join(tmpDir, 'accounts.json'),
    queueDir: path.join(tmpDir, 'queue'),
    maxRetries: 1,
    retryBaseDelayMs: 500,
    mediaMaxSizeMb: 10,
    snapshotWaitTimeoutMs: 1000,
    cooldownSeconds: 0,
    allowedMediaDirs: [tmpDir],
    allowedLocalHosts: ['127.0.0.1'],
  };

  const serverInstance = await createWhatsAppServer({
    customConfig,
    autoConnect: false,
  });

  const { server, close } = serverInstance;
  const port = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => {
      resolve(s.address().port);
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    Authorization: `Bearer ${testApiKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. GET /api/bot/config
    const getRes = await fetch(`${baseUrl}/api/bot/config`, { headers: authHeaders });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.ok, true);
    assert.deepEqual(getData.config.rooms, []);

    // 2. POST /api/bot/authorized-numbers
    const addAuthRes = await fetch(`${baseUrl}/api/bot/authorized-numbers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ phone: '917904598574', name: 'Mohan' }),
    });
    assert.equal(addAuthRes.status, 201);
    const addAuthData = await addAuthRes.json();
    assert.equal(addAuthData.ok, true);
    assert.equal(addAuthData.entry.phone, '917904598574');

    // 3. POST /api/bot/rooms
    const addRoomRes = await fetch(`${baseUrl}/api/bot/rooms`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Balcony' }),
    });
    assert.equal(addRoomRes.status, 201);
    const roomData = await addRoomRes.json();
    assert.equal(roomData.room.name, 'Balcony');
    const roomId = roomData.room.id;

    // 4. POST /api/bot/rooms/:roomId/devices
    const addDevRes = await fetch(`${baseUrl}/api/bot/rooms/${roomId}/devices`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Balcony Fairy Lights',
        entityId: 'light.balcony_fairy',
        type: 'light',
      }),
    });
    assert.equal(addDevRes.status, 201);
    const devData = await addDevRes.json();
    assert.equal(devData.device.name, 'Balcony Fairy Lights');

    // 5. POST /api/bot/speakers
    const addSpkRes = await fetch(`${baseUrl}/api/bot/speakers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Balcony Nest Mini',
        entityId: 'media_player.balcony_nest',
      }),
    });
    assert.equal(addSpkRes.status, 201);

    // 6. GET /api/bot/export
    const exportRes = await fetch(`${baseUrl}/api/bot/export`, { headers: authHeaders });
    assert.equal(exportRes.status, 200);
    const exportedJson = await exportRes.text();
    const parsed = JSON.parse(exportedJson);
    assert.equal(parsed.rooms.length, 1);
    assert.equal(parsed.speakers.length, 1);
    assert.equal(parsed.authorizedNumbers.length, 1);

    // 7. POST /api/bot/import
    parsed.rooms.push({
      id: 'room_custom',
      name: 'Garden',
      devices: [],
    });
    const importRes = await fetch(`${baseUrl}/api/bot/import`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(parsed),
    });
    assert.equal(importRes.status, 200);
    const importData = await importRes.json();
    assert.equal(importData.roomsCount, 2);
    assert.equal(importData.config.rooms[1].name, 'Garden');
  } finally {
    await close();
    await cleanupDir(tmpDir);
  }
});
