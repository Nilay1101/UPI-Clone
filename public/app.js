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
  $('#home-balance').textContent = rupees(state.user.balanceRupees);
}

async function refreshBalance() {
  if (!state.user) return;
  const user = await api(`/users/${encodeURIComponent(state.user.upiId)}`);
  state.user = user;
  renderHome();
}

/* ---------------- Onboarding ---------------- */
$('#form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const user = await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        name: f.get('name'),
        openingBalance: Number(f.get('openingBalance') || 0),
        pin: f.get('pin'),
      }),
    });
    toast(`Welcome, ${user.name}! Your UPI ID is ${user.upiId}`, 'ok');
    await loadUser(user.upiId);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const upiId = new FormData(e.target).get('upiId').trim();
  try {
    await loadUser(upiId);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-logout').addEventListener('click', () => {
  clearSession();
  state.user = null;
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
