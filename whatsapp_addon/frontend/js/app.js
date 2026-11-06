'use strict';

(function () {
  const state = {
    accounts: [],
    messages: [],
    diagnostics: null,
    activeQrClientId: null,
    botConfig: { authorizedNumbers: [], rooms: [], speakers: [] },
    haEntities: [],
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
     HTML ESCAPING HELPER
     Prevents XSS and ReferenceErrors across DOM render functions
     ─────────────────────────────────────────────────────────────────── */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
    }, 3800);
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

    // 1. Try Modern Clipboard API if available in secure context
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
          'Direct access requires an API Bearer token.\nEnter your API Key (from Integration & Setup tab):'
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
    updateDashboardMetrics();

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
      const emptyNote = '<div class="text-muted" style="padding:1rem;text-align:center;">No accounts registered yet. Click <strong>Add Account</strong> to begin pairing.</div>';
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
      <div><strong>E2EE State:</strong> ${acc.sessionHealth || 'healthy'}</div>
      <div><strong>Sent / Recv:</strong> ${acc.stats?.messagesSent || 0} / ${acc.stats?.messagesReceived || 0}</div>
      <div><strong>Last Active:</strong> ${formatTime(acc.lastActiveAt || acc.lastConnectedAt)}</div>
    `;
    div.appendChild(meta);

    if (acc.lastError?.message) {
      const errP = document.createElement('div');
      errP.style.color = '#dc2626';
      errP.style.fontSize = '0.78rem';
      errP.textContent = `Error: ${acc.lastError.message}`;
      div.appendChild(errP);
    }

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

    if (!compact) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => handleDeleteAccount(acc.clientId));
      actions.appendChild(delBtn);
    }

    div.appendChild(actions);
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
      : 'Waiting for phone scan...';
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
     RENDER MESSAGE HISTORY (FULL LOG & DASHBOARD RECENT TABLE)
     ─────────────────────────────────────────────────────────────────── */
  function renderHistoryTable() {
    const filterEl = document.getElementById('history-account-filter');
    const filterClientId = filterEl ? filterEl.value : '';
    const tbody = document.getElementById('history-tbody');
    const dashTbody = document.getElementById('dash-history-tbody');

    const filtered = filterClientId
      ? state.messages.filter((m) => m.clientId === filterClientId)
      : state.messages;

    // 1. Render Full Table
    if (tbody) {
      tbody.innerHTML = '';
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:1.5rem;">No messages recorded yet.</td></tr>';
      } else {
        for (const msg of filtered) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${formatTime(msg.updatedAt || msg.createdAt)}</td>
            <td><strong>${msg.clientId}</strong></td>
            <td>${msg.to}</td>
            <td>${msg.messageType}</td>
            <td class="code-font">${(msg.messageId || '').slice(-12)}</td>
            <td><span class="badge ${msg.status}">${msg.status}</span></td>
          `;
          tbody.appendChild(tr);
        }
      }
    }

    // 2. Render Dashboard Recent Orders Table (Top 5)
    if (dashTbody) {
      dashTbody.innerHTML = '';
      const recent = state.messages.slice(0, 5);
      if (recent.length === 0) {
        dashTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted" style="padding:1.5rem;">No recent messages yet.</td></tr>';
      } else {
        for (const msg of recent) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${formatTime(msg.updatedAt || msg.createdAt)}</td>
            <td><strong>${msg.clientId}</strong></td>
            <td>${msg.to}</td>
            <td><span class="badge ${msg.status}">${msg.status}</span></td>
          `;
          dashTbody.appendChild(tr);
        }
      }
    }
  }

  /* ───────────────────────────────────────────────────────────────────
     RENDER DIAGNOSTICS & SETUP CREDENTIALS
     ─────────────────────────────────────────────────────────────────── */
  function renderDiagnostics() {
    const d = state.diagnostics;
    if (!d) return;

    const apiKeyInput = document.getElementById('diag-api-key');
    const internalUrlInput = document.getElementById('diag-internal-url');
    const altUrlInput = document.getElementById('diag-alt-url');
    const dashUrlPreview = document.getElementById('dash-url-preview');
    const dashTokenStatus = document.getElementById('dash-token-status');

    const apiKey = d.integrationSetup?.apiKey || '';
    const internalUrl = d.integrationSetup?.internalUrl || 'http://127.0.0.1:8653';

    if (apiKeyInput && apiKey) {
      apiKeyInput.value = apiKey;
    }
    if (internalUrlInput) {
      internalUrlInput.value = internalUrl;
    }
    if (altUrlInput) {
      altUrlInput.value =
        (d.integrationSetup?.fallbackUrls && d.integrationSetup.fallbackUrls[0]) ||
        'http://localhost:8653';
    }
    if (dashUrlPreview) {
      dashUrlPreview.textContent = internalUrl;
    }
    if (dashTokenStatus && apiKey) {
      dashTokenStatus.textContent = apiKey.slice(0, 6) + '••••••••';
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
      const [accRes, msgRes, diagRes] = await Promise.allSettled([
        apiRequest('api/accounts'),
        apiRequest('api/messages?limit=150'),
        apiRequest('api/diagnostics'),
      ]);
      if (accRes.status === 'fulfilled') state.accounts = accRes.value?.accounts || [];
      if (msgRes.status === 'fulfilled') state.messages = msgRes.value?.messages || [];
      if (diagRes.status === 'fulfilled') state.diagnostics = diagRes.value;

      renderDashboardAndAccounts();
      renderHistoryTable();
      renderDiagnostics();
    } catch (err) {
      console.warn('Dashboard load error:', err);
    }

    // Always fetch bot config and entities independently
    await Promise.allSettled([loadBotConfig(), loadHaEntities()]);
  }

  /* ───────────────────────────────────────────────────────────────────
     SMART HOME BOT, ROOMS, SPEAKERS & AUTHORIZED NUMBERS
     ─────────────────────────────────────────────────────────────────── */
  async function loadBotConfig() {
    try {
      const res = await apiRequest('api/bot/config');
      state.botConfig = res.config || { authorizedNumbers: [], rooms: [], speakers: [] };
      renderBotConfig();
    } catch (err) {
      console.warn('Could not load bot config:', err.message);
    }
  }

  async function loadHaEntities() {
    try {
      const res = await apiRequest('api/bot/ha-entities');
      state.haEntities = res.entities || [];
      populateEntityDatalists();
    } catch (err) {
      console.warn('Could not load HA entities:', err.message);
    }
  }

  function populateEntityDatalists() {
    const allDatalist = document.getElementById('ha-all-entities-datalist');
    const mediaDatalist = document.getElementById('ha-media-entities-datalist');
    if (allDatalist) allDatalist.innerHTML = '';
    if (mediaDatalist) mediaDatalist.innerHTML = '';

    for (const ent of state.haEntities) {
      if (allDatalist) {
        const opt = document.createElement('option');
        opt.value = ent.entity_id;
        opt.label = `${ent.friendly_name} [${ent.state}]`;
        allDatalist.appendChild(opt);
      }
      if (mediaDatalist && ent.domain === 'media_player') {
        const opt = document.createElement('option');
        opt.value = ent.entity_id;
        opt.label = `${ent.friendly_name} [${ent.state}]`;
        mediaDatalist.appendChild(opt);
      }
    }
  }

  function renderBotConfig() {
    renderRooms();
    renderSpeakers();
    renderAuthorizedNumbers();
    updateDashboardMetrics();

    // Update Backup & Restore live stats
    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };
    setEl('backup-rooms-count', state.botConfig?.rooms?.length || 0);
    setEl('backup-speakers-count', state.botConfig?.speakers?.length || 0);
    setEl('backup-auth-count', state.botConfig?.authorizedNumbers?.length || 0);
  }

  function renderRooms() {
    const container = document.getElementById('bot-rooms-list');
    if (!container) return;
    container.innerHTML = '';

    const rooms = state.botConfig?.rooms || [];
    if (rooms.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 2rem; text-align: center; color: #64748b; background: #f8fafc; border-radius: 8px;">No rooms configured yet. Enter a room name above and click <strong>Add Room</strong> to create your first room.</div>';
      return;
    }

    rooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'room-card';

      const header = document.createElement('div');
      header.className = 'room-header';
      header.innerHTML = `
        <div class="room-title-wrap">
          <span style="font-size: 1.25rem;">🏠</span>
          <h4 class="room-name">${escapeHtml(room.name)}</h4>
          <span class="badge-count">${(room.devices || []).length} devices</span>
        </div>
        <div class="room-actions">
          <button class="btn btn-secondary btn-sm" data-add-dev-room-id="${room.id}" data-room-name="${escapeHtml(room.name)}">
            <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-right: 4px; vertical-align: -2px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Add Device</span>
          </button>
          <button class="btn btn-danger-ghost btn-sm" data-del-room-id="${room.id}" data-room-name="${escapeHtml(room.name)}">
            Delete Room
          </button>
        </div>
      `;
      card.appendChild(header);

      const devTableWrap = document.createElement('div');
      devTableWrap.className = 'table-responsive';

      const devices = room.devices || [];
      if (devices.length === 0) {
        devTableWrap.innerHTML = '<div style="padding: 0.75rem; color: #64748b; font-size: 0.85rem;">No devices assigned to this room yet. Click <strong>Add Device</strong> above.</div>';
      } else {
        const table = document.createElement('table');
        table.className = 'data-table';
        table.style.margin = '0';
        table.innerHTML = `
          <thead>
            <tr>
              <th style="width: 50px;">#</th>
              <th>Device Name</th>
              <th>Type</th>
              <th>Home Assistant Entity</th>
              <th style="text-align: right; width: 100px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${devices.map((d, dIdx) => `
              <tr>
                <td>${dIdx + 1}</td>
                <td><strong>${escapeHtml(d.name)}</strong></td>
                <td><span class="device-badge ${escapeHtml(d.type || 'switch')}">${escapeHtml(d.type || 'switch')}</span></td>
                <td><code>${escapeHtml(d.entityId)}</code></td>
                <td style="text-align: right;">
                  <button class="btn btn-danger-ghost btn-sm" data-del-dev-room-id="${room.id}" data-del-dev-id="${d.id}" data-del-dev-name="${escapeHtml(d.name)}">
                    Remove
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        `;
        devTableWrap.appendChild(table);
      }

      card.appendChild(devTableWrap);
      container.appendChild(card);
    });
  }

  function renderSpeakers() {
    const tbody = document.getElementById('bot-speakers-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const speakers = state.botConfig?.speakers || [];
    if (speakers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="text-align:center; padding:1.5rem; color:#64748b;">No speakers configured yet. Add a Home Assistant media_player above to enable <code>/cast</code>.</td></tr>';
      return;
    }

    speakers.forEach((spk, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(spk.name)}</strong></td>
        <td><code>${escapeHtml(spk.entityId)}</code></td>
        <td style="text-align: right;">
          <button class="btn btn-danger-ghost btn-sm" data-del-spk-id="${spk.id}" data-del-spk-name="${escapeHtml(spk.name)}">
            Remove
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function renderRecentDenied() {
    const container = document.getElementById('recent-denied-container');
    if (!container) return;
    try {
      const res = await apiRequest('api/bot/recent-denied');
      const list = res?.recentDenied || [];
      if (list.length === 0) {
        container.innerHTML = '';
        return;
      }
      container.innerHTML = `
        <div style="background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;">
          <div>
            <strong style="color: #92400e; display: flex; align-items: center; gap: 0.5rem;">
              <span>⚠️</span> Recent WhatsApp Access Request:
            </strong>
            <p style="margin: 0.25rem 0 0; font-size: 0.875rem; color: #b45309;">
              WhatsApp user <code>+${escapeHtml(list[0].id)}</code> ${list[0].senderName ? `(${escapeHtml(list[0].senderName)})` : ''} sent a command but is not authorized yet.
            </p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.quickAuthorize('${escapeHtml(list[0].id)}', '${escapeHtml(list[0].senderName || 'Authorized User')}')" style="background:#f59e0b; border-color:#f59e0b; color:#fff;">
            + Authorize +${escapeHtml(list[0].id)} Now
          </button>
        </div>
      `;
    } catch {
      // Ignore
    }
  }

  window.quickAuthorize = async function(id, name) {
    const phoneInput = document.getElementById('new-auth-phone');
    const nameInput = document.getElementById('new-auth-name');
    if (phoneInput) phoneInput.value = id;
    if (nameInput) nameInput.value = name || 'Authorized User';
    const form = document.getElementById('add-auth-form');
    if (form) {
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  };

  function renderAuthorizedNumbers() {
    renderRecentDenied();
    const tbody = document.getElementById('bot-auth-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const numbers = state.botConfig?.authorizedNumbers || [];
    if (numbers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="text-align:center; padding:1.5rem; color:#64748b;">No authorized numbers configured. Add your phone number above so you can control your smart home via WhatsApp.</td></tr>';
      return;
    }

    numbers.forEach((item) => {
      const tr = document.createElement('tr');
      const dateStr = item.addedAt ? new Date(item.addedAt).toLocaleDateString() : 'N/A';
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.name || 'User')}</strong></td>
        <td><code>+${escapeHtml(item.phone)}</code></td>
        <td>${dateStr}</td>
        <td style="text-align: right;">
          <button class="btn btn-danger-ghost btn-sm" data-del-auth-phone="${escapeHtml(item.phone)}" data-del-auth-name="${escapeHtml(item.name || item.phone)}">
            Revoke
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ───────────────────────────────────────────────────────────────────
     DASHBOARD METRICS & DONUT DISTRIBUTION
     ─────────────────────────────────────────────────────────────────── */
  function updateDashboardMetrics() {
    const rooms = state.botConfig?.rooms || [];
    const speakers = state.botConfig?.speakers || [];

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };

    setEl('kpi-rooms', rooms.length);
    setEl('kpi-speakers', speakers.length);

    // Count device types across all rooms
    let lights = 0;
    let switches = 0;
    let fans = 0;
    let other = 0;

    for (const r of rooms) {
      for (const d of (r.devices || [])) {
        const type = (d.type || '').toLowerCase();
        const ent = (d.entityId || '').toLowerCase();
        if (type === 'light' || ent.startsWith('light.')) {
          lights++;
        } else if (type === 'switch' || ent.startsWith('switch.')) {
          switches++;
        } else if (type === 'fan' || type === 'climate' || ent.startsWith('fan.') || ent.startsWith('climate.')) {
          fans++;
        } else {
          other++;
        }
      }
    }
    const speakerCount = speakers.length;
    const totalDevices = lights + switches + fans + other + speakerCount;
    const roomDevicesCount = lights + switches + fans + other;
    const authCount = state.botConfig?.authorizedNumbers?.length || 0;

    // Update Google Material Automation Hub dynamic indicators
    setEl('hub-rooms-count', rooms.length);
    setEl('hub-devices-count', roomDevicesCount);
    setEl('hub-speakers-count', speakers.length);
    setEl('hub-auth-count', authCount);

    const setLegend = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    if (totalDevices === 0) {
      setEl('donut-total-count', '0');
      const label = document.querySelector('.donut-total-label');
      if (label) label.textContent = 'Devices';
      setLegend('legend-count-lights', '0% (0)');
      setLegend('legend-count-switches', '0% (0)');
      setLegend('legend-count-fans', '0% (0)');
      setLegend('legend-count-speakers', '0% (0)');
      return;
    }

    setEl('donut-total-count', String(totalDevices));
    const label = document.querySelector('.donut-total-label');
    if (label) label.textContent = totalDevices === 1 ? 'Device' : 'Devices';

    const pctLights = Math.round((lights / totalDevices) * 100);
    const pctSwitches = Math.round((switches / totalDevices) * 100);
    const pctFans = Math.round((fans / totalDevices) * 100);
    const pctSpeakers = Math.max(0, 100 - pctLights - pctSwitches - pctFans);

    setLegend('legend-count-lights', `${pctLights}% (${lights})`);
    setLegend('legend-count-switches', `${pctSwitches}% (${switches})`);
    setLegend('legend-count-fans', `${pctFans}% (${fans})`);
    setLegend('legend-count-speakers', `${pctSpeakers}% (${speakerCount})`);

    // SVG Circumference C = 2 * PI * 45 = 282.743
    const C = 282.74;
    const arcLights = (pctLights / 100) * C;
    const arcSwitches = (pctSwitches / 100) * C;
    const arcFans = (pctFans / 100) * C;
    const arcSpeakers = (pctSpeakers / 100) * C;

    const segL = document.getElementById('donut-seg-lights');
    const segS = document.getElementById('donut-seg-switches');
    const segF = document.getElementById('donut-seg-fans');
    const segSpk = document.getElementById('donut-seg-speakers');

    if (segL) {
      segL.setAttribute('stroke-dasharray', `${arcLights.toFixed(1)} ${(C - arcLights).toFixed(1)}`);
      segL.setAttribute('stroke-dashoffset', '0');
    }
    if (segS) {
      segS.setAttribute('stroke-dasharray', `${arcSwitches.toFixed(1)} ${(C - arcSwitches).toFixed(1)}`);
      segS.setAttribute('stroke-dashoffset', `-${arcLights.toFixed(1)}`);
    }
    if (segF) {
      segF.setAttribute('stroke-dasharray', `${arcFans.toFixed(1)} ${(C - arcFans).toFixed(1)}`);
      segF.setAttribute('stroke-dashoffset', `-${(arcLights + arcSwitches).toFixed(1)}`);
    }
    if (segSpk) {
      segSpk.setAttribute('stroke-dasharray', `${arcSpeakers.toFixed(1)} ${(C - arcSpeakers).toFixed(1)}`);
      segSpk.setAttribute('stroke-dashoffset', `-${(arcLights + arcSwitches + arcFans).toFixed(1)}`);
    }
  }

  function filterDashboardAndRooms(query) {
    const q = (query || '').toLowerCase().trim();

    // 1. Filter room cards
    const roomCards = document.querySelectorAll('#bot-rooms-list .room-card');
    roomCards.forEach((card) => {
      if (!q) {
        card.style.display = '';
      } else {
        const text = (card.textContent || '').toLowerCase();
        card.style.display = text.includes(q) ? '' : 'none';
      }
    });

    // 2. Filter accounts in dashboard and accounts tab
    const accCards = document.querySelectorAll('.account-card');
    accCards.forEach((card) => {
      if (!q) {
        card.style.display = '';
      } else {
        const text = (card.textContent || '').toLowerCase();
        card.style.display = text.includes(q) ? '' : 'none';
      }
    });

    // 3. Filter speakers rows
    const speakerRows = document.querySelectorAll('#bot-speakers-tbody tr');
    speakerRows.forEach((row) => {
      if (!q) {
        row.style.display = '';
      } else {
        const text = (row.textContent || '').toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
      }
    });

    // 4. Filter authorized numbers rows
    const authRows = document.querySelectorAll('#bot-auth-tbody tr');
    authRows.forEach((row) => {
      if (!q) {
        row.style.display = '';
      } else {
        const text = (row.textContent || '').toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
      }
    });
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
    const pillDot = document.getElementById('ws-pill-dot');
    const pillLabel = document.getElementById('ws-pill-label');

    const updateWsUi = (connected, mainText, pillText) => {
      const cls = connected ? 'status-dot connected' : 'status-dot disconnected';
      if (dot) dot.className = cls;
      if (pillDot) pillDot.className = cls;
      if (label) label.textContent = mainText;
      if (pillLabel) pillLabel.textContent = pillText;
    };

    ws.onopen = () => {
      updateWsUi(true, 'Live stream active', 'Live Stream');
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
      updateWsUi(false, 'Reconnecting...', 'Reconnecting');
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
      dashboard: 'Dashboard',
      accounts: 'Accounts & QR Pairing',
      messaging: 'Send Messages & Media',
      history: 'Message Audit Log',
      remote: 'Smart Home Remote Control Builder',
      speakers: 'Speakers & Audio Broadcasting',
      authorized: 'Authorized WhatsApp Numbers',
      backup: 'Backup & Restore Configuration',
      diagnostics: 'Integration & Setup Credentials',
    };
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = titles[tabName] || 'Dashboard';
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
       COPY BUTTON HANDLERS (DASHBOARD & DIAGNOSTICS)
       ─────────────────────────────────────────────────────────────────── */
    // Diagnostics tab - toggle token show / hide
    const toggleTokenBtn = document.getElementById('toggle-token-btn');
    if (toggleTokenBtn) {
      toggleTokenBtn.addEventListener('click', () => {
        const inp = document.getElementById('diag-api-key');
        if (!inp) return;
        const isPassword = inp.type === 'password';
        inp.type = isPassword ? 'text' : 'password';
        toggleTokenBtn.textContent = isPassword ? 'Hide' : 'Show';
      });
    }

    // Diagnostics tab - Copy Token
    const copyTokenBtn = document.getElementById('copy-token-btn');
    if (copyTokenBtn) {
      copyTokenBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-api-key')?.value || '';
        copyToClipboard(val, copyTokenBtn);
      });
    }

    // Diagnostics tab - Copy URL
    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        copyToClipboard(val, copyUrlBtn);
      });
    }

    // Diagnostics tab - Copy Alt URL
    const copyAltUrlBtn = document.getElementById('copy-alt-url-btn');
    if (copyAltUrlBtn) {
      copyAltUrlBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-alt-url')?.value || 'http://localhost:8653';
        copyToClipboard(val, copyAltUrlBtn);
      });
    }

    // Diagnostics tab - Copy All
    const copyAllBtn = document.getElementById('copy-all-btn');
    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', () => {
        const url = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        const key = document.getElementById('diag-api-key')?.value || '';
        const combined = `URL: ${url}\nAPI_KEY: ${key}`;
        copyToClipboard(combined, copyAllBtn);
      });
    }

    // Dashboard card - Copy URL
    const dashCopyUrlBtn = document.getElementById('dash-copy-url-btn');
    if (dashCopyUrlBtn) {
      dashCopyUrlBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        copyToClipboard(val, dashCopyUrlBtn);
      });
    }

    // Dashboard card - Copy Token
    const dashCopyTokenBtn = document.getElementById('dash-copy-token-btn');
    if (dashCopyTokenBtn) {
      dashCopyTokenBtn.addEventListener('click', () => {
        const val = document.getElementById('diag-api-key')?.value || '';
        copyToClipboard(val, dashCopyTokenBtn);
      });
    }

    // Dashboard card - Copy All
    const dashCopyAllBtn = document.getElementById('dash-copy-all-btn');
    if (dashCopyAllBtn) {
      dashCopyAllBtn.addEventListener('click', () => {
        const url = document.getElementById('diag-internal-url')?.value || 'http://127.0.0.1:8653';
        const key = document.getElementById('diag-api-key')?.value || '';
        const combined = `URL: ${url}\nAPI_KEY: ${key}`;
        copyToClipboard(combined, dashCopyAllBtn);
      });
    }

    /* ───────────────────────────────────────────────────────────────────
       BOT BUILDER, ROOMS, SPEAKERS & AUTHORIZED NUMBER HANDLERS
       ─────────────────────────────────────────────────────────────────── */
    // Add Room form submission
    const addRoomForm = document.getElementById('add-room-form');
    if (addRoomForm) {
      addRoomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const roomInput = document.getElementById('new-room-name');
        const name = roomInput?.value.trim();
        if (!name) {
          showToast('Please enter a room name.', 'error');
          roomInput?.focus();
          return;
        }
        try {
          const res = await apiRequest('api/bot/rooms', {
            method: 'POST',
            body: JSON.stringify({ name }),
          });
          showToast(`Room "${name}" created!`, 'success');
          if (roomInput) roomInput.value = '';
          if (res?.config) {
            state.botConfig = res.config;
            renderBotConfig();
          } else {
            await loadBotConfig();
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    // Room actions (Delete Room, Open Add Device Modal, Delete Device)
    const roomsList = document.getElementById('bot-rooms-list');
    if (roomsList) {
      roomsList.addEventListener('click', async (e) => {
        const delRoomBtn = e.target.closest('[data-del-room-id]');
        if (delRoomBtn) {
          const roomId = delRoomBtn.getAttribute('data-del-room-id');
          const roomName = delRoomBtn.getAttribute('data-room-name');
          if (confirm(`Are you sure you want to delete room "${roomName}" and all its devices?`)) {
            try {
              await apiRequest(`api/bot/rooms/${roomId}`, { method: 'DELETE' });
              showToast(`Room "${roomName}" removed.`, 'info');
              await loadBotConfig();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
          return;
        }

        const addDevBtn = e.target.closest('[data-add-dev-room-id]');
        if (addDevBtn) {
          const roomId = addDevBtn.getAttribute('data-add-dev-room-id');
          const roomName = addDevBtn.getAttribute('data-room-name');
          const modal = document.getElementById('add-device-modal');
          const title = document.getElementById('modal-room-title');
          const idInput = document.getElementById('modal-room-id');
          if (modal && title && idInput) {
            title.textContent = `Add Device to ${roomName}`;
            idInput.value = roomId;
            modal.classList.remove('hidden');
            document.getElementById('modal-dev-name')?.focus();
          }
          return;
        }

        const delDevBtn = e.target.closest('[data-del-dev-id]');
        if (delDevBtn) {
          const roomId = delDevBtn.getAttribute('data-del-dev-room-id');
          const devId = delDevBtn.getAttribute('data-del-dev-id');
          const devName = delDevBtn.getAttribute('data-del-dev-name');
          if (confirm(`Are you sure you want to remove device "${devName}"?`)) {
            try {
              await apiRequest(`api/bot/rooms/${roomId}/devices/${devId}`, { method: 'DELETE' });
              showToast(`Device "${devName}" removed.`, 'info');
              await loadBotConfig();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
          return;
        }
      });
    }

    // Device Modal controls
    const devModal = document.getElementById('add-device-modal');
    const closeDevModalBtn = document.getElementById('close-device-modal-btn');
    const cancelDevModalBtn = document.getElementById('cancel-device-modal-btn');
    const saveDevModalBtn = document.getElementById('save-device-modal-btn');

    const hideDevModal = () => {
      if (devModal) devModal.classList.add('hidden');
      const nameInput = document.getElementById('modal-dev-name');
      const entityInput = document.getElementById('modal-dev-entity');
      if (nameInput) nameInput.value = '';
      if (entityInput) entityInput.value = '';
    };

    if (closeDevModalBtn) closeDevModalBtn.addEventListener('click', hideDevModal);
    if (cancelDevModalBtn) cancelDevModalBtn.addEventListener('click', hideDevModal);

    if (saveDevModalBtn) {
      saveDevModalBtn.addEventListener('click', async () => {
        const roomId = document.getElementById('modal-room-id')?.value;
        const name = document.getElementById('modal-dev-name')?.value.trim();
        const type = document.getElementById('modal-dev-type')?.value || 'switch';
        const entityId = document.getElementById('modal-dev-entity')?.value.trim();

        if (!name || !entityId) {
          showToast('Device name and Home Assistant entity ID are required.', 'error');
          return;
        }

        try {
          await apiRequest(`api/bot/rooms/${roomId}/devices`, {
            method: 'POST',
            body: JSON.stringify({ name, type, entityId }),
          });
          showToast(`Device "${name}" added!`, 'success');
          hideDevModal();
          await loadBotConfig();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    // Speakers Add form
    const addSpkForm = document.getElementById('add-speaker-form');
    if (addSpkForm) {
      addSpkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('new-speaker-name');
        const entInput = document.getElementById('new-speaker-entity');
        const name = nameInput?.value.trim();
        const entityId = entInput?.value.trim();

        if (!name || !entityId) {
          showToast('Speaker name and media_player entity ID are required.', 'error');
          return;
        }

        try {
          const res = await apiRequest('api/bot/speakers', {
            method: 'POST',
            body: JSON.stringify({ name, entityId }),
          });
          showToast(`Speaker "${name}" added!`, 'success');
          if (nameInput) nameInput.value = '';
          if (entInput) entInput.value = '';
          if (res?.config) {
            state.botConfig = res.config;
            renderBotConfig();
          } else {
            await loadBotConfig();
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    const spkTable = document.getElementById('bot-speakers-tbody');
    if (spkTable) {
      spkTable.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-del-spk-id]');
        if (delBtn) {
          const spkId = delBtn.getAttribute('data-del-spk-id');
          const spkName = delBtn.getAttribute('data-del-spk-name');
          if (confirm(`Are you sure you want to remove speaker "${spkName}" from the broadcast list?`)) {
            try {
              await apiRequest(`api/bot/speakers/${spkId}`, { method: 'DELETE' });
              showToast(`Speaker "${spkName}" removed.`, 'info');
              await loadBotConfig();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      });
    }

    // Authorized Numbers Add form
    const addAuthForm = document.getElementById('add-auth-form');
    if (addAuthForm) {
      addAuthForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phoneInput = document.getElementById('new-auth-phone');
        const nameInput = document.getElementById('new-auth-name');
        const rawPhone = phoneInput?.value.trim();
        const name = nameInput?.value.trim() || 'Family Member';

        const cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
        if (!cleanPhone || cleanPhone.length < 7 || cleanPhone.length > 18) {
          showToast('Please enter a valid numeric phone number or WhatsApp ID (7-18 digits).', 'error');
          phoneInput?.focus();
          return;
        }

        try {
          const res = await apiRequest('api/bot/authorized-numbers', {
            method: 'POST',
            body: JSON.stringify({ phone: cleanPhone, name }),
          });
          showToast(`Number +${cleanPhone} authorized!`, 'success');
          if (phoneInput) phoneInput.value = '';
          if (nameInput) nameInput.value = '';
          if (res?.config) {
            state.botConfig = res.config;
            renderBotConfig();
          } else {
            await loadBotConfig();
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    const authTable = document.getElementById('bot-auth-tbody');
    if (authTable) {
      authTable.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-del-auth-phone]');
        if (delBtn) {
          const phone = delBtn.getAttribute('data-del-auth-phone');
          const name = delBtn.getAttribute('data-del-auth-name');
          if (confirm(`Are you sure you want to revoke access for "${name}" (+${phone})? They will no longer be able to control devices.`)) {
            try {
              await apiRequest(`api/bot/authorized-numbers/${phone}`, { method: 'DELETE' });
              showToast(`Access revoked for +${phone}.`, 'info');
              await loadBotConfig();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        }
      });
    }

    // WebSocket indicator button click
    const wsPillBtn = document.getElementById('ws-indicator-pill');
    if (wsPillBtn) {
      wsPillBtn.addEventListener('click', () => {
        const isConnected = state.ws && state.ws.readyState === WebSocket.OPEN;
        if (isConnected) {
          showToast('WebSocket Live Stream is connected and healthy.', 'success');
        } else {
          showToast('WebSocket reconnecting to Home Assistant Ingress...', 'info');
          connectWebSocket();
        }
      });
    }

    // ───────────────────────────────────────────────────────────────────
    // DEDICATED BACKUP & RESTORE HANDLERS
    // ───────────────────────────────────────────────────────────────────
    function triggerConfigExport() {
      const fullConfig = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        authorizedNumbers: state.botConfig?.authorizedNumbers || [],
        rooms: state.botConfig?.rooms || [],
        speakers: state.botConfig?.speakers || [],
      };
      const jsonStr = JSON.stringify(fullConfig, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lumi_whatsapp_full_backup_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Full configuration exported as JSON.', 'success');
    }

    const handleBackupFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const result = await apiRequest('api/bot/import', {
            method: 'POST',
            body: JSON.stringify(parsed),
          });
          showToast(
            `Restored! Imported ${result.roomsCount || 0} rooms, ${result.speakersCount || 0} speakers, and ${result.authorizedCount || 0} authorized numbers.`,
            'success'
          );
          if (result.config) {
            state.botConfig = result.config;
            renderBotConfig();
          } else {
            await loadBotConfig();
          }
        } catch (err) {
          showToast(`Restore failed: ${err.message}`, 'error');
        }
      };
      reader.readAsText(file);
    };

    const exportFullBtn = document.getElementById('export-full-btn');
    if (exportFullBtn) exportFullBtn.addEventListener('click', triggerConfigExport);

    const importTriggerBtn = document.getElementById('import-trigger-btn');
    const backupDropZone = document.getElementById('backup-drop-zone');
    const backupFileInput = document.getElementById('backup-file-input');
    const botFileInput = document.getElementById('bot-file-input');

    if (importTriggerBtn && backupFileInput) {
      importTriggerBtn.addEventListener('click', () => {
        backupFileInput.value = '';
        backupFileInput.click();
      });
    }

    if (backupDropZone && backupFileInput) {
      backupDropZone.addEventListener('click', (e) => {
        if (e.target !== backupFileInput) {
          backupFileInput.value = '';
          backupFileInput.click();
        }
      });
    }

    if (backupFileInput) {
      backupFileInput.addEventListener('change', (e) => {
        handleBackupFile(e.target.files?.[0]);
      });
    }

    if (botFileInput) {
      botFileInput.addEventListener('change', (e) => {
        handleBackupFile(e.target.files?.[0]);
      });
    }

    // ───────────────────────────────────────────────────────────────────
    // LOAD SAMPLE / DEMO CONFIGURATION HANDLER
    // ───────────────────────────────────────────────────────────────────
    const handleLoadDemo = async () => {
      if (confirm('Load sample smart home setup? This will populate sample rooms (Living Room, Master Bedroom), devices (Lights, Fans, AC), demo speakers, and an authorized phone number for testing.')) {
        try {
          const res = await apiRequest('api/bot/demo', { method: 'POST' });
          if (res?.config) {
            state.botConfig = res.config;
            renderBotConfig();
            showToast('Demo configuration loaded successfully!', 'success');
          } else {
            await loadBotConfig();
          }
        } catch (err) {
          showToast(`Could not load demo setup: ${err.message}`, 'error');
        }
      }
    };

    const loadDemoBtn = document.getElementById('load-demo-btn');
    if (loadDemoBtn) loadDemoBtn.addEventListener('click', handleLoadDemo);

    const backupLoadDemoBtn = document.getElementById('backup-load-demo-btn');
    if (backupLoadDemoBtn) backupLoadDemoBtn.addEventListener('click', handleLoadDemo);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadAllData();
    connectWebSocket();
  });
})();
