/**
 * tests/verify_speaker_locally.mjs
 * 
 * Local Verification for Speaker Audio Casting:
 * 1. Audio download & disk write verification (castsDir).
 * 2. HTTP serving via /api/bot/casts/:filename (with status 200 & content verification).
 * 3. Speaker command parsing: play 1, play-1, PLAY 1, Play 1,2,4, play-1,2,4, play all, all, etc.
 * 4. Direct audio caption execution.
 * 5. Strict speaker volume preservation (never alters volume_level).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Relative imports matching verify_ui_and_demo.mjs
const { InteractiveBot } = await import('../whatsapp_addon/src/bot/interactive-bot.js');
const { HomeAssistantClient } = await import('../whatsapp_addon/src/bot/homeassistant-client.js');
const { BotConfigManager } = await import('../whatsapp_addon/src/bot/config-manager.js');

async function cleanupDir(d) {
  try {
    await fsp.rm(d, { recursive: true, force: true });
  } catch {}
}

test('Speaker Casting: Local Audio Download, Disk Persistence & HTTP Serving', async () => {
  const tmpDir = path.join(os.tmpdir(), `lumi_speaker_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const castsDir = path.join(tmpDir, 'casts');
  await fsp.mkdir(castsDir, { recursive: true });

  let server = null;

  try {
    const configMgr = new BotConfigManager({ dataDir: tmpDir });
    await configMgr.init();
    await configMgr.addAuthorizedNumber('919876543210', 'Speaker Tester');

    const spk1 = await configMgr.addSpeaker({
      name: 'Living Room Sonos',
      entityId: 'media_player.living_room_sonos',
    });
    const spk2 = await configMgr.addSpeaker({
      name: 'Kitchen Google Nest',
      entityId: 'media_player.kitchen_nest',
    });
    const spk3 = await configMgr.addSpeaker({
      name: 'Master Bedroom Echo',
      entityId: 'media_player.bedroom_echo',
    });
    const spk4 = await configMgr.addSpeaker({
      name: 'Patio Outdoor Speaker',
      entityId: 'media_player.patio_speaker',
    });

    const mediaCalls = [];
    const mockHaClient = {
      dryRun: true,
      playMedia: async (entityId, mediaUrl, mediaType = 'music') => {
        mediaCalls.push({ entityId, mediaUrl, mediaType });
        return { success: true };
      },
      getEntityState: async () => ({ state: 'idle', attributes: {} }),
    };

    const sentReplies = [];
    const mockMsgMgr = {
      sendMessage: async ({ clientId, to, text, messageType }) => {
        sentReplies.push({ clientId, to, text, messageType });
        return { messageId: 'm1' };
      },
    };

    const bot = new InteractiveBot({
      configManager: configMgr,
      haClient: mockHaClient,
      messageManager: mockMsgMgr,
      dataDir: tmpDir,
      castsDir,
    });
    bot.init();

    // Mount lightweight HTTP server serving /api/bot/casts/:filename
    server = http.createServer(async (req, res) => {
      const match = req.url.match(/^\/api\/bot\/casts\/([^?#]+)/);
      if (match) {
        const filename = path.basename(match[1]);
        const targetPath = path.join(castsDir, filename);
        try {
          const fileBuf = await fsp.readFile(targetPath);
          res.writeHead(200, {
            'Content-Type': 'audio/ogg',
            'Content-Length': fileBuf.length,
          });
          return res.end(fileBuf);
        } catch {
          res.writeHead(404);
          return res.end('Audio not found');
        }
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // ─────────────────────────────────────────────────────────────
    // Part 1: Start /cast session and send real audio buffer
    // ─────────────────────────────────────────────────────────────
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      text: '/cast',
      messageType: 'text',
    });
    assert.match(sentReplies[sentReplies.length - 1].text, /LUMI SPEAKER BROADCAST/i);

    const mockAudioData = Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00_TEST_VOICE_NOTE_OPUS_SAMPLE_DATA_');
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      messageType: 'voice_note',
      mediaBuffer: mockAudioData,
      rawMessage: {
        message: {
          audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
        },
      },
    });

    // Verify audio saved to disk
    const savedFiles = await fsp.readdir(castsDir);
    assert.equal(savedFiles.length, 1, 'Audio file should be written to castsDir');
    const savedFilePath = path.join(castsDir, savedFiles[0]);
    const savedBuffer = await fsp.readFile(savedFilePath);
    assert.deepEqual(savedBuffer, mockAudioData, 'Saved audio file content must match incoming buffer');

    // Verify prompt asks to select speaker
    const selectPrompt = sentReplies[sentReplies.length - 1].text;
    assert.match(selectPrompt, /Select Speaker/i);
    assert.match(selectPrompt, /Living Room Sonos/);
    assert.match(selectPrompt, /Kitchen Google Nest/);
    assert.match(selectPrompt, /Master Bedroom Echo/);
    assert.match(selectPrompt, /Patio Outdoor Speaker/);
    assert.match(selectPrompt, /All Speakers \(Whole House\)/);

    // ─────────────────────────────────────────────────────────────
    // Part 2: HTTP Local Serving Check
    // ─────────────────────────────────────────────────────────────
    const audioUrl = `http://127.0.0.1:${port}/api/bot/casts/${savedFiles[0]}`;
    const httpRes = await fetch(audioUrl);
    assert.equal(httpRes.status, 200, 'HTTP endpoint must serve audio file with 200 OK');
    const downloadedArrayBuffer = await httpRes.arrayBuffer();
    const downloadedBuf = Buffer.from(downloadedArrayBuffer);
    assert.deepEqual(downloadedBuf, mockAudioData, 'HTTP downloaded audio must match original audio');

    // ─────────────────────────────────────────────────────────────
    // Part 3: Speaker Selection Commands Verification
    // ─────────────────────────────────────────────────────────────
    const speakers = configMgr.getConfig().speakers;

    // Test Play 1
    const p1 = bot._parseSpeakerSelection('play 1', speakers);
    assert.equal(p1.length, 1);
    assert.equal(p1[0].name, 'Living Room Sonos');

    // Test play-1
    const p1Dash = bot._parseSpeakerSelection('play-1', speakers);
    assert.equal(p1Dash.length, 1);
    assert.equal(p1Dash[0].name, 'Living Room Sonos');

    // Test PLAY 1
    const p1Upper = bot._parseSpeakerSelection('PLAY 1', speakers);
    assert.equal(p1Upper.length, 1);
    assert.equal(p1Upper[0].name, 'Living Room Sonos');

    // Test Play 1,2,4
    const pMulti = bot._parseSpeakerSelection('Play 1,2,4', speakers);
    assert.equal(pMulti.length, 3);
    assert.equal(pMulti[0].name, 'Living Room Sonos');
    assert.equal(pMulti[1].name, 'Kitchen Google Nest');
    assert.equal(pMulti[2].name, 'Patio Outdoor Speaker');

    // Test play-1,2,4
    const pMultiDash = bot._parseSpeakerSelection('play-1,2,4', speakers);
    assert.equal(pMultiDash.length, 3);

    // Test Play 1, 2, 4 with spaces
    const pMultiSpace = bot._parseSpeakerSelection('Play 1, 2, 4', speakers);
    assert.equal(pMultiSpace.length, 3);

    // Test play all
    const pAll = bot._parseSpeakerSelection('play all', speakers);
    assert.equal(pAll.length, 4);

    // Test all
    const pAllRaw = bot._parseSpeakerSelection('all', speakers);
    assert.equal(pAllRaw.length, 4);

    // Test single number without play prefix
    const pRawNum = bot._parseSpeakerSelection('2', speakers);
    assert.equal(pRawNum.length, 1);
    assert.equal(pRawNum[0].name, 'Kitchen Google Nest');

    // ─────────────────────────────────────────────────────────────
    // Part 4: Execute speaker broadcast selection & verify playback
    // ─────────────────────────────────────────────────────────────
    mediaCalls.length = 0;
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      text: 'Play 1,2,4',
      messageType: 'text',
    });

    assert.equal(mediaCalls.length, 3, 'Must trigger playback on all 3 requested speakers');
    assert.equal(mediaCalls[0].entityId, 'media_player.living_room_sonos');
    assert.equal(mediaCalls[1].entityId, 'media_player.kitchen_nest');
    assert.equal(mediaCalls[2].entityId, 'media_player.patio_speaker');
    assert.match(sentReplies[sentReplies.length - 1].text, /Broadcast Active/i);

    // Session should be closed after broadcast
    assert.ok(!bot._getSession('919876543210'), 'Session must be closed after broadcast');

    // ─────────────────────────────────────────────────────────────
    // Part 5: Direct Audio Caption Execution
    // ─────────────────────────────────────────────────────────────
    mediaCalls.length = 0;
    // User sends /cast
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      text: '/cast',
      messageType: 'text',
    });

    // User sends audio WITH caption "play all"
    await bot.handleIncomingMessage({
      clientId: 'c1',
      sender: '919876543210',
      messageType: 'audio',
      caption: 'play all',
      mediaBuffer: mockAudioData,
      rawMessage: {
        message: {
          audioMessage: { mimetype: 'audio/mp3' },
        },
      },
    });

    // Should immediately broadcast to all 4 speakers without needing another step!
    assert.equal(mediaCalls.length, 4, 'Caption "play all" must immediately broadcast to all 4 speakers');
    assert.match(sentReplies[sentReplies.length - 1].text, /Broadcast Active/i);
    assert.ok(!bot._getSession('919876543210'), 'Session should be completed');

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await cleanupDir(tmpDir);
  }
});

test('Speaker Casting: Strict Volume Preservation Verification', async () => {
  const haClient = new HomeAssistantClient({
    dryRun: true,
  });

  const res = await haClient.playMedia('media_player.living_room_speaker', '/api/bot/casts/sample.ogg', 'music');
  assert.equal(res.success, true);
  assert.equal(res.domain, 'media_player');
  assert.equal(res.service, 'play_media');
  assert.equal(res.serviceData.entity_id, 'media_player.living_room_speaker');
  assert.equal(res.serviceData.media_content_id, '/api/bot/casts/sample.ogg');
  assert.equal(res.serviceData.media_content_type, 'music');
  
  // CRITICAL: Volume level must NOT be included in serviceData
  assert.equal(res.serviceData.volume_level, undefined, 'Speaker volume must NEVER be modified; volume_level must be undefined');
});
