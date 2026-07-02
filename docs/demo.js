/*
 * UPI-Clone — standalone DEMO build.
 *
 * This is the same front-end as the real app, but instead of calling a server
 * it runs a tiny "backend" right here in the browser, persisting to
 * localStorage. It faithfully mirrors the real API's behaviour — UPI IDs,
 * QR codes, PIN checks and the wrong-PIN lockout — so you can explore the
 * product on any device with no install and no server.
 *
 * Differences from the real app (all for demo convenience):
 *   - data lives in your browser only (Reset wipes it)
 *   - the PIN is stored locally in plaintext (the real app stores a salted
 *     scrypt hash on the server); it's never shown on screen
 *   - the lockout cooldown is 60 seconds instead of 15 minutes
 */

const DB_KEY = 'upi_demo_db_v1';
const SESSION_KEY = 'upi_demo_current';
const MAX_PIN_ATTEMPTS = 3;
const LOCK_MS = 60 * 1000; // 60s (real app: 15 min)

/* ============================================================
 * In-browser "backend"
 * ========================================================== */
function loadDb() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || null;
  } catch {
    return null;
  }
}
function saveDb(d) {
  localStorage.setItem(DB_KEY, JSON.stringify(d));
}
function seedDb() {
  const now = new Date().toISOString();
  const person = (upiId, name, balancePaise) => ({
    upiId, name, phone: null, balancePaise,
    pin: '0000', failedPinAttempts: 0, lockedUntil: null, createdAt: now,
  });
  const d = {
    users: {
      'ravi0001@upiclone': person('ravi0001@upiclone', 'Ravi', 50000),
      'priya0002@upiclone': person('priya0002@upiclone', 'Priya', 25000),
    },
    transactions: [],
  };
  saveDb(d);
  return d;
}
function db() {
  return loadDb() || seedDb();
}

const rupeesToPaise = (r) => {
  const n = Number(r);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const paiseToRupees = (p) => p / 100;

function generateUpiId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  return `${slug}${1000 + Math.floor(Math.random() * 9000)}@upiclone`;
}
function buildUpiUri({ pa, pn, am, tn, cu = 'INR' }) {
  const p = new URLSearchParams();
  p.set('pa', pa);
  if (pn) p.set('pn', pn);
  if (am != null && am !== '') p.set('am', String(am));
  p.set('cu', cu);
  if (tn) p.set('tn', tn);
  return `upi://pay?${p.toString()}`;
}
function parseUpiUri(uri) {
  const m = String(uri).match(/^upi:\/\/pay\?(.*)$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  return { pa: q.get('pa'), pn: q.get('pn'), am: q.get('am'), tn: q.get('tn') };
}

const serializeUser = (u) => ({
  upiId: u.upiId, name: u.name, phone: u.phone,
  balanceRupees: paiseToRupees(u.balancePaise), createdAt: u.createdAt,
});
const serializeTxn = (t) => ({
  id: t.id, from: t.from, to: t.to,
  amountRupees: paiseToRupees(t.amountPaise), note: t.note, status: t.status, createdAt: t.createdAt,
});

function requireUser(d, upiId, label) {
  const u = d.users[upiId];
  if (!u) throw new Error(`${label} '${upiId}' not found`);
  return u;
}

function assertValidPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) throw new Error('pin must be 4 to 6 digits');
}

function authorizePin(user, pin) {
  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    const secs = Math.ceil((user.lockedUntil - now) / 1000);
    throw new Error(`account locked after too many wrong PIN attempts; try again in ${secs} second(s)`);
  }
  if (user.lockedUntil && user.lockedUntil <= now) {
    user.failedPinAttempts = 0;
    user.lockedUntil = null;
  }
  if (String(pin) === user.pin) {
    user.failedPinAttempts = 0;
    user.lockedUntil = null;
    return;
  }
  const attempts = (user.failedPinAttempts || 0) + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    user.failedPinAttempts = attempts;
    user.lockedUntil = now + LOCK_MS;
    throw new Error(`too many wrong PIN attempts; account locked for ${Math.round(LOCK_MS / 1000)} seconds`);
  }
  user.failedPinAttempts = attempts;
  throw new Error(`incorrect PIN; ${MAX_PIN_ATTEMPTS - attempts} attempt(s) left before lockout`);
}

