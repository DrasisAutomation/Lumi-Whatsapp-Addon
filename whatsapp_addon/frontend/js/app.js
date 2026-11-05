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

  /* ───────────────────────────────────────────────────────────────────
     INGRESS URL NORMALIZATION
     ─────────────────────────────────────────────────────────────────── */
  function getIngressBasePath() {
    const baseEl = document.querySelector('base');
    if (baseEl && baseEl.getAttribute('href')) {
      const h = baseEl.getAttribute('href');
      if (h && h !== './' && h !== '/') {
        return h.endsWith('/') ? h : `${h}/`;
      }
    }
    let p = window.location.pathname || '/';
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

  /* ───────────────────────────────────────────────────────────────────
     TOAST NOTIFICATIONS
     ─────────────────────────────────────────────────────────────────── */
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  /* ───────────────────────────────────────────────────────────────────
     BULLETPROOF COPY TO CLIPBOARD
     Works in Home Assistant Ingress iframes, non-HTTPS contexts, mobile
     HA Companion App, Safari, Chrome, and Firefox.
     ─────────────────────────────────────────────────────────────────── */
  async function copyToClipboard(text, btn = null) {
    if (!text) {
      showToast('Nothing to copy.', 'error');
      return false;
    }
    let copied = false;

    // 1. Try Modern Clipboard API if available and document is focused in secure context
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (err) {
        console.warn('navigator.clipboard failed, attempting execCommand fallback:', err);
      }
    }

    // 2. Fallback to hidden textarea with execCommand('copy')
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, 99999);
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (err) {
        console.error('execCommand copy failed:', err);
      }
    }

    if (copied) {
      if (btn) {
        const originalContent = btn.innerHTML;
        btn.classList.add('btn-copied');
        btn.innerHTML = '<span>✓ Copied!</span>';
        setTimeout(() => {
          btn.innerHTML = originalContent;
          btn.classList.remove('btn-copied');
        }, 2200);
      }
      showToast('Copied to clipboard!', 'success');
      return true;
    } else {
      // 3. Last-resort user prompt
      window.prompt('Copy to clipboard (Ctrl+C / Cmd+C):', text);
      return false;
    }
  }

  /* ───────────────────────────────────────────────────────────────────
     API REQUEST HELPER
     ─────────────────────────────────────────────────────────────────── */
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
        const entered = prompt(
          'Direct access requires an API Bearer token.\nEnter your API Key (from Diagnostics / Setup tab):'
        );
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

  /* ───────────────────────────────────────────────────────────────────
     RENDER DASHBOARD & ACCOUNTS
     ─────────────────────────────────────────────────────────────────── */
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

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };

    setEl('kpi-connected', connected);
    setEl('kpi-disconnected', disconnected);
    setEl('kpi-sent', sent);
    setEl('kpi-received', received);
    setEl('kpi-pending', pending);
    setEl('kpi-failed', failed);

    if (state.diagnostics?.health?.uptimeSeconds !== undefined) {
      setEl('kpi-uptime', formatDuration(state.diagnostics.health.uptimeSeconds));
    }

    const dashContainer = document.getElementById('dashboard-accounts-list');
    const accContainer = document.getElementById('accounts-container');
    if (dashContainer) dashContainer.innerHTML = '';
    if (accContainer) accContainer.innerHTML = '';

    const msgSelect = document.getElementById('msg-account');
    const histFilter = document.getElementById('history-account-filter');
    const prevMsgAccount = msgSelect ? msgSelect.value : null;
    const prevHistFilter = histFilter ? histFilter.value : null;

    if (msgSelect) msgSelect.innerHTML = '';
    if (histFilter) histFilter.innerHTML = '<option value="">All Accounts</option>';

    if (accounts.length === 0) {
      const emptyNote = '<div class="muted" style="padding:1rem;">No accounts configured yet. Click "+ Add Account" to pair your first WhatsApp session.</div>';
      if (dashContainer) dashContainer.innerHTML = emptyNote;
      if (accContainer) accContainer.innerHTML = emptyNote;
      return;
    }

    for (const acc of accounts) {
      if (msgSelect) {
        const opt1 = document.createElement('option');
        opt1.value = acc.clientId;
        opt1.textContent = `${acc.name} (${acc.clientId}) - ${acc.status}`;
        msgSelect.appendChild(opt1);
      }

      if (histFilter) {
        const opt2 = document.createElement('option');
        opt2.value = acc.clientId;
        opt2.textContent = `${acc.name} (${acc.clientId})`;
        histFilter.appendChild(opt2);
      }

      if (accContainer) accContainer.appendChild(buildAccountCard(acc, false));
      if (dashContainer) dashContainer.appendChild(buildAccountCard(acc, true));
    }

    if (msgSelect && prevMsgAccount) msgSelect.value = prevMsgAccount;
    if (histFilter && prevHistFilter) histFilter.value = prevHistFilter;
  }

  function buildAccountCard(acc, compact = false) {
    const div = document.createElement('div');
    div.className = 'account-card';

    const header = document.createElement('div');
    header.className = 'account-header';

    const titleBox = document.createElement('div');
    const h4 = document.createElement('h4');
    h4.textContent = acc.name || acc.clientId;
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
      <div><strong>Phone:</strong> ${acc.phone ? '+' + acc.phone : 'Not linked'}</div>
      <div><strong>E2EE Health:</strong> ${acc.sessionHealth || 'healthy'}</div>
      <div><strong>Sent / Recv:</strong> ${acc.stats?.messagesSent || 0} / ${acc.stats?.messagesReceived || 0}</div>
      <div><strong>Last Active:</strong> ${formatTime(acc.lastActiveAt || acc.lastConnectedAt)}</div>
    `;
    div.appendChild(meta);

    if (acc.lastError?.message) {
      const errP = document.createElement('div');
      errP.style.color = '#ef4444';
      errP.style.fontSize = '0.78rem';
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
      // Ignore transient errors during poll
    }
  }

  function showQrModal(clientId, qrDataUrl, expiresAt) {
    const modal = document.getElementById('qr-pairing-modal');
    if (!modal) return;
    document.getElementById('qr-title').textContent = `Scan QR Code for Account: ${clientId}`;
    document.getElementById('qr-image').src = qrDataUrl;
    document.getElementById('qr-status-text').textContent = expiresAt
      ? `QR active (refreshes at ${new Date(expiresAt).toLocaleTimeString()})`
      : 'Waiting for scan...';
    modal.classList.remove('hidden');
    switchTab('accounts');
  }

  function hideQrModal() {
    const modal = document.getElementById('qr-pairing-modal');
    if (modal) modal.classList.add('hidden');
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
      `Are you sure you want to permanently delete account "${clientId}" and its credentials?`
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

  /* ───────────────────────────────────────────────────────────────────
     RENDER MESSAGE HISTORY
     ─────────────────────────────────────────────────────────────────── */
  function renderHistoryTable() {
    const filterEl = document.getElementById('history-account-filter');
    const filterClientId = filterEl ? filterEl.value : '';
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const filtered = filterClientId
      ? state.messages.filter((m) => m.clientId === filterClientId)
      : state.messages;

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="muted" style="text-align:center;padding:1.5rem;">No messages recorded yet.</td>';
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
      tdId.textContent = (msg.messageId || '').slice(-12);
      tdId.className = 'code-font';

      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${msg.status}`;
      badge.textContent = msg.status;
      tdStatus.appendChild(badge);

      tr.append(tdTime, tdAcc, tdTo, tdType, tdId, tdStatus);
      tbody.appendChild(tr);
    }
  }

  /* ───────────────────────────────────────────────────────────────────
     RENDER DIAGNOSTICS & INTEGRATION SETUP (ZOHO CLASSIC CREDENTIALS)
     ─────────────────────────────────────────────────────────────────── */
  function renderDiagnostics() {
    const d = state.diagnostics;
    if (!d) return;

    const apiKeyInput = document.getElementById('diag-api-key');
    const internalUrlInput = document.getElementById('diag-internal-url');
    const altUrlInput = document.getElementById('diag-alt-url');

    if (d.integrationSetup?.apiKey && apiKeyInput) {
      apiKeyInput.value = d.integrationSetup.apiKey;
    }
    if (internalUrlInput) {
      internalUrlInput.value = d.integrationSetup?.internalUrl || 'http://127.0.0.1:8653';
    }
    if (altUrlInput) {
      altUrlInput.value =
        (d.integrationSetup?.fallbackUrls && d.integrationSetup.fallbackUrls[0]) ||
        'http://localhost:8653';
    }

    const setPre = (id, obj) => {
      const el = document.getElementById(id);
      if (el) el.textContent = JSON.stringify(obj, null, 2);
    };

    setPre('diag-runtime-pre', { health: d.health, runtime: d.runtime });
    setPre('diag-sessions-pre', { sessions: d.sessions, queue: d.queue });
    setPre('diag-conn-errors-pre', {
      connectionErrors: d.connectionErrors,
      authErrors: d.authErrors,
    });
    setPre('diag-media-errors-pre', {
      mediaUploadFailures: d.mediaUploadFailures,
      retryAttempts: d.retryAttempts,
    });
  }

  /* ───────────────────────────────────────────────────────────────────
     DATA LOADER
     ─────────────────────────────────────────────────────────────────── */
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
      showToast(`Failed to load data: ${err.message}`, 'error');
    }
  }

  /* ───────────────────────────────────────────────────────────────────
     LIVE WEBSOCKET STREAM
     ─────────────────────────────────────────────────────────────────── */
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
      if (dot) dot.className = 'status-dot connected';
      if (label) label.textContent = 'Live stream active';
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'qr_update' && msg.payload) {
          if (!state.activeQrClientId || state.activeQrClientId === msg.payload.clientId) {
            state.activeQrClientId = msg.payload.clientId;
            showQrModal(msg.payload.clientId, msg.payload.qrDataUrl, msg.payload.expiresAt);
          }
        } else if (msg.type === 'connection_update') {
          if (msg.payload?.status === 'connected') {
            hideQrModal();
            showToast(`Account "${msg.payload.clientId}" linked successfully!`, 'success');
          }
          loadAllData();
        } else if (
          msg.type === 'message_received' ||
          msg.type === 'message_status' ||
          msg.type === 'message_sent'
        ) {
          loadAllData();
        }
      } catch {
        // Ignore unparseable frames
      }
    };

    ws.onclose = () => {
      if (dot) dot.className = 'status-dot disconnected';
      if (label) label.textContent = 'Live stream reconnecting...';
      setTimeout(connectWebSocket, 4000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const str = String(reader.result);
        const commaIdx = str.indexOf(',');
        resolve(commaIdx >= 0 ? str.slice(commaIdx + 1) : str);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ───────────────────────────────────────────────────────────────────
     EVENT BINDINGS & TAB SWITCHER
     ─────────────────────────────────────────────────────────────────── */
  function switchTab(tabName) {
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
    const titles = {
      dashboard: 'Executive Dashboard',
      accounts: 'Accounts & QR Pairing',
      messaging: 'Send Messages & Media',
      history: 'Message Audit Log & Receipts',
      diagnostics: 'HA Integration Credentials & Diagnostics',
    };
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = titles[tabName] || 'Lumi Whatsapp';
  }

  function bindEvents() {
    // Navigation tabs
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Jump buttons (data-goto-tab)
    document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-goto-tab')));
    });

    // Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('loading');
        await loadAllData();
        refreshBtn.classList.remove('loading');
        showToast('Data refreshed.', 'info');
      });
    }

    // Close QR modal
    const closeQrBtn = document.getElementById('close-qr-btn');
    if (closeQrBtn) closeQrBtn.addEventListener('click', hideQrModal);

    // Add Account form
    const addAccForm = document.getElementById('add-account-form');
    if (addAccForm) {
      addAccForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const clientId = document.getElementById('new-client-id').value.trim();
        const name = document.getElementById('new-account-name').value.trim() || clientId;
        try {
          await apiRequest('api/accounts', {
            method: 'POST',
            body: JSON.stringify({ clientId, name }),
          });
          showToast(`Account "${clientId}" added!`, 'success');
          document.getElementById('new-client-id').value = '';
          document.getElementById('new-account-name').value = '';
          await handleConnectAccount(clientId, false);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    // Message Type toggle (text vs media inputs)
    const msgTypeSelect = document.getElementById('msg-type');
    if (msgTypeSelect) {
      msgTypeSelect.addEventListener('change', () => {
        const isText = msgTypeSelect.value === 'text';
        const textGroup = document.getElementById('msg-text-group');
        const mediaGroup = document.getElementById('msg-media-group');
        if (textGroup) textGroup.classList.toggle('hidden', !isText);
        if (mediaGroup) mediaGroup.classList.toggle('hidden', isText);
      });
    }

    // History filter change
    const histFilter = document.getElementById('history-account-filter');
    if (histFilter) histFilter.addEventListener('change', renderHistoryTable);

    // Send Message form
    const sendForm = document.getElementById('send-message-form');
    if (sendForm) {
      sendForm.addEventListener('submit', async (e) => {
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

          if (resultBox) resultBox.classList.remove('hidden');
          if (resultPre) resultPre.textContent = JSON.stringify(res, null, 2);
          showToast('Message sent to WhatsApp network!', 'success');
          await loadAllData();
        } catch (err) {
          if (resultBox) resultBox.classList.remove('hidden');
          if (resultPre) resultPre.textContent = JSON.stringify({ error: err.message }, null, 2);
          showToast(err.message, 'error');
        }
      });
    }

    /* ───────────────────────────────────────────────────────────────────
       BULLETPROOF CLIPBOARD COPY BUTTON HANDLERS
       ─────────────────────────────────────────────────────────────────── */
    // Toggle token show / hide
    const toggleTokenBtn = document.getElementById('toggle-token-btn');
    if (toggleTokenBtn) {
      toggleTokenBtn.addEventListener('click', () => {
        const inp = document.getElementById('diag-api-key');
        if (!inp) return;
        const isPassword = inp.type === 'password';
        inp.type = isPassword ? 'text' : 'password';
        toggleTokenBtn.querySelector('span').textContent = isPassword ? 'Hide' : 'Show';
      });
    }

    // Copy API Token Button
    const copyTokenBtn = document.getElementById('copy-token-btn');
    if (copyTokenBtn) {
      copyTokenBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-api-key')?.value || '';
        copyToClipboard(val, copyTokenBtn);
      });
    }

    // Copy Primary URL Button
    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        copyToClipboard(val, copyUrlBtn);
      });
    }

    // Copy Alternative URL Button
    const copyAltUrlBtn = document.getElementById('copy-alt-url-btn');
    if (copyAltUrlBtn) {
      copyAltUrlBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-alt-url')?.value || 'http://localhost:8653';
        copyToClipboard(val, copyAltUrlBtn);
      });
    }

    // Copy All Setup Info
    const copyAllBtn = document.getElementById('copy-all-btn');
    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', () => {
        const url = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        const key = document.getElementById('diag-api-key')?.value || '';
        const combined = `URL: ${url}\nAPI_KEY: ${key}`;
        copyToClipboard(combined, copyAllBtn);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadAllData();
    connectWebSocket();
  });
})();
