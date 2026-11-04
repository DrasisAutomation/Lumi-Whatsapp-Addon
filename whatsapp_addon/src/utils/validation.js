'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;

const CLIENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;
const PHONE_DIGITS_REGEX = /^\+?[1-9]\d{5,15}$/;
const GROUP_JID_REGEX = /^[0-9-]{5,32}@g\.us$/;
const USER_JID_REGEX = /^[1-9]\d{5,15}@s\.whatsapp\.net$/;
const LID_JID_REGEX = /^[0-9]{5,24}@lid$/;

const DEFAULT_ALLOWED_MEDIA_DIRS = [
  '/config/www',
  '/media',
  '/share',
];

const SUPPORTED_MEDIA_MIMES = {
  image: {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  },
  video: {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
  },
  audio: {
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg; codecs=opus',
    '.opus': 'audio/ogg; codecs=opus',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
  },
  document: {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  },
};

class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_REGEX.test(clientId.trim())) {
    throw new ValidationError(
      'Invalid clientId. Must be 1-32 characters containing only letters, digits, underscores, or hyphens.',
      'INVALID_CLIENT_ID',
      400
    );
  }
  return clientId.trim();
}

function normalizeRecipientJid(to, { allowGroup = true } = {}) {
  if (typeof to !== 'string' || !to.trim()) {
    throw new ValidationError('Recipient ("to") is required.', 'INVALID_RECIPIENT', 400);
  }
  const raw = to.trim();

  if (raw.endsWith('@g.us')) {
    if (!allowGroup) {
      throw new ValidationError('Group JID is not allowed for this operation.', 'GROUP_NOT_ALLOWED', 400);
    }
    if (!GROUP_JID_REGEX.test(raw)) {
      throw new ValidationError('Invalid WhatsApp group JID format.', 'INVALID_GROUP_JID', 400);
    }
    return raw;
  }

  if (raw.endsWith('@s.whatsapp.net')) {
    if (!USER_JID_REGEX.test(raw)) {
      throw new ValidationError('Invalid WhatsApp user JID format.', 'INVALID_USER_JID', 400);
    }
    return raw;
  }

  if (raw.endsWith('@lid')) {
    if (!LID_JID_REGEX.test(raw)) {
      throw new ValidationError('Invalid WhatsApp LID format.', 'INVALID_LID_JID', 400);
    }
    return raw;
  }

  // Strip spaces, dashes, parentheses
  const cleaned = raw.replace(/[\s()-]/g, '');
  if (!PHONE_DIGITS_REGEX.test(cleaned)) {
    throw new ValidationError(
      'Invalid phone number or JID. Provide E.164 digits (e.g. "919876543210") or a valid WhatsApp JID.',
      'INVALID_RECIPIENT',
      400
    );
  }

  const digits = cleaned.replace(/^\+/, '');
  return `${digits}@s.whatsapp.net`;
}

function validateTextBody(body) {
  let text = '';
  if (typeof body === 'string') {
    text = body.trim();
  } else if (body && typeof body === 'object' && typeof body.text === 'string') {
    text = body.text.trim();
  }
  if (!text) {
    throw new ValidationError('Message text cannot be empty.', 'EMPTY_MESSAGE_TEXT', 400);
  }
  if (text.length > 65536) {
    throw new ValidationError('Message text exceeds maximum length (65536 characters).', 'MESSAGE_TOO_LONG', 400);
  }
  return text;
}

function validateLocationPayload(payload) {
  const lat = Number(payload?.latitude);
  const lon = Number(payload?.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ValidationError('Invalid latitude; must be between -90 and 90.', 'INVALID_LOCATION', 400);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new ValidationError('Invalid longitude; must be between -180 and 180.', 'INVALID_LOCATION', 400);
  }
  return {
    degreesLatitude: lat,
    degreesLongitude: lon,
    name: typeof payload?.name === 'string' ? payload.name.slice(0, 256) : undefined,
    address: typeof payload?.address === 'string' ? payload.address.slice(0, 512) : undefined,
  };
}