/** Router that mimics the real HTTP API. Returns data or throws Error(message). */
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const [rawPath, queryStr] = path.split('?');
  const params = new URLSearchParams(queryStr || '');
  const parts = rawPath.split('/').filter(Boolean); // ['users', ':id', 'qr']
  const d = db();

  if (rawPath === '/health') return { status: 'ok' };

  if (parts[0] === 'users' && parts.length === 1 && method === 'POST') {
    if (!body.name || !String(body.name).trim()) throw new Error('name is required');
    assertValidPin(body.pin);
    const openingBalancePaise = rupeesToPaise(body.openingBalance ?? 0);
    if (Number.isNaN(openingBalancePaise) || openingBalancePaise < 0) {
      throw new Error('openingBalance must be a non-negative number');
    }
    let upiId = generateUpiId(body.name);
    while (d.users[upiId]) upiId = generateUpiId(body.name);
    d.users[upiId] = {
      upiId, name: String(body.name).trim(), phone: body.phone ? String(body.phone) : null,
      balancePaise: openingBalancePaise, pin: String(body.pin),
      failedPinAttempts: 0, lockedUntil: null, createdAt: new Date().toISOString(),
    };
    saveDb(d);
    return serializeUser(d.users[upiId]);
  }

  if (parts[0] === 'users' && parts.length >= 2) {
    const upiId = decodeURIComponent(parts[1]);
    if (parts.length === 2 && method === 'GET') return serializeUser(requireUser(d, upiId, 'user'));

    if (parts.length === 3 && parts[2] === 'qr' && method === 'GET') {
      const user = requireUser(d, upiId, 'user');
      const amount = params.get('amount');
      const upiUri = buildUpiUri({
        pa: user.upiId, pn: user.name,
        am: amount != null && amount !== '' ? Number(amount) : undefined,
        tn: params.get('note') || undefined,
      });
      const qrDataUrl = await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
      return { upiId: user.upiId, upiUri, qrDataUrl };
    }

    if (parts.length === 3 && parts[2] === 'transactions' && method === 'GET') {
      requireUser(d, upiId, 'user');
      const txns = d.transactions.filter((t) => t.from === upiId || t.to === upiId).map(serializeTxn);
      return { transactions: txns };
    }
  }

  if (rawPath === '/pay' && method === 'POST') {
    let { from, to, amount, note, upiUri, pin } = body;
    if (upiUri) {
      const parsed = parseUpiUri(upiUri);
      if (!parsed || !parsed.pa) throw new Error('upiUri is not a valid upi://pay link');
      to = to ?? parsed.pa;
      if (amount == null || amount === '') amount = parsed.am;
      note = note ?? parsed.tn ?? undefined;
    }
    if (!from) throw new Error('from (payer UPI ID) is required');
    if (!to) throw new Error('to (payee UPI ID) is required');
    if (amount == null || amount === '') throw new Error('amount is required');
    const amountPaise = rupeesToPaise(amount);
    if (Number.isNaN(amountPaise)) throw new Error('amount must be a number');
    if (amountPaise <= 0) throw new Error('amount must be a positive value');
    if (from === to) throw new Error('cannot transfer to the same account');

    const payer = requireUser(d, from, 'payer');
    requireUser(d, to, 'payee');

    try {
      authorizePin(payer, pin); // mutates attempt/lock counters
    } catch (e) {
      saveDb(d); // persist the failed-attempt bookkeeping even though we throw
      throw e;
    }

    if (payer.balancePaise < amountPaise) {
      saveDb(d);
      throw new Error('insufficient balance');
    }

    payer.balancePaise -= amountPaise;
    d.users[to].balancePaise += amountPaise;
    const txn = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      from, to, amountPaise, note: note ? String(note) : null,
      status: 'SUCCESS', createdAt: new Date().toISOString(),
    };
    d.transactions.unshift(txn);
    saveDb(d);
    return {
      transaction: serializeTxn(txn),
      payer: serializeUser(payer),
      payee: serializeUser(d.users[to]),
    };
  }

  throw new Error('not found');
}

/* ============================================================
 * UI (identical to the real app's front-end)
 * ========================================================== */
const state = { user: null, scanner: null };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3600);
}

function show(screenId) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== screenId));
  if (screenId !== 'screen-pay') stopScanner();
  if (screenId === 'screen-history') loadHistory();
}

const rupees = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function saveSession(upiId) { localStorage.setItem(SESSION_KEY, upiId); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

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
  state.user = await api(`/users/${encodeURIComponent(state.user.upiId)}`);
  renderHome();
}

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

$('#btn-reset-demo').addEventListener('click', () => {
  localStorage.removeItem(DB_KEY);
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

$$('[data-go]').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.go)));

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
      () => {},
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

(async function boot() {
  db(); // ensure demo data (and contacts) exist
  const saved = localStorage.getItem(SESSION_KEY);
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
