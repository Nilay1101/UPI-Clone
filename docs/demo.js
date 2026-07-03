/*
 * UPI-Clone — standalone DEMO build (GPay-style).
 *
 * Same front-end as the real app, but the "backend" runs in the browser and
 * persists to localStorage. It mirrors the real API: dummy banks + accounts,
 * phone-based sign-up (pick an account, set a PIN), QR, PIN checks, the
 * wrong-PIN lockout, and request-money.
 *
 * Demo conveniences: data lives only in this browser (Reset wipes it); the PIN
 * is stored locally in plaintext (real app uses a salted scrypt hash on the
 * server); the lockout cooldown is 60 seconds instead of 15 minutes.
 */

const DB_KEY = 'upi_demo_db_v2'; // v2: bank/account model
const SESSION_KEY = 'upi_demo_current';
const MAX_PIN_ATTEMPTS = 3;
const LOCK_MS = 60 * 1000;

/* ============================================================
 * In-browser "backend"
 * ========================================================== */
function loadDb() {
  try { return JSON.parse(localStorage.getItem(DB_KEY)) || null; } catch { return null; }
}
function saveDb(d) { localStorage.setItem(DB_KEY, JSON.stringify(d)); }

function seedDb() {
  const acct = (upiId, bankId, accountNumber, holderName, phone, balancePaise) => ({
    upiId, bankId, accountNumber, holderName, phone, balancePaise,
    pin: null, failedPinAttempts: 0, lockedUntil: null, claimed: false,
  });
  const d = {
    banks: {
      hdfc: { id: 'hdfc', name: 'HDFC Bank', ifsc: 'HDFC0001' },
      sbi: { id: 'sbi', name: 'State Bank of India', ifsc: 'SBIN0001' },
    },
    accounts: {
      'ravi@hdfc': acct('ravi@hdfc', 'hdfc', '1001', 'Ravi Kumar', '9810000001', 500000),
      'ravi@sbi': acct('ravi@sbi', 'sbi', '2001', 'Ravi Kumar', '9810000001', 300000),
      'priya@hdfc': acct('priya@hdfc', 'hdfc', '1002', 'Priya Shah', '9820000002', 800000),
      'priya@sbi': acct('priya@sbi', 'sbi', '2002', 'Priya Shah', '9820000002', 200000),
    },
    transactions: [],
    requests: [],
  };
  saveDb(d);
  return d;
}
function db() { return loadDb() || seedDb(); }

const uuid = () => (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
const rupeesToPaise = (r) => { const n = Number(r); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const paiseToRupees = (p) => p / 100;
const maskAccount = (n) => `••••${String(n).slice(-4)}`;

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

const serializeUser = (a) => ({
  upiId: a.upiId, name: a.holderName, holderName: a.holderName, phone: a.phone,
  bankId: a.bankId, bankName: bankName(a.bankId), accountMasked: maskAccount(a.accountNumber),
  claimed: a.claimed, balanceRupees: paiseToRupees(a.balancePaise),
});
const serializeAccountSummary = (a) => ({
  upiId: a.upiId, holderName: a.holderName, bankName: bankName(a.bankId), bankId: a.bankId,
  accountMasked: maskAccount(a.accountNumber), balanceRupees: paiseToRupees(a.balancePaise), claimed: a.claimed,
});
const serializeTxn = (t) => ({
  id: t.id, from: t.from, to: t.to, amountRupees: paiseToRupees(t.amountPaise),
  note: t.note, status: t.status, createdAt: t.createdAt,
});
const serializeRequest = (r) => ({
  id: r.id, from: r.from, to: r.to, amountRupees: paiseToRupees(r.amountPaise),
  note: r.note, status: r.status, txnId: r.txnId, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
});

let _db;
function bankName(id) { return (_db?.banks?.[id] || {}).name || id; }

function requireUser(d, upiId, label) {
  const a = d.accounts[upiId];
  if (!a) throw new Error(`${label} '${upiId}' not found`);
  return a;
}
function assertValidPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) throw new Error('pin must be 4 to 6 digits');
}
function ensure(d) { if (!d.requests) d.requests = []; if (!d.transactions) d.transactions = []; }

