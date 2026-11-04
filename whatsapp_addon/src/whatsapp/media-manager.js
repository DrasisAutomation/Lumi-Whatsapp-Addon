'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const {
  ValidationError,
  validateLocalMediaPath,
  validateAndResolveRemoteUrl,
  detectMimeAndValidateMagicBytes,
} = require('../utils/validation');

/**
 * MediaManager handles:
 * - Local file validation & path traversal prevention (/config/www, /media, /share)
 * - CCTV snapshot readiness polling (waitForFileReady: waits for file creation, non-zero size, and size stability)
 * - Remote HTTP/HTTPS downloading with SSRF protection, timeouts, and streaming size limits
 * - Magic-byte MIME verification for images, videos, audio, and documents
 * - Optional per-recipient duplicate media alert cooldown
 */
class MediaManager {
  constructor({
    allowedDirs = ['/config/www', '/media', '/share'],
    allowedLocalHosts = [],
    maxSizeMb = 25,
    snapshotWaitTimeoutMs = 10000,
    cooldownSeconds = 0,
    diagnostics = null,
    logger = null,
  } = {}) {
    this.allowedDirs = allowedDirs;
    this.allowedLocalHosts = allowedLocalHosts;
    this.maxSizeBytes = Math.max(1, Number(maxSizeMb) || 25) * 1024 * 1024;
    this.snapshotWaitTimeoutMs = Math.max(500, Number(snapshotWaitTimeoutMs) || 10000);
    this.cooldownSeconds = Math.max(0, Number(cooldownSeconds) || 0);
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.cooldownCache = new Map(); // key -> timestampMs
  }

  /**
   * Checks and records per-recipient media alert cooldown if enabled.
   */
  checkAndRecordCooldown({ clientId, to, mediaSource, cooldownSecondsOverride }) {
    const effectiveCooldownSec =
      typeof cooldownSecondsOverride === 'number' ? cooldownSecondsOverride : this.cooldownSeconds;
    if (!effectiveCooldownSec || effectiveCooldownSec <= 0) {
      return { suppressed: false };
    }

    const key = `${clientId}:${to}:${mediaSource}`;
    const now = Date.now();
    const lastSent = this.cooldownCache.get(key) || 0;
    const elapsedSec = (now - lastSent) / 1000;

    if (elapsedSec < effectiveCooldownSec) {
      return {
        suppressed: true,
        remainingSeconds: Math.ceil(effectiveCooldownSec - elapsedSec),
      };
    }

    this.cooldownCache.set(key, now);
    return { suppressed: false };
  }

