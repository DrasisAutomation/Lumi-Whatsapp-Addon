'use strict';

const { normalizeRecipientJid, ValidationError } = require('../utils/validation');

class ContactManager {
  constructor({ logger }) {
    this.logger = logger;
    this.contactsByAccount = new Map(); // clientId -> Map<jid, contact>
  }

  _ensureMap(clientId) {
    if (!this.contactsByAccount.has(clientId)) {
      this.contactsByAccount.set(clientId, new Map());
    }
    return this.contactsByAccount.get(clientId);
  }

  upsertContacts(clientId, contacts = []) {
    const map = this._ensureMap(clientId);
    for (const c of contacts) {
      if (!c || !c.id) continue;
      if (c.id === 'status@broadcast' || c.id.endsWith('@g.us')) continue;
      const existing = map.get(c.id) || { jid: c.id };
      map.set(c.id, {
        jid: c.id,
        number: c.id.replace(/@(s\.whatsapp\.net|lid)$/, ''),
        name: c.name || c.notify || c.verifiedName || existing.name || null,
        notify: c.notify || existing.notify || null,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  getContacts(clientId) {
    const map = this.contactsByAccount.get(clientId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) =>
      String(a.name || a.number).localeCompare(String(b.name || b.number))
    );
  }

  async getGroups(clientId, sock) {
    if (!sock) {
      throw new ValidationError(`Account "${clientId}" is not connected.`, 'ACCOUNT_NOT_CONNECTED', 503);
    }
    const groupsObj = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupsObj || {}).map((g) => ({
      id: g.id,
      subject: g.subject || g.id,
      owner: g.owner || null,
      creation: g.creation ? new Date(g.creation * 1000).toISOString() : null,
      participantsCount: Array.isArray(g.participants) ? g.participants.length : 0,
      announce: Boolean(g.announce),
      restrict: Boolean(g.restrict),
    }));
    groups.sort((a, b) => a.subject.localeCompare(b.subject));
    return groups;
  }

  async checkNumber(clientId, sock, numberOrJid) {
    if (!sock) {
      throw new ValidationError(`Account "${clientId}" is not connected.`, 'ACCOUNT_NOT_CONNECTED', 503);
    }
    const jid = normalizeRecipientJid(numberOrJid, { allowGroup: false });
    const results = await sock.onWhatsApp(jid);
    const entry = Array.isArray(results) && results.length > 0 ? results[0] : null;
    return {
      query: numberOrJid,
      exists: Boolean(entry?.exists),
      jid: entry?.jid || jid,
    };
  }

  clearAccount(clientId) {
    this.contactsByAccount.delete(clientId);
  }
}

module.exports = {
  ContactManager,
};
