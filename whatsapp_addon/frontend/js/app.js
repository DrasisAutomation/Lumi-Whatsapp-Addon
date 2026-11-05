'use strict';

(function () {
  const state = {
    accounts: [],
    messages: [],
    diagnostics: null,
    activeQrClientId: null,
    ws: null,
    token:
      localStorage.getItem('lumi_whatsapp_token') ||
      new URLSearchParams(window.location.search).get('token') ||
      '',
  };

  function getIngressBasePath() {
    const baseEl = document.querySelector('base');
    if (baseEl && baseEl.getAttribute('href')) {
      const h = baseEl.getAttribute('href');
      if (h && h !== './' && h !== '/') {
        return h.endsWith('/') ? h : `${h}/`;
      }
    }
    let p = window.location.pathname || '/';
    // If pathname ends with a filename (e.g. index.html), strip it to keep the base directory
    if (/\/[^/]+\.[^/]+$/.test(p)) {
      p = p.replace(/\/[^/]+\.[^/]+$/, '/');
    }
    if (!p.endsWith('/')) {
      p += '/';
    }
    return p;
  }

  function apiBaseUrl(endpoint) {
    const clean = endpoint.replace(/^\//, '');
    return `${getIngressBasePath()}${clean}`;
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  async function apiRequest(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    const res = await fetch(apiBaseUrl(endpoint), {
      headers,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      if (res.status === 401 && !window.location.pathname.includes('/ingress/')) {
        const entered = prompt('Direct access to Lumi Whatsapp requires an API Bearer token.\nEnter your API Key (from Add-on Configuration / Diagnostics tab):');
        if (entered && entered.trim()) {
          state.token = entered.trim();
          localStorage.setItem('lumi_whatsapp_token', state.token);
          return apiRequest(endpoint, options);
        }
      }
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    return data;
  }

  function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${rem}s`;
    return `${rem}s`;
  }

  function formatTime(iso) {
    if (!iso) return 'Never';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function renderDashboardAndAccounts() {
    const accounts = state.accounts;
    const connected = accounts.filter((a) => a.status === 'connected').length;
    const disconnected = accounts.length - connected;

    let sent = 0;
    let received = 0;
    let pending = 0;
    let failed = 0;
    for (const acc of accounts) {
      sent += acc.stats?.messagesSent || 0;
      received += acc.stats?.messagesReceived || 0;
      pending += acc.stats?.messagesPending || 0;
      failed += acc.stats?.messagesFailed || 0;
    }

    document.getElementById('kpi-connected').textContent = String(connected);
    document.getElementById('kpi-disconnected').textContent = String(disconnected);
    document.getElementById('kpi-sent').textContent = String(sent);
    document.getElementById('kpi-received').textContent = String(received);
    document.getElementById('kpi-pending').textContent = String(pending);
    document.getElementById('kpi-failed').textContent = String(failed);

    if (state.diagnostics?.health?.uptimeSeconds !== undefined) {
      document.getElementById('kpi-uptime').textContent = formatDuration(
        state.diagnostics.health.uptimeSeconds
      );
    }

    const dashContainer = document.getElementById('dashboard-accounts-list');
    const accContainer = document.getElementById('accounts-container');
    dashContainer.innerHTML = '';
    accContainer.innerHTML = '';

    const msgSelect = document.getElementById('msg-account');
    const histFilter = document.getElementById('history-account-filter');
    const prevMsgAccount = msgSelect.value;
    const prevHistFilter = histFilter.value;
    msgSelect.innerHTML = '';
    histFilter.innerHTML = '<option value="">All Accounts</option>';

    for (const acc of accounts) {
      const opt1 = document.createElement('option');
      opt1.value = acc.clientId;
      opt1.textContent = `${acc.name} (${acc.clientId}) - ${acc.status}`;
      msgSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = acc.clientId;
      opt2.textContent = `${acc.name} (${acc.clientId})`;
      histFilter.appendChild(opt2);

      const card = buildAccountCard(acc);
      accContainer.appendChild(card);
      dashContainer.appendChild(buildAccountCard(acc, true));
    }

    if (prevMsgAccount) msgSelect.value = prevMsgAccount;
    if (prevHistFilter) histFilter.value = prevHistFilter;
  }

  function buildAccountCard(acc, compact = false) {
    const div = document.createElement('div');
    div.className = 'account-card';

    const header = document.createElement('div');
    header.className = 'account-header';

    const titleBox = document.createElement('div');
    const h4 = document.createElement('h4');
    h4.textContent = acc.name;
    const sub = document.createElement('span');
    sub.className = 'subtitle';
    sub.textContent = `clientId: ${acc.clientId}`;
    titleBox.appendChild(h4);
    titleBox.appendChild(sub);

    const badge = document.createElement('span');
    badge.className = `badge ${acc.status}`;
    badge.textContent = acc.status.replace('_', ' ');

    header.appendChild(titleBox);
    header.appendChild(badge);
    div.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'account-meta';
    meta.innerHTML = `
      <div><strong>Phone:</strong> ${acc.phone || 'Not linked'}</div>
      <div><strong>Health:</strong> ${acc.sessionHealth || 'unknown'}</div>
      <div><strong>Sent / Recv:</strong> ${acc.stats?.messagesSent || 0} / ${acc.stats?.messagesReceived || 0}</div>
      <div><strong>Last Active:</strong> ${formatTime(acc.lastActiveAt || acc.lastConnectedAt)}</div>
    `;
    div.appendChild(meta);

    if (acc.lastError?.message) {
      const errP = document.createElement('div');
      errP.style.color = '#f87171';
      errP.style.fontSize = '0.8rem';
      errP.textContent = `Error: ${acc.lastError.message}`;
      div.appendChild(errP);
    }

    if (!compact) {
      const actions = document.createElement('div');
      actions.className = 'account-actions';

      const pairBtn = document.createElement('button');
      pairBtn.className = 'btn btn-primary btn-sm';
      pairBtn.textContent = acc.status === 'connected' ? 'Reconnect' : 'Connect / Show QR';
      pairBtn.addEventListener('click', () => handleConnectAccount(acc.clientId, false));
      actions.appendChild(pairBtn);

      if (acc.status !== 'connected') {
        const regenBtn = document.createElement('button');
        regenBtn.className = 'btn btn-secondary btn-sm';
        regenBtn.textContent = 'Regenerate QR';
        regenBtn.addEventListener('click', () => handleConnectAccount(acc.clientId, true));
        actions.appendChild(regenBtn);
      }

      if (acc.status === 'connected' || acc.status === 'connecting' || acc.status === 'qr_ready') {
        const discBtn = document.createElement('button');
        discBtn.className = 'btn btn-secondary btn-sm';
        discBtn.textContent = 'Disconnect';
        discBtn.addEventListener('click', () => handleDisconnectAccount(acc.clientId));
        actions.appendChild(discBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => handleDeleteAccount(acc.clientId));
      actions.appendChild(delBtn);

      div.appendChild(actions);
    }

    return div;
  }

  async function handleConnectAccount(clientId, regenerateQr = false) {
    try {
      showToast(`Connecting account "${clientId}"...`, 'info');
      await apiRequest(`api/accounts/${encodeURIComponent(clientId)}/connect`, {
        method: 'POST',
        body: JSON.stringify({ regenerateQr }),
      });
      state.activeQrClientId = clientId;
      await pollAccountQr(clientId);
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function pollAccountQr(clientId) {
    try {
      const qrData = await apiRequest(`api/accounts/${encodeURIComponent(clientId)}/qr`);
      if (qrData.qrAvailable && qrData.qrDataUrl) {
        showQrModal(clientId, qrData.qrDataUrl, qrData.qrExpiresAt);
      } else if (qrData.status === 'connected') {
        hideQrModal();
        showToast(`Account "${clientId}" is connected!`, 'success');
      }
    } catch {
      // Ignore transient poll errors
    }
  }

  function showQrModal(clientId, qrDataUrl, expiresAt) {
    const modal = document.getElementById('qr-pairing-modal');
    document.getElementById('qr-title').textContent = `Scan QR Code for Account: ${clientId}`;
    document.getElementById('qr-image').src = qrDataUrl;
    document.getElementById('qr-status-text').textContent = expiresAt
      ? `QR refreshes automatically (expires at ${new Date(expiresAt).toLocaleTimeString()})`
      : 'Waiting for scan...';
    modal.classList.remove('hidden');
  }

  function hideQrModal() {
    document.getElementById('qr-pairing-modal').classList.add('hidden');
    state.activeQrClientId = null;
  }

  async function handleDisconnectAccount(clientId) {
    try {
      await apiRequest(`api/accounts/${encodeURIComponent(clientId)}/disconnect`, {
        method: 'POST',
      });
      showToast(`Account "${clientId}" disconnected.`, 'info');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function handleDeleteAccount(clientId) {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete WhatsApp account "${clientId}" and its stored session credentials?`
    );
    if (!confirmed) return;

    try {
      await apiRequest(`api/accounts/${encodeURIComponent(clientId)}?confirm=true`, {
        method: 'DELETE',
      });
      showToast(`Account "${clientId}" deleted.`, 'success');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderHistoryTable() {
    const filterClientId = document.getElementById('history-account-filter').value;
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '';

    const filtered = filterClientId
      ? state.messages.filter((m) => m.clientId === filterClientId)
      : state.messages;

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="muted">No messages recorded yet.</td>';
      tbody.appendChild(tr);
      return;
    }

    for (const msg of filtered) {
      const tr = document.createElement('tr');
      const tdTime = document.createElement('td');
      tdTime.textContent = formatTime(msg.updatedAt || msg.createdAt);

      const tdAcc = document.createElement('td');
      tdAcc.textContent = msg.clientId;

      const tdTo = document.createElement('td');
      tdTo.textContent = msg.to;

      const tdType = document.createElement('td');
      tdType.textContent = msg.messageType;

      const tdId = document.createElement('td');
      tdId.textContent = msg.messageId;

      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${msg.status}`;
      badge.textContent = msg.status;
      tdStatus.appendChild(badge);

      tr.append(tdTime, tdAcc, tdTo, tdType, tdId, tdStatus);
      tbody.appendChild(tr);
    }
  }

  function renderDiagnostics() {
    const d = state.diagnostics;
    if (!d) return;

    if (d.integrationSetup?.apiKey) {
      document.getElementById('diag-api-key').value = d.integrationSetup.apiKey;
    }
    if (d.integrationSetup?.internalUrl) {
      document.getElementById('diag-internal-url').value = d.integrationSetup.internalUrl;
    }

    document.getElementById('diag-runtime-pre').textContent = JSON.stringify(
      { health: d.health, runtime: d.runtime },
      null,
      2
    );
    document.getElementById('diag-sessions-pre').textContent = JSON.stringify(
      { sessions: d.sessions, queue: d.queue },
      null,
      2
    );
    document.getElementById('diag-conn-errors-pre').textContent = JSON.stringify(
      { connectionErrors: d.connectionErrors, authErrors: d.authErrors },
      null,
      2
    );
    document.getElementById('diag-media-errors-pre').textContent = JSON.stringify(
      { mediaUploadFailures: d.mediaUploadFailures, retryAttempts: d.retryAttempts },
      null,
      2
    );
  }

  async function loadAllData() {
    try {
      const [accRes, msgRes, diagRes] = await Promise.all([
        apiRequest('api/accounts'),
        apiRequest('api/messages?limit=150'),
        apiRequest('api/diagnostics'),
      ]);
      state.accounts = accRes.accounts || [];
      state.messages = msgRes.messages || [];
      state.diagnostics = diagRes;

      renderDashboardAndAccounts();
      renderHistoryTable();
      renderDiagnostics();
    } catch (err) {
      showToast(`Failed to load add-on data: ${err.message}`, 'error');
    }
  }

  function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = getIngressBasePath();
    const tokenQuery = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
    const wsUrl = `${proto}//${window.location.host}${basePath}ws${tokenQuery}`;

    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    const dot = document.getElementById('ws-dot');
    const label = document.getElementById('ws-label');

    ws.onopen = () => {
      dot.className = 'status-dot connected';
      label.textContent = 'Live event stream active';
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'qr_update' && msg.payload) {
          if (!state.activeQrClientId || state.activeQrClientId === msg.payload.clientId) {
            state.activeQrClientId = msg.payload.clientId;
            showQrModal(msg.payload.clientId, msg.payload.qrDataUrl, msg.payload.expiresAt);
          }
        }
        if (msg.type === 'whatsapp_connection_update' && msg.payload?.status === 'connected') {
          if (state.activeQrClientId === msg.payload.clientId) {
            hideQrModal();
            showToast(`Account "${msg.payload.clientId}" connected!`, 'success');
          }
        }
        loadAllData();
      } catch {
        // Ignore malformed frame
      }
    };

    ws.onclose = () => {
      dot.className = 'status-dot disconnected';
      label.textContent = 'Reconnecting stream...';
      setTimeout(connectWebSocket, 3000);
    };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function bindEvents() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.gotoTab));
    });

    document.getElementById('refresh-btn').addEventListener('click', loadAllData);
    document.getElementById('close-qr-btn').addEventListener('click', hideQrModal);
    document.getElementById('history-account-filter').addEventListener('change', renderHistoryTable);

    document.getElementById('add-account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const clientId = document.getElementById('new-client-id').value.trim();
      const name = document.getElementById('new-account-name').value.trim();
      try {
        await apiRequest('api/accounts', {
          method: 'POST',
          body: JSON.stringify({ clientId, name, connectImmediately: true }),
        });
        document.getElementById('new-client-id').value = '';
        document.getElementById('new-account-name').value = '';
        state.activeQrClientId = clientId;
        showToast(`Account "${clientId}" created. Generating QR code...`, 'success');
        setTimeout(() => pollAccountQr(clientId), 1200);
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const msgTypeSelect = document.getElementById('msg-type');
    msgTypeSelect.addEventListener('change', () => {
      const isText = msgTypeSelect.value === 'text';
      document.getElementById('msg-text-group').classList.toggle('hidden', !isText);
      document.getElementById('msg-media-group').classList.toggle('hidden', isText);
    });

    document.getElementById('send-message-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const clientId = document.getElementById('msg-account').value;
      const msgType = document.getElementById('msg-type').value;
      const to = document.getElementById('msg-recipient').value.trim();
      const resultBox = document.getElementById('send-result-box');
      const resultPre = document.getElementById('send-result-pre');

      try {
        let res;
        if (msgType === 'text') {
          const text = document.getElementById('msg-body').value;
          res = await apiRequest('api/messages/send', {
            method: 'POST',
            body: JSON.stringify({ clientId, to, body: { text } }),
          });
        } else {
          const source = document.getElementById('msg-media-source').value.trim();
          const caption = document.getElementById('msg-caption').value.trim();
          const fileInput = document.getElementById('msg-media-file');
          let base64 = null;
          let fileName = null;
          if (fileInput.files && fileInput.files[0]) {
            base64 = await fileToBase64(fileInput.files[0]);
            fileName = fileInput.files[0].name;
          }
          const endpointMap = {
            image: 'api/messages/send-image',
            video: 'api/messages/send-video',
            document: 'api/messages/send-document',
          };
          res = await apiRequest(endpointMap[msgType], {
            method: 'POST',
            body: JSON.stringify({ clientId, to, source, base64, fileName, caption }),
          });
        }

        resultBox.classList.remove('hidden');
        resultPre.textContent = JSON.stringify(res, null, 2);
        showToast('Message submitted!', 'success');
        await loadAllData();
      } catch (err) {
        resultBox.classList.remove('hidden');
        resultPre.textContent = JSON.stringify({ error: err.message }, null, 2);
        showToast(err.message, 'error');
      }
    });

    document.getElementById('toggle-token-btn').addEventListener('click', () => {
      const inp = document.getElementById('diag-api-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('copy-token-btn').addEventListener('click', async () => {
      const val = document.getElementById('diag-api-key').value;
      if (val) {
        await navigator.clipboard.writeText(val);
        showToast('API token copied to clipboard.', 'success');
      }
    });
  }

  function switchTab(tabName) {
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
    const titles = {
      dashboard: 'Lumi Whatsapp – Dashboard',
      accounts: 'Lumi Whatsapp – Accounts & QR Pairing',
      messaging: 'Lumi Whatsapp – Send Message & Media',
      history: 'Lumi Whatsapp – Message History & Receipts',
      diagnostics: 'Lumi Whatsapp – System Diagnostics & Security',
    };
    document.getElementById('page-title').textContent = titles[tabName] || 'Lumi Whatsapp';
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadAllData();
    connectWebSocket();
  });
})();
