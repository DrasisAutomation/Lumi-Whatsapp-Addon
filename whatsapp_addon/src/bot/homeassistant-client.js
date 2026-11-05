'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

/**
 * HomeAssistantClient
 * Communicates with Home Assistant Core API via Supervisor or direct Long-Lived Access Token.
 * Features a safe `dryRun` mode for testing without triggering physical hardware relays.
 */
class HomeAssistantClient {
  constructor({
    baseUrl = null,
    token = null,
    dryRun = false,
    timeoutMs = 5000,
    logger = null,
  } = {}) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.dryRun = Boolean(dryRun || process.env.DRY_RUN === 'true');

    // Inside Home Assistant OS / Supervised add-ons, Supervisor token is injected
    const supervisorToken = process.env.SUPERVISOR_TOKEN || token || '';
    this.token = supervisorToken;

    // Default to supervisor proxy inside HA OS, fallback to direct HA URL or localhost
    let rawUrl = baseUrl || (process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : 'http://127.0.0.1:8123/api');
    // Ensure no trailing slash
    this.baseUrl = rawUrl.replace(/\/+$/, '');

    // Dry-run call history for audit and verification
    this.history = [];
  }

  setDryRun(enabled) {
    this.dryRun = Boolean(enabled);
  }

  async _request(method, endpoint, body = null) {
    if (this.dryRun && method !== 'GET') {
      const record = {
        method,
        endpoint,
        body,
        dryRun: true,
        timestamp: new Date().toISOString(),
      };
      this.history.push(record);
      this.logger?.info({ dryRun: true, method, endpoint, body }, 'HA Client: Dry-run call recorded (hardware untouched)');
      return { success: true, dryRun: true, ...record };
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const fullUrl = `${this.baseUrl}${cleanEndpoint}`;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeout: this.timeoutMs,
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsedJson = data ? JSON.parse(data) : {};
              resolve(parsedJson);
            } catch {
              resolve(data);
            }
          } else {
            const err = new Error(`Home Assistant API returned HTTP ${res.statusCode}: ${data || res.statusMessage}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Home Assistant API request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * Fetch all states from Home Assistant Core.
   * Optionally filter by domain (e.g. ['light', 'switch', 'fan', 'climate', 'media_player']).
   */
  async getEntities(domains = null) {
    try {
      const states = await this._request('GET', '/states');
      if (!Array.isArray(states)) {
        return [];
      }
      const allowedDomains = Array.isArray(domains) ? new Set(domains) : null;
      return states
        .filter((item) => {
          if (!item || !item.entity_id) return false;
          if (!allowedDomains) return true;
          const entityDomain = item.entity_id.split('.')[0];
          return allowedDomains.has(entityDomain);
        })
        .map((item) => ({
          entity_id: item.entity_id,
          friendly_name: item.attributes?.friendly_name || item.entity_id,
          state: item.state,
          domain: item.entity_id.split('.')[0],
          attributes: item.attributes || {},
        }));
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'Failed to fetch entities from Home Assistant');
      return [];
    }
  }

  /**
   * Fetch the current state of a specific entity.
   */
  async getEntityState(entityId) {
    if (!entityId) return null;
    try {
      const stateObj = await this._request('GET', `/states/${entityId}`);
      if (stateObj && typeof stateObj === 'object') {
        return {
          entity_id: stateObj.entity_id,
          state: stateObj.state,
          friendly_name: stateObj.attributes?.friendly_name || stateObj.entity_id,
          attributes: stateObj.attributes || {},
        };
      }
      return null;
    } catch (err) {
      this.logger?.debug({ entityId, err: err.message }, 'Could not read entity state; assuming offline/unknown');
      return { entity_id: entityId, state: 'unknown', friendly_name: entityId, attributes: {} };
    }
  }

  /**
   * Execute a service call in Home Assistant (e.g. light.turn_on, media_player.play_media).
   * Respects `dryRun` to prevent firing physical relays or speakers during verification.
   */
  async callService(domain, service, serviceData = {}) {
    if (this.dryRun) {
      const record = {
        domain,
        service,
        serviceData,
        dryRun: true,
        timestamp: new Date().toISOString(),
      };
      this.history.push(record);
      this.logger?.info({ ...record }, 'HA Action Executed (DRY-RUN: No physical device triggered)');
      return { success: true, dryRun: true, ...record };
    }

    try {
      const result = await this._request('POST', `/services/${domain}/${service}`, serviceData);
      return { success: true, result };
    } catch (err) {
      this.logger?.error({ domain, service, serviceData, err: err.message }, 'Failed to execute Home Assistant service');
      throw err;
    }
  }

  async turnOn(entityId) {
    if (!entityId) throw new Error('entity_id is required');
    const domain = entityId.split('.')[0] || 'homeassistant';
    return this.callService(domain, 'turn_on', { entity_id: entityId });
  }

  async turnOff(entityId) {
    if (!entityId) throw new Error('entity_id is required');
    const domain = entityId.split('.')[0] || 'homeassistant';
    return this.callService(domain, 'turn_off', { entity_id: entityId });
  }

  /**
   * Play media on a media_player entity.
   * NOTE: Audio plays at the speaker's CURRENT/LAST ACTIVE VOLUME.
   * No volume level is overridden.
   */
  async playMedia(entityId, mediaUrl, mediaType = 'music') {
    if (!entityId) throw new Error('entity_id is required');
    return this.callService('media_player', 'play_media', {
      entity_id: entityId,
      media_content_id: mediaUrl,
      media_content_type: mediaType,
    });
  }
}

module.exports = { HomeAssistantClient };
