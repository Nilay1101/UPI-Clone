/* UPI-Clone web front-end. Vanilla JS, talks to the same-origin API. */

const state = {
  user: null, // { upiId, name, balanceRupees }
  scanner: null, // Html5Qrcode instance when the camera is running
};

/* ---------------- API helper ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------- UI helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function show(screenId) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== screenId));
  // Stop the camera whenever we leave the pay screen.
  if (screenId !== 'screen-pay') stopScanner();
  if (screenId === 'screen-history') loadHistory();
  if (screenId === 'screen-request') loadRequests();
}

const rupees = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------------- Session ---------------- */
function saveSession(upiId) {
  localStorage.setItem('upi_current', upiId);
}
function clearSession() {
  localStorage.removeItem('upi_current');
}

async function loadUser(upiId) {
  const user = await api(`/users/${encodeURIComponent(upiId)}`);
  state.user = user;
  saveSession(user.upiId);
  renderHome();
  show('screen-home');
}

function renderHome() {
  if (!state.user) return;
  $('#home-name').textContent = state.user.name;
  $('#home-upiid').textContent = state.user.upiId;
  $('#home-bank').textContent = `${state.user.bankName} · ${state.user.accountMasked}`;
  $('#home-balance').textContent = rupees(state.user.balanceRupees);
  refreshRequestBadge();
}

// Show a red badge on the Request tile with the count of pending incoming requests.
async function refreshRequestBadge() {
  if (!state.user) return;
  const badge = $('#req-badge');
  try {
    const { incoming } = await api(`/users/${encodeURIComponent(state.user.upiId)}/requests`);
    const pending = incoming.filter((r) => r.status === 'PENDING').length;
    badge.textContent = pending;
    badge.hidden = pending === 0;
  } catch {
    badge.hidden = true;
  }
}

async function refreshBalance() {
  if (!state.user) return;
  const user = await api(`/users/${encodeURIComponent(state.user.upiId)}`);
  state.user = user;
  renderHome();
}

/* ---------------- Onboarding (phone → pick bank account) ---------------- */
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');

$('#form-phone').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = new FormData(e.target).get('phone').trim();
  try {
    const { accounts } = await api(`/accounts?phone=${encodeURIComponent(phone)}`);
    renderAccountPicker(accounts, phone);
  } catch (err) {
    toast(err.message, 'err');
  }
});

function renderAccountPicker(accounts, phone) {
  const list = $('#account-list');
  const picker = $('#account-picker');
  if (!accounts.length) {
    list.innerHTML = `<p class="empty">No accounts linked to ${escapeHtml(phone)}. Try 9810000001 or 9820000002.</p>`;
    picker.hidden = false;
    return;
  }
  list.innerHTML = '';
  for (const a of accounts) {
    const el = document.createElement('div');
    el.className = 'acct';
    const action = a.claimed
      ? `<button class="btn" data-login="${escapeAttr(a.upiId)}">Log in</button>`
      : `<div class="acct-claim">
           <input class="claim-pin" type="password" inputmode="numeric" autocomplete="off"
                  minlength="4" maxlength="6" placeholder="Set a 4–6 digit PIN" />
           <button class="btn primary" data-activate="${escapeAttr(a.upiId)}">Activate</button>
         </div>`;
    el.innerHTML = `
      <div class="acct-top">
        <span class="acct-bank">${escapeHtml(a.bankName)}</span>
        <span class="acct-bal">₹${rupees(a.balanceRupees)}</span>
      </div>
      <p class="acct-sub">${escapeHtml(a.holderName)} · ${escapeHtml(a.accountMasked)} · ${escapeHtml(a.upiId)}</p>
      ${action}`;
    list.appendChild(el);
  }
  picker.hidden = false;
}