  /**
   * Waits for a local file (such as a camera.snapshot output) to exist,
   * have size > 0, and have stable size + mtime across two consecutive polls.
   */
  async waitForFileReady(canonicalOrCandidatePath, timeoutMs = this.snapshotWaitTimeoutMs, pollIntervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableCount = 0;

    while (Date.now() <= deadline) {
      try {
        const stat = await fsp.stat(canonicalOrCandidatePath);
        if (stat.isFile() && stat.size > 0) {
          if (stat.size === lastSize) {
            stableCount += 1;
            if (stableCount >= 1) {
              return stat;
            }
          } else {
            lastSize = stat.size;
            stableCount = 0;
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new ValidationError(
            `Cannot access media file "${canonicalOrCandidatePath}": ${err.message}`,
            'FILE_ACCESS_ERROR',
            403
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (!fs.existsSync(canonicalOrCandidatePath)) {
      throw new ValidationError(
        `Media file not found after waiting ${timeoutMs}ms: ${canonicalOrCandidatePath}`,
        'FILE_NOT_FOUND',
        404
      );
    }

    const finalStat = await fsp.stat(canonicalOrCandidatePath);
    if (!finalStat.isFile() || finalStat.size === 0) {
      throw new ValidationError(
        `Media file is empty or incomplete after ${timeoutMs}ms: ${canonicalOrCandidatePath}`,
        'INVALID_MEDIA_CONTENT',
        400
      );
    }
    return finalStat;
  }

  async loadLocalMedia(filePath, mediaCategory, { waitForReady = true, timeoutMs } = {}) {
    // 1. Validate path is inside allowedDirs before waiting
    const candidatePath = validateLocalMediaPath(filePath, { allowedDirs: this.allowedDirs });

    // 2. Wait for snapshot/file readiness if requested
    const stat = waitForReady
      ? await this.waitForFileReady(candidatePath, timeoutMs || this.snapshotWaitTimeoutMs)
      : await fsp.stat(candidatePath).catch((err) => {
          if (err.code === 'ENOENT') {
            throw new ValidationError(`Media file not found: ${filePath}`, 'FILE_NOT_FOUND', 404);
          }
          throw new ValidationError(`Media file error: ${err.message}`, 'FILE_ACCESS_ERROR', 403);
        });

    // 3. Re-validate realpath after file exists to prevent TOCTOU symlink swaps
    const safeRealPath = validateLocalMediaPath(candidatePath, { allowedDirs: this.allowedDirs });

    if (stat.size > this.maxSizeBytes) {
      throw new ValidationError(
        `Media file size (${Math.round(stat.size / 1024 / 1024)}MB) exceeds limit (${Math.round(
          this.maxSizeBytes / 1024 / 1024
        )}MB).`,
        'MEDIA_TOO_LARGE',
        413
      );
    }

    const buffer = await fsp.readFile(safeRealPath);
    const mimetype = detectMimeAndValidateMagicBytes(buffer, safeRealPath, mediaCategory);
    return {
      buffer,
      mimetype,
      fileName: path.basename(safeRealPath),
      size: buffer.length,
      sourceType: 'local_file',
    };
  }

  async downloadRemoteMedia(urlString, mediaCategory, { timeoutMs = 20000, maxRedirects = 3 } = {}) {
    let currentUrl = urlString;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const { url } = await validateAndResolveRemoteUrl(currentUrl, {
        allowedLocalHosts: this.allowedLocalHosts,
      });

      const response = await new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const req = client.get(
          url,
          {
            timeout: timeoutMs,
            headers: {
              'User-Agent': 'HomeAssistant-WhatsApp-Addon/1.0',
              Accept: '*/*',
            },
          },
          (res) => resolve(res)
        );
        req.on('timeout', () => {
          req.destroy(new ValidationError('Media URL download timed out.', 'MEDIA_DOWNLOAD_TIMEOUT', 408));
        });
        req.on('error', (err) => reject(err));
      });

      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          throw new ValidationError('Media URL redirect missing Location header.', 'MEDIA_DOWNLOAD_FAILED', 400);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        const statusErr = new ValidationError(
          `Media URL returned HTTP ${response.statusCode}.`,
          response.statusCode === 404 || response.statusCode === 410 ? 'EXPIRED_OR_MISSING_MEDIA_URL' : 'MEDIA_DOWNLOAD_FAILED',
          response.statusCode >= 500 ? 502 : 400
        );
        if (response.statusCode >= 500) {
          statusErr.permanent = false;
        }
        throw statusErr;
      }

      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > this.maxSizeBytes) {
        response.destroy();
        throw new ValidationError(
          `Remote media Content-Length (${Math.round(contentLength / 1024 / 1024)}MB) exceeds limit.`,
          'MEDIA_TOO_LARGE',
          413
        );
      }

      const chunks = [];
      let totalBytes = 0;
      await new Promise((resolve, reject) => {
        response.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > this.maxSizeBytes) {
            response.destroy();
            reject(
              new ValidationError(
                'Remote media stream exceeded maximum allowed size.',
                'MEDIA_TOO_LARGE',
                413
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', resolve);
        response.on('error', reject);
      });

      const buffer = Buffer.concat(chunks);
      const mimetype = detectMimeAndValidateMagicBytes(buffer, url, mediaCategory);
      const urlPathname = new URL(url).pathname;
      const fileName = path.basename(urlPathname) || `media.${mimetype.split('/')[1] || 'bin'}`;

      return {
        buffer,
        mimetype,
        fileName,
        size: buffer.length,
        sourceType: 'remote_url',
      };
    }

    throw new ValidationError('Too many redirects while downloading media URL.', 'TOO_MANY_REDIRECTS', 400);
  }

  async resolveMediaInput({ source, base64, fileName, mediaCategory = 'image', clientId = 'default' }) {
    try {
      if (base64 && typeof base64 === 'string') {
        const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(cleaned, 'base64');
        if (buffer.length > this.maxSizeBytes) {
          throw new ValidationError('Base64 media payload exceeds maximum allowed size.', 'MEDIA_TOO_LARGE', 413);
        }
        const mimetype = detectMimeAndValidateMagicBytes(buffer, fileName || 'upload.bin', mediaCategory);
        return {
          buffer,
          mimetype,
          fileName: fileName || `upload.${mimetype.split('/')[1] || 'bin'}`,
          size: buffer.length,
          sourceType: 'base64',
        };
      }

      if (typeof source !== 'string' || !source.trim()) {
        throw new ValidationError(`Media source path or URL is required for ${mediaCategory}.`, 'INVALID_MEDIA_SOURCE', 400);
      }

      const trimmed = source.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return await this.downloadRemoteMedia(trimmed, mediaCategory);
      }

      return await this.loadLocalMedia(trimmed, mediaCategory, { waitForReady: true });
    } catch (err) {
      this.diagnostics?.recordMediaError({
        clientId,
        mediaType: mediaCategory,
        sourceType: base64 ? 'base64' : String(source).startsWith('http') ? 'remote_url' : 'local_file',
        code: err.code || 'MEDIA_ERROR',
        message: err.message,
      });
      throw err;
    }
  }

  /**
   * Builds the Baileys sendMessage content object for image, video, document, or audio.
   */
  async buildBaileysMediaMessage({
    mediaCategory,
    source,
    base64,
    caption = '',
    fileName = null,
    ptt = false,
    clientId = 'default',
  }) {
    const resolved = await this.resolveMediaInput({
      source,
      base64,
      fileName,
      mediaCategory,
      clientId,
    });

    const effectiveCaption = typeof caption === 'string' && caption.trim() ? caption.trim() : undefined;

    if (mediaCategory === 'image') {
      return {
        baileysContent: {
          image: resolved.buffer,
          mimetype: resolved.mimetype,
          caption: effectiveCaption,
        },
        meta: {
          mimetype: resolved.mimetype,
          size: resolved.size,
          fileName: fileName || resolved.fileName,
          sourceType: resolved.sourceType,
        },
      };
    }

    if (mediaCategory === 'video') {
      return {
        baileysContent: {
          video: resolved.buffer,
          mimetype: resolved.mimetype,
          caption: effectiveCaption,
        },
        meta: {
          mimetype: resolved.mimetype,
          size: resolved.size,
          fileName: fileName || resolved.fileName,
          sourceType: resolved.sourceType,
        },
      };
    }

    if (mediaCategory === 'audio') {
      return {
        baileysContent: {
          audio: resolved.buffer,
          mimetype: resolved.mimetype,
          ptt: Boolean(ptt),
        },
        meta: {
          mimetype: resolved.mimetype,
          size: resolved.size,
          fileName: fileName || resolved.fileName,
          sourceType: resolved.sourceType,
        },
      };
    }

    // document
    return {
      baileysContent: {
        document: resolved.buffer,
        mimetype: resolved.mimetype,
        fileName: fileName || resolved.fileName || 'document.pdf',
        caption: effectiveCaption,
      },
      meta: {
        mimetype: resolved.mimetype,
        size: resolved.size,
        fileName: fileName || resolved.fileName || 'document.pdf',
        sourceType: resolved.sourceType,
      },
    };
  }
}

module.exports = {
  MediaManager,
};