function isPrivateOrLoopbackIp(ip) {
  if (!net.isIP(ip)) {
    return true;
  }
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 127) return true; // Loopback / current network
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (parts[0] >= 224) return true; // Multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return true;
    if (norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd')) return true;
    if (norm.startsWith('::ffff:')) {
      const v4 = norm.slice(7);
      if (net.isIPv4(v4)) return isPrivateOrLoopbackIp(v4);
    }
    return false;
  }
  return true;
}

async function validateAndResolveRemoteUrl(urlString, { allowedLocalHosts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ValidationError('Invalid media URL syntax.', 'INVALID_MEDIA_URL', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http:// and https:// media URLs are supported.', 'UNSUPPORTED_URL_PROTOCOL', 400);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const normalizedWhitelist = new Set(
    (Array.isArray(allowedLocalHosts) ? allowedLocalHosts : [])
      .filter((h) => typeof h === 'string' && h.trim())
      .map((h) => h.trim().toLowerCase())
  );

  const isExplicitlyAllowed = normalizedWhitelist.has(hostname);

  // Always block cloud metadata IP 169.254.169.254 regardless of whitelist
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    throw new ValidationError('Access to cloud metadata endpoints is forbidden.', 'SSRF_BLOCKED', 403);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrLoopbackIp(hostname) && !isExplicitlyAllowed) {
      throw new ValidationError(
        `Media URL target IP (${hostname}) is a loopback or private network address. Add it to allowed_local_hosts in add-on config if trusted.`,
        'SSRF_BLOCKED',
        403
      );
    }
    return { url: parsed.toString(), hostname, resolvedAddresses: [hostname] };
  }

  if ((hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) && !isExplicitlyAllowed) {
    throw new ValidationError(
      `Media URL hostname (${hostname}) is a local address. Add it to allowed_local_hosts in add-on config if trusted.`,
      'SSRF_BLOCKED',
      403
    );
  }

  let addresses = [];
  try {
    const records = await dns.lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch (err) {
    throw new ValidationError(`Failed to resolve media URL hostname (${hostname}): ${err.message}`, 'DNS_LOOKUP_FAILED', 400);
  }

  if (addresses.length === 0) {
    throw new ValidationError(`Hostname (${hostname}) did not resolve to any IP address.`, 'DNS_LOOKUP_FAILED', 400);
  }

  for (const addr of addresses) {
    if (addr === '169.254.169.254') {
      throw new ValidationError('Access to cloud metadata endpoints is forbidden.', 'SSRF_BLOCKED', 403);
    }
    if (isPrivateOrLoopbackIp(addr) && !isExplicitlyAllowed) {
      throw new ValidationError(
        `Hostname (${hostname}) resolves to private/loopback IP (${addr}). Add ${hostname} to allowed_local_hosts if trusted.`,
        'SSRF_BLOCKED',
        403
      );
    }
  }

  return { url: parsed.toString(), hostname, resolvedAddresses: addresses };
}