// Delegate clicks for "Log in" (claimed) and "Activate" (set PIN, then log in).
$('#account-list').addEventListener('click', async (e) => {
  const login = e.target.closest('[data-login]');
  const activate = e.target.closest('[data-activate]');
  try {
    if (login) {
      await loadUser(login.dataset.login);
    } else if (activate) {
      const pin = activate.closest('.acct-claim').querySelector('.claim-pin').value;
      const user = await api(`/accounts/${encodeURIComponent(activate.dataset.activate)}/claim`, {
        method: 'POST',
        body: JSON.stringify({ pin }),
      });
      toast(`Activated ${user.upiId} on ${user.bankName}`, 'ok');
      await loadUser(user.upiId);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-logout').addEventListener('click', () => {
  clearSession();
  state.user = null;
  $('#account-picker').hidden = true;
  $('#form-phone').reset();
  show('screen-onboard');
});

$('#btn-refresh').addEventListener('click', () =>
  refreshBalance().then(() => toast('Balance updated', 'ok')).catch((e) => toast(e.message, 'err')),
);

/* ---------------- Navigation ---------------- */
$$('[data-go]').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.go)));

/* ---------------- Receive (My QR) ---------------- */
$('#form-qr').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams();
  if (f.get('amount')) params.set('amount', f.get('amount'));
  if (f.get('note')) params.set('note', f.get('note'));
  try {
    const data = await api(`/users/${encodeURIComponent(state.user.upiId)}/qr?${params}`);
    $('#qr-image').src = data.qrDataUrl;
    $('#qr-link').textContent = data.upiUri;
    $('#qr-result').hidden = false;
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ---------------- Pay ---------------- */
// When a QR is scanned or a upi:// link is pasted, prefill the form.
function applyUpiLink(text) {
  const form = $('#form-pay');
  if (text.startsWith('upi://')) {
    try {
      const q = new URLSearchParams(text.split('?')[1] || '');
      form.to.value = q.get('pa') || text;
      if (q.get('am')) form.amount.value = q.get('am');
      if (q.get('tn')) form.note.value = q.get('tn');
    } catch {
      form.to.value = text;
    }
  } else {
    form.to.value = text;
  }
}

async function startScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    toast('Scanner library not loaded — enter details manually', 'err');
    return;
  }
  try {
    state.scanner = new Html5Qrcode('scanner');
    $('#btn-scan-start').hidden = true;
    $('#btn-scan-stop').hidden = false;
    await state.scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 220 },
      (decodedText) => {
        applyUpiLink(decodedText);
        toast('QR scanned — review and pay', 'ok');
        stopScanner();
      },
      () => {}, // ignore per-frame decode errors
    );
  } catch (err) {
    $('#btn-scan-start').hidden = false;
    $('#btn-scan-stop').hidden = true;
    toast('Could not start camera: ' + err.message, 'err');
  }
}

async function stopScanner() {
  $('#btn-scan-start').hidden = false;
  $('#btn-scan-stop').hidden = true;
  if (state.scanner) {
    try {
      if (state.scanner.isScanning) await state.scanner.stop();
      state.scanner.clear();
    } catch { /* already stopped */ }
    state.scanner = null;
  }
}

$('#btn-scan-start').addEventListener('click', startScanner);
$('#btn-scan-stop').addEventListener('click', stopScanner);

$('#form-pay').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = f.get('to').trim();
  const body = {
    from: state.user.upiId,
    amount: Number(f.get('amount')),
    note: f.get('note') || undefined,
    pin: f.get('pin'),
  };
  // Accept either a raw UPI ID or a full upi:// link in the "to" field.
  if (to.startsWith('upi://')) body.upiUri = to;
  else body.to = to;

  try {
    const result = await api('/pay', { method: 'POST', body: JSON.stringify(body) });
    state.user = result.payer;
    renderHome();
    e.target.reset();
    $('#qr-result') && ($('#qr-result').hidden = true);
    toast(`Paid ₹${rupees(result.transaction.amountRupees)} to ${result.payee.name}`, 'ok');
    show('screen-home');
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ---------------- Requests (collect) ---------------- */
$('#form-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const req = await api('/requests', {
      method: 'POST',
      body: JSON.stringify({
        from: state.user.upiId,
        to: f.get('to').trim(),
        amount: Number(f.get('amount')),
        note: f.get('note') || undefined,
      }),
    });
    toast(`Request for ₹${rupees(req.amountRupees)} sent to ${req.to}`, 'ok');
    e.target.reset();
    loadRequests();
  } catch (err) {
    toast(err.message, 'err');
  }
});