function authorizePin(account, pin) {
  if (!account.pin) throw new Error('this account is not activated; set a UPI PIN first');
  const now = Date.now();
  if (account.lockedUntil && account.lockedUntil > now) {
    const secs = Math.ceil((account.lockedUntil - now) / 1000);
    throw new Error(`account locked after too many wrong PIN attempts; try again in ${secs} second(s)`);
  }
  if (account.lockedUntil && account.lockedUntil <= now) { account.failedPinAttempts = 0; account.lockedUntil = null; }
  if (String(pin) === account.pin) { account.failedPinAttempts = 0; account.lockedUntil = null; return; }
  const attempts = (account.failedPinAttempts || 0) + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    account.failedPinAttempts = attempts;
    account.lockedUntil = now + LOCK_MS;
    throw new Error(`too many wrong PIN attempts; account locked for ${Math.round(LOCK_MS / 1000)} seconds`);
  }
  account.failedPinAttempts = attempts;
  throw new Error(`incorrect PIN; ${MAX_PIN_ATTEMPTS - attempts} attempt(s) left before lockout`);
}

/** Move money. Saves `d` itself (incl. failed-attempt bookkeeping on throw). */
function doTransfer(d, fromId, toId, amountPaise, note, pin) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new Error('amount must be a positive value');
  if (fromId === toId) throw new Error('cannot transfer to the same account');
  const payer = requireUser(d, fromId, 'payer');
  requireUser(d, toId, 'payee');
  try { authorizePin(payer, pin); } catch (e) { saveDb(d); throw e; }
  if (payer.balancePaise < amountPaise) { saveDb(d); throw new Error('insufficient balance'); }
  payer.balancePaise -= amountPaise;
  d.accounts[toId].balancePaise += amountPaise;
  const txn = {
    id: uuid(), from: fromId, to: toId, amountPaise, note: note ? String(note) : null,
    status: 'SUCCESS', createdAt: new Date().toISOString(),
  };
  d.transactions.unshift(txn);
  saveDb(d);
  return txn;
}

/** Router that mimics the real HTTP API. Returns data or throws Error(message). */
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const [rawPath, queryStr] = path.split('?');
  const params = new URLSearchParams(queryStr || '');
  const parts = rawPath.split('/').filter(Boolean);
  const d = db();
  _db = d;
  ensure(d);

  if (rawPath === '/health') return { status: 'ok' };

  if (rawPath === '/banks' && method === 'GET') return { banks: Object.values(d.banks) };

  if (rawPath === '/accounts' && method === 'GET') {
    const phone = String(params.get('phone') || '').trim();
    if (!phone) throw new Error('phone is required');
    const accounts = Object.values(d.accounts).filter((a) => a.phone === phone).map(serializeAccountSummary);
    return { phone, accounts };
  }

  if (parts[0] === 'accounts' && parts.length === 3 && parts[2] === 'claim' && method === 'POST') {
    const upiId = decodeURIComponent(parts[1]);
    const account = requireUser(d, upiId, 'account');
    if (account.claimed) throw new Error('this account is already set up; just log in');
    assertValidPin(body.pin);
    account.pin = String(body.pin);
    account.claimed = true;
    account.failedPinAttempts = 0;
    account.lockedUntil = null;
    saveDb(d);
    return serializeUser(account);
  }

  if (parts[0] === 'users' && parts.length >= 2) {
    const upiId = decodeURIComponent(parts[1]);
    if (parts.length === 2 && method === 'GET') return serializeUser(requireUser(d, upiId, 'user'));

    if (parts.length === 3 && parts[2] === 'qr' && method === 'GET') {
      const user = requireUser(d, upiId, 'user');
      const amount = params.get('amount');
      const upiUri = buildUpiUri({
        pa: user.upiId, pn: user.holderName,
        am: amount != null && amount !== '' ? Number(amount) : undefined,
        tn: params.get('note') || undefined,
      });
      const qrDataUrl = await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
      return { upiId: user.upiId, upiUri, qrDataUrl };
    }
    if (parts.length === 3 && parts[2] === 'transactions' && method === 'GET') {
      requireUser(d, upiId, 'user');
      return { transactions: d.transactions.filter((t) => t.from === upiId || t.to === upiId).map(serializeTxn) };
    }
    if (parts.length === 3 && parts[2] === 'requests' && method === 'GET') {
      requireUser(d, upiId, 'user');
      return {
        incoming: d.requests.filter((r) => r.to === upiId).map(serializeRequest),
        outgoing: d.requests.filter((r) => r.from === upiId).map(serializeRequest),
      };
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
    const txn = doTransfer(d, from, to, amountPaise, note, pin);
    return { transaction: serializeTxn(txn), payer: serializeUser(d.accounts[from]), payee: serializeUser(d.accounts[to]) };
  }

  if (rawPath === '/requests' && method === 'POST') {
    if (!body.from) throw new Error('from (requester UPI ID) is required');
    if (!body.to) throw new Error('to (payer UPI ID) is required');
    if (body.amount == null || body.amount === '') throw new Error('amount is required');
    const amountPaise = rupeesToPaise(body.amount);
    if (Number.isNaN(amountPaise)) throw new Error('amount must be a number');
    if (amountPaise <= 0) throw new Error('amount must be a positive value');
    if (body.from === body.to) throw new Error('cannot request money from yourself');
    requireUser(d, body.from, 'requester');
    requireUser(d, body.to, 'payer');
    const req = {
      id: uuid(), from: body.from, to: body.to, amountPaise,
      note: body.note ? String(body.note) : null, status: 'PENDING',
      txnId: null, createdAt: new Date().toISOString(), resolvedAt: null,
    };
    d.requests.unshift(req);
    saveDb(d);
    return serializeRequest(req);
  }

  if (parts[0] === 'requests' && parts.length === 3 && method === 'POST') {
    const id = decodeURIComponent(parts[1]);
    const req = d.requests.find((r) => r.id === id);
    if (!req) throw new Error(`request '${id}' not found`);
    if (req.status !== 'PENDING') throw new Error(`request already ${req.status.toLowerCase()}`);
    if (parts[2] === 'approve') {
      const txn = doTransfer(d, req.to, req.from, req.amountPaise, req.note, body.pin);
      req.status = 'APPROVED'; req.txnId = txn.id; req.resolvedAt = new Date().toISOString();
      saveDb(d);
      return {
        request: serializeRequest(req), transaction: serializeTxn(txn),
        payer: serializeUser(d.accounts[req.to]), payee: serializeUser(d.accounts[req.from]),
      };
    }
    if (parts[2] === 'decline') {
      req.status = 'DECLINED'; req.resolvedAt = new Date().toISOString();
      saveDb(d);
      return serializeRequest(req);
    }
  }

  throw new Error('not found');
}