function validateLocalMediaPath(inputPath, { allowedDirs = DEFAULT_ALLOWED_MEDIA_DIRS } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new ValidationError('Media file path is required.', 'INVALID_MEDIA_PATH', 400);
  }

  const rawPath = inputPath.trim();
  if (rawPath.includes('\0')) {
    throw new ValidationError('Null bytes are not permitted in file paths.', 'PATH_TRAVERSAL_BLOCKED', 403);
  }

  // Remap Home Assistant /local/... alias to /config/www/...
  const normalizedInput = rawPath.startsWith('/local/')
    ? path.posix.join('/config/www', rawPath.slice('/local/'.length))
    : rawPath;

  const resolvedAllowedRoots = allowedDirs.map((dir) => path.resolve(dir));
  const candidateResolved = path.resolve(normalizedInput);

  const isWithinAllowedCandidate = resolvedAllowedRoots.some((root) => {
    const rel = path.relative(root, candidateResolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });

  if (!isWithinAllowedCandidate) {
    throw new ValidationError(
      `Access denied: "${rawPath}" is outside allowed media directories (${allowedDirs.join(', ')}).`,
      'PATH_TRAVERSAL_BLOCKED',
      403
    );
  }

  // If the file already exists, also verify its realpath (resolving symlinks) stays inside allowedDirs
  if (fs.existsSync(candidateResolved)) {
    const realCandidate = fs.realpathSync(candidateResolved);
    const realAllowedRoots = resolvedAllowedRoots.map((root) => (fs.existsSync(root) ? fs.realpathSync(root) : root));
    const isRealWithinAllowed = realAllowedRoots.some((root) => {
      const rel = path.relative(root, realCandidate);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!isRealWithinAllowed) {
      throw new ValidationError(
        'Access denied: Symbolic link points outside allowed media directories.',
        'SYMLINK_ESCAPE_BLOCKED',
        403
      );
    }
    return realCandidate;
  }

  return candidateResolved;
}

function detectMimeAndValidateMagicBytes(buffer, filePathOrUrl, mediaCategory = 'image') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new ValidationError('Media file is empty or corrupted.', 'INVALID_MEDIA_CONTENT', 400);
  }

  // Magic byte signatures
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const isPdf = buffer.subarray(0, 4).toString('ascii') === '%PDF';
  const isMp4 =
    buffer.length >= 12 &&
    (buffer.subarray(4, 8).toString('ascii') === 'ftyp' ||
      buffer.subarray(4, 8).toString('ascii') === 'moov' ||
      buffer.subarray(4, 8).toString('ascii') === 'mdat');
  const isOgg = buffer.subarray(0, 4).toString('ascii') === 'OggS';
  const isMp3 =
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  const isWav =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE';

  if (mediaCategory === 'image') {
    if (isJpeg) return 'image/jpeg';
    if (isPng) return 'image/png';
    if (isWebp) return 'image/webp';
    throw new ValidationError(
      'Invalid image content. Supported formats are JPEG, PNG, and WebP.',
      'UNSUPPORTED_IMAGE_FORMAT',
      400
    );
  }

  if (mediaCategory === 'video') {
    if (isMp4) return 'video/mp4';
    throw new ValidationError(
      'Invalid video content. Supported format is MP4 (H.264/AAC).',
      'UNSUPPORTED_VIDEO_FORMAT',
      400
    );
  }

  if (mediaCategory === 'audio') {
    if (isOgg) return 'audio/ogg; codecs=opus';
    if (isMp3) return 'audio/mpeg';
    if (isWav) return 'audio/wav';
    if (isMp4) return 'audio/mp4';
    const ext = path.extname(String(filePathOrUrl).split('?')[0]).toLowerCase();
    if (SUPPORTED_MEDIA_MIMES.audio[ext]) {
      return SUPPORTED_MEDIA_MIMES.audio[ext];
    }
    throw new ValidationError('Unsupported audio format.', 'UNSUPPORTED_AUDIO_FORMAT', 400);
  }

  // Document
  if (isPdf) return 'application/pdf';
  if (isJpeg) return 'image/jpeg';
  if (isPng) return 'image/png';
  const ext = path.extname(String(filePathOrUrl).split('?')[0]).toLowerCase();
  return SUPPORTED_MEDIA_MIMES.document[ext] || 'application/octet-stream';
}

module.exports = {
  ValidationError,
  DEFAULT_ALLOWED_MEDIA_DIRS,
  SUPPORTED_MEDIA_MIMES,
  validateClientId,
  normalizeRecipientJid,
  validateTextBody,
  validateLocationPayload,
  isPrivateOrLoopbackIp,
  validateAndResolveRemoteUrl,
  validateLocalMediaPath,
  detectMimeAndValidateMagicBytes,
};