async function approveRequest(id) {
  const pin = $(`#pin-${id}`)?.value;
  if (!pin) return toast('Enter your PIN to approve', 'err');
  try {
    const result = await api(`/requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    state.user = result.payer;
    renderHome();
    toast(`Paid ₹${rupees(result.transaction.amountRupees)} to ${result.payee.name}`, 'ok');
    loadRequests();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function declineRequest(id) {
  try {
    await api(`/requests/${id}/decline`, { method: 'POST' });
    toast('Request declined', 'ok');
    loadRequests();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadRequests() {
  const inEl = $('#requests-incoming');
  const outEl = $('#requests-outgoing');
  inEl.innerHTML = '<p class="empty">Loading…</p>';
  outEl.innerHTML = '';
  try {
    const { incoming, outgoing } = await api(`/users/${encodeURIComponent(state.user.upiId)}/requests`);

    inEl.innerHTML = '';
    const pending = incoming.filter((r) => r.status === 'PENDING');
    if (!pending.length) {
      inEl.innerHTML = '<p class="empty">No requests to pay.</p>';
    } else {
      for (const r of pending) {
        const el = document.createElement('div');
        el.className = 'req';
        el.innerHTML = `
          <div class="req-top">
            <span class="req-party">${escapeHtml(r.from)} requested</span>
            <span class="req-amount">₹${rupees(r.amountRupees)}</span>
          </div>
          <p class="req-note">${r.note ? escapeHtml(r.note) : 'No note'}</p>
          <div class="req-pin">
            <input id="pin-${r.id}" type="password" inputmode="numeric" autocomplete="off"
                   maxlength="6" placeholder="Your PIN" />
          </div>
          <div class="req-actions">
            <button class="btn primary" data-approve="${r.id}">Pay</button>
            <button class="btn danger" data-decline="${r.id}">Decline</button>
          </div>`;
        inEl.appendChild(el);
      }
    }

    outEl.innerHTML = '';
    if (!outgoing.length) {
      outEl.innerHTML = '<p class="empty">You haven\'t sent any requests.</p>';
    } else {
      for (const r of outgoing) {
        const el = document.createElement('div');
        el.className = 'req';
        el.innerHTML = `
          <div class="req-top">
            <span class="req-party">To ${escapeHtml(r.to)}</span>
            <span class="req-amount">₹${rupees(r.amountRupees)}</span>
          </div>
          <p class="req-note">${r.note ? escapeHtml(r.note) : 'No note'}</p>
          <span class="req-status ${r.status.toLowerCase()}">${r.status.toLowerCase()}</span>`;
        outEl.appendChild(el);
      }
    }
  } catch (err) {
    inEl.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

// Event delegation for the dynamically-rendered approve/decline buttons.
$('#requests-incoming').addEventListener('click', (e) => {
  const approve = e.target.closest('[data-approve]');
  const decline = e.target.closest('[data-decline]');
  if (approve) approveRequest(approve.dataset.approve);
  else if (decline) declineRequest(decline.dataset.decline);
});

/* ---------------- History ---------------- */
async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const { transactions } = await api(`/users/${encodeURIComponent(state.user.upiId)}/transactions`);
    if (!transactions.length) {
      list.innerHTML = '<p class="empty">No transactions yet.</p>';
      return;
    }
    list.innerHTML = '';
    for (const t of transactions) {
      const outgoing = t.from === state.user.upiId;
      const other = outgoing ? t.to : t.from;
      const row = document.createElement('div');
      row.className = 'txn';
      row.innerHTML = `
        <div class="txn-main">
          <span class="txn-party">${outgoing ? 'To' : 'From'} ${other}</span>
          <span class="txn-note">${t.note ? escapeHtml(t.note) : 'No note'} · ${new Date(t.createdAt).toLocaleString('en-IN')}</span>
        </div>
        <span class="txn-amount ${outgoing ? 'out' : 'in'}">${outgoing ? '−' : '+'}₹${rupees(t.amountRupees)}</span>`;
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Boot ---------------- */
(async function boot() {
  const saved = localStorage.getItem('upi_current');
  if (saved) {
    try {
      await loadUser(saved);
      return;
    } catch {
      clearSession();
    }
  }
  show('screen-onboard');
})();