/* ============================================================
 * UI (mirrors the real app's front-end)
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
  if (screenId === 'screen-request') loadRequests();
}

const rupees = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');

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
  $('#home-bank').textContent = `${state.user.bankName} · ${state.user.accountMasked}`;
  $('#home-balance').textContent = rupees(state.user.balanceRupees);
  refreshRequestBadge();
}

async function refreshRequestBadge() {
  if (!state.user) return;
  const badge = $('#req-badge');
  try {
    const { incoming } = await api(`/users/${encodeURIComponent(state.user.upiId)}/requests`);
    const pending = incoming.filter((r) => r.status === 'PENDING').length;
    badge.textContent = pending;
    badge.hidden = pending === 0;
  } catch { badge.hidden = true; }
}

async function refreshBalance() {
  if (!state.user) return;
  state.user = await api(`/users/${encodeURIComponent(state.user.upiId)}`);
  renderHome();
}

/* ---- Onboarding: phone -> pick bank account ---- */
$('#form-phone').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = new FormData(e.target).get('phone').trim();
  try {
    const { accounts } = await api(`/accounts?phone=${encodeURIComponent(phone)}`);
    renderAccountPicker(accounts, phone);
  } catch (err) { toast(err.message, 'err'); }
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

$('#account-list').addEventListener('click', async (e) => {
  const login = e.target.closest('[data-login]');
  const activate = e.target.closest('[data-activate]');
  try {
    if (login) {
      await loadUser(login.dataset.login);
    } else if (activate) {
      const pin = activate.closest('.acct-claim').querySelector('.claim-pin').value;
      const user = await api(`/accounts/${encodeURIComponent(activate.dataset.activate)}/claim`, {
        method: 'POST', body: JSON.stringify({ pin }),
      });
      toast(`Activated ${user.upiId} on ${user.bankName}`, 'ok');
      await loadUser(user.upiId);
    }
  } catch (err) { toast(err.message, 'err'); }
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

$('#btn-reset-demo').addEventListener('click', () => {
  localStorage.removeItem(DB_KEY);
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

$$('[data-go]').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.go)));

/* ---- Receive (My QR) ---- */
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
  } catch (err) { toast(err.message, 'err'); }
});

/* ---- Pay ---- */
function applyUpiLink(text) {
  const form = $('#form-pay');
  if (text.startsWith('upi://')) {
    try {
      const q = new URLSearchParams(text.split('?')[1] || '');
      form.to.value = q.get('pa') || text;
      if (q.get('am')) form.amount.value = q.get('am');
      if (q.get('tn')) form.note.value = q.get('tn');
    } catch { form.to.value = text; }
  } else { form.to.value = text; }
}

async function startScanner() {
  if (typeof Html5Qrcode === 'undefined') { toast('Scanner not loaded — enter details manually', 'err'); return; }
  try {
    state.scanner = new Html5Qrcode('scanner');
    $('#btn-scan-start').hidden = true;
    $('#btn-scan-stop').hidden = false;
    await state.scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 },
      (decodedText) => { applyUpiLink(decodedText); toast('QR scanned — review and pay', 'ok'); stopScanner(); },
      () => {});
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
    try { if (state.scanner.isScanning) await state.scanner.stop(); state.scanner.clear(); } catch { /* */ }
    state.scanner = null;
  }
}
$('#btn-scan-start').addEventListener('click', startScanner);
$('#btn-scan-stop').addEventListener('click', stopScanner);

