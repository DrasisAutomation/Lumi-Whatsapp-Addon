'use strict';

let _baileys = null;

async function getBaileys() {
  if (!_baileys) {
    // Dynamic import allows CommonJS modules to import ES Module packages in Node 20+
    _baileys = await import('@whiskeysockets/baileys');
  }
  return _baileys;
}

// DisconnectReason enum values from Baileys
const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
  401: 'loggedOut',
  403: 'forbidden',
  408: 'timedOut',
  411: 'multideviceMismatch',
  428: 'connectionClosed',
  440: 'connectionReplaced',
  500: 'badSession',
  503: 'unavailableService',
  515: 'restartRequired',
};

module.exports = {
  getBaileys,
  DisconnectReason,
};
