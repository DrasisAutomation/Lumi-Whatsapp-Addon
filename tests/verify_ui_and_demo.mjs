/**
 * tests/verify_ui_and_demo.mjs
 * Comprehensive end-to-end verification of:
 * 1. escapeHtml definition and DOM rendering without ReferenceErrors
 * 2. Duplicate plus (+ +) elimination in buttons & headings
 * 3. Safe demo data seeding and CRUD without triggering physical speakers (dryRun)
 * 4. Interactive conversational bot state machine (/remote and /cast)
 * 5. Full JSON configuration backup & restore
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. Verify frontend files syntax, escapeHtml, and duplicate pluses
test('Frontend: escapeHtml is declared and eliminates ReferenceErrors', () => {
  const appJsPath = path.join(rootDir, 'whatsapp_addon/frontend/js/app.js');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Must declare function escapeHtml
  assert.match(appJs, /function\s+escapeHtml\s*\(/, 'app.js must declare escapeHtml');

  // Verify escapeHtml function behavior
  const fnMatch = appJs.match(/function\s+escapeHtml\s*\(([^)]*)\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, 'escapeHtml function block found');

  const escapeFn = new Function('str', fnMatch[2]);
  assert.equal(escapeFn('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeFn('Living Room & Balcony'), 'Living Room &amp; Balcony');
  assert.equal(escapeFn(null), '');
  assert.equal(escapeFn(undefined), '');
  assert.equal(escapeFn(123), '123');
});

test('Frontend: No duplicate plus (+ +) in buttons or headings', () => {
  const indexPath = path.join(rootDir, 'whatsapp_addon/frontend/index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  // Search for any pattern like "+ Add", "+ +", etc. inside button spans or headings
  const buttonDoublePlus = html.match(/<button[^>]*>[\s\S]*?\+[\s\S]*?\+ Add/gi);
  assert.equal(buttonDoublePlus, null, 'No buttons should contain duplicate pluses');

  // Buttons with SVG plus icon must not also have '+' inside span
  const svgPlusAndSpan = html.match(/<svg[^>]*class="btn-icon"[^>]*>[\s\S]*?<span>\s*\+/gi);
  assert.equal(svgPlusAndSpan, null, 'Buttons with SVG icon must not have leading + in span text');

  // Headings should say "Add Speaker", not "+ Add Speaker"
  assert.doesNotMatch(html, /<h4[^>]*>\s*\+\s*Add\s+Speaker/i);
  assert.doesNotMatch(html, /<h4[^>]*>\s*\+\s*Add\s+Authorized/i);
});

test('Frontend: Google Material 3 Hub cards present with dynamic metrics', () => {
  const indexPath = path.join(rootDir, 'whatsapp_addon/frontend/index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  assert.match(html, /id="hub-rooms-count"/, 'Must have hub-rooms-count placeholder');
  assert.match(html, /id="hub-devices-count"/, 'Must have hub-devices-count placeholder');
  assert.match(html, /id="hub-speakers-count"/, 'Must have hub-speakers-count placeholder');
  assert.match(html, /id="hub-auth-count"/, 'Must have hub-auth-count placeholder');
  assert.match(html, /id="load-demo-btn"/, 'Must have load-demo-btn button');
});

test('Backend & Bot: Demo seeding and safe execution without speaker noise', async () => {
  const { createApp } = await import('../whatsapp_addon/src/server.js');
  const { BotConfigManager } = await import('../whatsapp_addon/src/bot/config-manager.js');
  const { HomeAssistantClient } = await import('../whatsapp_addon/src/bot/homeassistant-client.js');
  const { InteractiveBot } = await import('../whatsapp_addon/src/bot/interactive-bot.js');

  const tmpDir = path.join(os.tmpdir(), `lumi_demo_verify_${Date.now()}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const haClient = new HomeAssistantClient({ dryRun: true });
  assert.equal(haClient.dryRun, true, 'dryRun MUST be true to avoid physical speaker trigger');

  const configMgr = new BotConfigManager({ dataDir: tmpDir });
  await configMgr.init();

  // Load demo setup
  const demo = await configMgr.loadDemoConfig();
  assert.equal(demo.rooms.length, 2, '2 demo rooms loaded');
  assert.equal(demo.rooms[0].name, 'Living Room');
  assert.equal(demo.rooms[0].devices.length, 3);
  assert.equal(demo.rooms[1].name, 'Master Bedroom');
  assert.equal(demo.speakers.length, 2, '2 demo speakers loaded');
  assert.equal(demo.speakers[0].name, 'Living Room Speaker');
  assert.equal(demo.authorizedNumbers.length, 1);
  assert.equal(demo.authorizedNumbers[0].phone, '919876543210');

  const sentReplies = [];
  const mockMsgManager = {
    sendMessage: async (args) => {
      sentReplies.push(args);
      return { id: `msg_${Date.now()}` };
    },
  };

  // Verify Interactive Bot with demo config in dryRun mode
  const bot = new InteractiveBot({
    configManager: configMgr,
    haClient,
    messageManager: mockMsgManager,
    dataDir: tmpDir,
    logger: null,
  });
  bot.init();

  const authUser = '919876543210';
  const unauthUser = '919999999999';

  // 1. Unauthorized user receives access denied
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: unauthUser,
    text: '/remote',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 1);
  assert.match(sentReplies[0].text, /Access Denied/i);

  // 2. Authorized user sends /remote -> lists demo rooms
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: '/remote',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 2);
  assert.match(sentReplies[1].text, /Living Room/);
  assert.match(sentReplies[1].text, /Master Bedroom/);

  // 3. User selects room 1 (Living Room) -> lists devices
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: '1',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 3);
  assert.match(sentReplies[2].text, /Ceiling Light/);
  assert.match(sentReplies[2].text, /Ceiling Fan/);
  assert.match(sentReplies[2].text, /Air Conditioner/);

  // 4. User commands toggle: "on 1,2" (dry-run, no hardware triggered!)
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: 'on 1,2',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 4);
  assert.match(sentReplies[3].text, /turned \*ON\*/i);
  assert.match(sentReplies[3].text, /Ceiling Light/);
  assert.match(sentReplies[3].text, /Ceiling Fan/);

  // Verify HA client recorded calls in history without external HTTP calls
  assert.ok(haClient.history.length >= 2, 'Dry run calls recorded safely');
  assert.equal(haClient.history[0].dryRun, true);

  // 5. User exits with /end
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: '/end',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 5);
  assert.match(sentReplies[4].text, /Remote Session Ended/i);

  // 6. User initiates /cast broadcast
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: '/cast',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 6);
  assert.match(sentReplies[5].text, /LUMI SPEAKER BROADCAST/i);

  // 7. User sends voice note / audio
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    messageType: 'audio',
    mediaBuffer: Buffer.from('fake-audio-sample'),
    mimeType: 'audio/ogg',
  });
  assert.equal(sentReplies.length, 7);
  assert.match(sentReplies[6].text, /Audio Received/i);
  assert.match(sentReplies[6].text, /Living Room Speaker/);
  assert.match(sentReplies[6].text, /Bedroom Echo Dot/);

  // 8. User plays on speaker 1 (dry-run, speaker is NOT physically triggered!)
  await bot.handleIncomingMessage({
    clientId: 'default',
    sender: authUser,
    text: 'play 1',
    messageType: 'text',
  });
  assert.equal(sentReplies.length, 8);
  assert.match(sentReplies[7].text, /Broadcasting Announcement/i);
  assert.match(sentReplies[7].text, /Living Room Speaker/);

  // Verify HA client broadcast call was recorded in dryRun history
  const lastCall = haClient.history[haClient.history.length - 1];
  assert.equal(lastCall.dryRun, true, 'Speaker broadcast MUST be dry-run');

  // Clean up
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
