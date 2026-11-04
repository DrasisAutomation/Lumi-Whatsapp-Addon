'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getBaileys } = require('../whatsapp/baileys');

/**
 * Serialized write lock per file path to prevent concurrent atomic rename collisions.
 */
const writeLocks = new Map();

async function withFileLock(filePath, fn) {
  const prev = writeLocks.get(filePath) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  writeLocks.set(filePath, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (writeLocks.get(filePath) === next) {
      writeLocks.delete(filePath);
    }
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function writeJsonAtomic(filePath, data, { replacer = null } = {}) {
  return withFileLock(filePath, async () => {
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const serialized = JSON.stringify(data, replacer, 2);
    const handle = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpPath, filePath);
  });
}

async function readJsonSafe(filePath, defaultValue = null, { reviver = null } = {}) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw, reviver);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    throw err;
  }
}

function loadAddonConfig(dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data')) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const optionsPath = process.env.OPTIONS_PATH || path.join(dataDir, 'options.json');
  let rawOptions = {};
  if (fs.existsSync(optionsPath)) {
    try {
      rawOptions = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    } catch {
      rawOptions = {};
    }
  }

  let apiKey = (process.env.API_KEY || rawOptions.api_key || '').trim();
  const tokenFilePath = path.join(dataDir, 'api_token.txt');
  if (!apiKey) {
    if (fs.existsSync(tokenFilePath)) {
      apiKey = fs.readFileSync(tokenFilePath, 'utf8').trim();
    }
    if (!apiKey) {
      apiKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenFilePath, apiKey, { encoding: 'utf8', mode: 0o600 });
    }
  } else {
    fs.writeFileSync(tokenFilePath, apiKey, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    dataDir,
    sessionsDir: path.join(dataDir, 'sessions'),
    queueDir: path.join(dataDir, 'queue'),
    historyDir: path.join(dataDir, 'history'),
    accountsRegistryPath: path.join(dataDir, 'accounts.json'),
    apiKey,
    logLevel: rawOptions.log_level || process.env.LOG_LEVEL || 'info',
    maxRetries: Number.isInteger(rawOptions.max_retries) ? rawOptions.max_retries : 3,
    retryBaseDelayMs: Number(rawOptions.retry_base_delay_ms) || 2000,
    mediaMaxSizeMb: Number(rawOptions.media_max_size_mb) || 25,
    snapshotWaitTimeoutMs: Number(rawOptions.snapshot_wait_timeout_ms) || 10000,
    cooldownSeconds: Number(rawOptions.cooldown_seconds) || 0,
    allowedLocalHosts: Array.isArray(rawOptions.allowed_local_hosts) ? rawOptions.allowed_local_hosts : [],
    allowedMediaDirs: process.env.ALLOWED_MEDIA_DIRS
      ? process.env.ALLOWED_MEDIA_DIRS.split(path.delimiter).filter(Boolean)
      : ['/config/www', '/media', '/share'],
  };
}

/**
 * Atomic, crash-safe implementation of Baileys multi-file authentication state.
 * Uses write-then-fsync-then-rename and backups of creds.json so power loss
 * or container restart never corrupts Signal session keys or credentials.
 */
async function useAtomicMultiFileAuthState(sessionFolder) {
  const { initAuthCreds, BufferJSON, proto } = await getBaileys();
  await ensureDir(sessionFolder);

  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-') || '';

  const writeData = async (data, file) => {
    const filePath = path.join(sessionFolder, fixFileName(file));
    await writeJsonAtomic(filePath, data, { replacer: BufferJSON.replacer });
    if (file === 'creds.json') {
      const backupPath = path.join(sessionFolder, 'creds.json.bak');
      await writeJsonAtomic(backupPath, data, { replacer: BufferJSON.replacer });
    }
  };

  const readData = async (file) => {
    const filePath = path.join(sessionFolder, fixFileName(file));
    try {
      return await readJsonSafe(filePath, null, { reviver: BufferJSON.reviver });
    } catch (err) {
      if (file === 'creds.json') {
        const backupPath = path.join(sessionFolder, 'creds.json.bak');
        return await readJsonSafe(backupPath, null, { reviver: BufferJSON.reviver });
      }
      return null;
    }
  };

  const removeData = async (file) => {
    const filePath = path.join(sessionFolder, fixFileName(file));
    return withFileLock(filePath, async () => {
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    });
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, 'creds.json');
    },
  };
}

module.exports = {
  ensureDir,
  writeJsonAtomic,
  readJsonSafe,
  loadAddonConfig,
  useAtomicMultiFileAuthState,
};