$('#form-pay').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = f.get('to').trim();
  const body = { from: state.user.upiId, amount: Number(f.get('amount')), note: f.get('note') || undefined, pin: f.get('pin') };
  if (to.startsWith('upi://')) body.upiUri = to; else body.to = to;
  try {
    const result = await api('/pay', { method: 'POST', body: JSON.stringify(body) });
    state.user = result.payer;
    renderHome();
    e.target.reset();
    $('#qr-result') && ($('#qr-result').hidden = true);
    toast(`Paid ₹${rupees(result.transaction.amountRupees)} to ${result.payee.name}`, 'ok');
    show('screen-home');
  } catch (err) { toast(err.message, 'err'); }
});

/* ---- Requests (collect) ---- */
$('#form-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const req = await api('/requests', {
      method: 'POST',
      body: JSON.stringify({ from: state.user.upiId, to: f.get('to').trim(), amount: Number(f.get('amount')), note: f.get('note') || undefined }),
    });
    toast(`Request for ₹${rupees(req.amountRupees)} sent to ${req.to}`, 'ok');
    e.target.reset();
    loadRequests();
  } catch (err) { toast(err.message, 'err'); }
});

async function approveRequest(id) {
  const pin = $(`#pin-${id}`)?.value;
  if (!pin) return toast('Enter your PIN to approve', 'err');
  try {
    const result = await api(`/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ pin }) });
    state.user = result.payer;
    renderHome();
    toast(`Paid ₹${rupees(result.transaction.amountRupees)} to ${result.payee.name}`, 'ok');
    loadRequests();
  } catch (err) { toast(err.message, 'err'); }
}
async function declineRequest(id) {
  try { await api(`/requests/${id}/decline`, { method: 'POST' }); toast('Request declined', 'ok'); loadRequests(); }
  catch (err) { toast(err.message, 'err'); }
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
    if (!pending.length) inEl.innerHTML = '<p class="empty">No requests to pay.</p>';
    else for (const r of pending) {
      const el = document.createElement('div');
      el.className = 'req';
      el.innerHTML = `
        <div class="req-top">
          <span class="req-party">${escapeHtml(r.from)} requested</span>
          <span class="req-amount">₹${rupees(r.amountRupees)}</span>
        </div>
        <p class="req-note">${r.note ? escapeHtml(r.note) : 'No note'}</p>
        <div class="req-pin"><input id="pin-${r.id}" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="Your PIN" /></div>
        <div class="req-actions">
          <button class="btn primary" data-approve="${r.id}">Pay</button>
          <button class="btn danger" data-decline="${r.id}">Decline</button>
        </div>`;
      inEl.appendChild(el);
    }
    outEl.innerHTML = '';
    if (!outgoing.length) outEl.innerHTML = '<p class="empty">You haven\'t sent any requests.</p>';
    else for (const r of outgoing) {
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
  } catch (err) { inEl.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

$('#requests-incoming').addEventListener('click', (e) => {
  const approve = e.target.closest('[data-approve]');
  const decline = e.target.closest('[data-decline]');
  if (approve) approveRequest(approve.dataset.approve);
  else if (decline) declineRequest(decline.dataset.decline);
});

/* ---- History ---- */
async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const { transactions } = await api(`/users/${encodeURIComponent(state.user.upiId)}/transactions`);
    if (!transactions.length) { list.innerHTML = '<p class="empty">No transactions yet.</p>'; return; }
    list.innerHTML = '';
    for (const t of transactions) {
      const outgoing = t.from === state.user.upiId;
      const other = outgoing ? t.to : t.from;
      const row = document.createElement('div');
      row.className = 'txn';
      row.innerHTML = `
        <div class="txn-main">
          <span class="txn-party">${outgoing ? 'To' : 'From'} ${escapeHtml(other)}</span>
          <span class="txn-note">${t.note ? escapeHtml(t.note) : 'No note'} · ${new Date(t.createdAt).toLocaleString('en-IN')}</span>
        </div>
        <span class="txn-amount ${outgoing ? 'out' : 'in'}">${outgoing ? '−' : '+'}₹${rupees(t.amountRupees)}</span>`;
      list.appendChild(row);
    }
  } catch (err) { list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

/* ---- Boot ---- */
(async function boot() {
  db(); // ensure seed exists
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    try { await loadUser(saved); return; } catch { clearSession(); }
  }
  show('screen-onboard');
})();
