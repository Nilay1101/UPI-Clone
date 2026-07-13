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

const DB_KEY = 'upi_demo_db_v4'; // v4: more billers per category
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
    pin: null, failedPinAttempts: 0, lockedUntil: null, claimed: false, kind: 'personal',
  });
  const biller = (upiId, name, category) => ({
    upiId, bankId: null, accountNumber: upiId.split('@')[0].toUpperCase(), holderName: name,
    phone: '', balancePaise: 0, pin: null, failedPinAttempts: 0, lockedUntil: null,
    claimed: false, kind: 'biller', category,
  });
  const d = {
    banks: {
      hdfc: { id: 'hdfc', name: 'HDFC Bank', ifsc: 'HDFC0001' },
      sbi: { id: 'sbi', name: 'State Bank of India', ifsc: 'SBIN0001' },
      enbd: { id: 'enbd', name: 'Emirates NBD', ifsc: 'EBILAEAD' },
    },
    accounts: {
      'ravi@hdfc': acct('ravi@hdfc', 'hdfc', '1001', 'Ravi Kumar', '+919810000001', 500000),
      'ravi@sbi': acct('ravi@sbi', 'sbi', '2001', 'Ravi Kumar', '+919810000001', 300000),
      'priya@hdfc': acct('priya@hdfc', 'hdfc', '1002', 'Priya Shah', '+919820000002', 800000),
      'priya@sbi': acct('priya@sbi', 'sbi', '2002', 'Priya Shah', '+919820000002', 200000),
      'sara@enbd': acct('sara@enbd', 'enbd', '3001', 'Sara Ali', '+971501234567', 1000000),
      'omar@enbd': acct('omar@enbd', 'enbd', '3002', 'Omar Khan', '+971509876543', 700000),
      'airtel@bill': biller('airtel@bill', 'Airtel', 'mobile'),
      'jio@bill': biller('jio@bill', 'Jio', 'mobile'),
      'vi@bill': biller('vi@bill', 'Vi (Vodafone Idea)', 'mobile'),
      'power@bill': biller('power@bill', 'State Electricity Board', 'electricity'),
      'adani@bill': biller('adani@bill', 'Adani Electricity', 'electricity'),
      'tataplay@bill': biller('tataplay@bill', 'Tata Play', 'dth'),
      'dishtv@bill': biller('dishtv@bill', 'Dish TV', 'dth'),
      'water@bill': biller('water@bill', 'City Water Works', 'water'),
      'gas@bill': biller('gas@bill', 'Bharat Gas', 'gas'),
      'indane@bill': biller('indane@bill', 'Indane Gas', 'gas'),
    },
    transactions: [],
    requests: [],
    otps: {},
    sessions: {},
  };
  saveDb(d);
  return d;
}
function db() { return loadDb() || seedDb(); }

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_INTERVAL_MS = 30 * 1000;
const OTP_SEND_MAX = 5;
const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;
const otpRates = new Map(); // phone -> { windowStart, count, lastSentAt } (ephemeral)
const BANK_VERIF_TTL_MS = 5 * 60 * 1000;
const bankVerifs = new Map(); // requestId -> { upiId, status, expiresAt } (ephemeral)
function isBankApproved(upiId) {
  const now = Date.now();
  for (const rec of bankVerifs.values()) {
    if (rec.upiId === upiId && rec.status === 'APPROVED' && rec.expiresAt >= now) return true;
  }
  return false;
}
const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));
function sessionPhone(d, token) {
  const s = d.sessions[token];
  if (!s || s.expiresAt < Date.now()) return null;
  return s.phone;
}

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
function ensure(d) {
  if (!d.requests) d.requests = [];
  if (!d.transactions) d.transactions = [];
  if (!d.otps) d.otps = {};
  if (!d.sessions) d.sessions = {};
}

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

  if (rawPath === '/contacts' && method === 'GET') {
    const me = params.get('exclude') ? d.accounts[decodeURIComponent(params.get('exclude'))] : null;
    const excludePhone = me ? me.phone : '';
    const seen = new Set();
    const contacts = [];
    for (const a of Object.values(d.accounts)) {
      if (a.kind !== 'personal' || a.phone === excludePhone || seen.has(a.holderName)) continue;
      seen.add(a.holderName);
      contacts.push({ name: a.holderName, upiId: a.upiId });
    }
    contacts.sort((x, y) => x.name.localeCompare(y.name));
    return { contacts };
  }

  if (rawPath === '/billers' && method === 'GET') {
    return {
      billers: Object.values(d.accounts)
        .filter((a) => a.kind === 'biller')
        .map((a) => ({ upiId: a.upiId, name: a.holderName, category: a.category })),
    };
  }

  // Search people (by name/UPI ID) and billers (by name/category).
  if (rawPath === '/search' && method === 'GET') {
    const term = String(params.get('q') || '').trim().toLowerCase();
    if (!term) return { people: [], billers: [] };
    const me = params.get('exclude') ? d.accounts[decodeURIComponent(params.get('exclude'))] : null;
    const excludePhone = me ? me.phone : '';
    const seen = new Set();
    const people = [];
    const billers = [];
    for (const a of Object.values(d.accounts)) {
      if (a.kind === 'personal') {
        if (a.phone === excludePhone || seen.has(a.holderName)) continue;
        if (a.holderName.toLowerCase().includes(term) || a.upiId.toLowerCase().includes(term)) {
          seen.add(a.holderName);
          people.push({ name: a.holderName, upiId: a.upiId });
        }
      } else if (a.kind === 'biller') {
        if (a.holderName.toLowerCase().includes(term) || (a.category || '').toLowerCase().includes(term)) {
          billers.push({ upiId: a.upiId, name: a.holderName, category: a.category });
        }
      }
    }
    people.sort((x, y) => x.name.localeCompare(y.name));
    billers.sort((x, y) => x.name.localeCompare(y.name));
    return { people, billers };
  }

  // "Fetch" a bill (deterministic simulated amount due + due date).
  if (parts[0] === 'billers' && parts.length === 3 && parts[2] === 'fetch-bill' && method === 'POST') {
    const upiId = decodeURIComponent(parts[1]);
    const biller = d.accounts[upiId];
    if (!biller || biller.kind !== 'biller') throw new Error(`'${upiId}' is not a biller`);
    const c = String(body.consumer || '').trim();
    if (!c) throw new Error('consumer number is required');
    let hash = 0;
    for (const ch of c + upiId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const amountPaise = (200 + (hash % 2300)) * 100;
    const days = 3 + (hash % 13);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    return {
      upiId, billerName: biller.holderName, category: biller.category, consumer: c,
      amountRupees: paiseToRupees(amountPaise),
      dueDate: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
      period: `${months[now.getMonth()]} ${now.getFullYear()}`,
    };
  }

  // Send a one-time code (no real SMS — the code is returned so the demo can show it).
  if (rawPath === '/otp/send' && method === 'POST') {
    const phone = String(body.phone || '').trim();
    if (!phone) throw new Error('phone is required');
    const now = Date.now();
    let rl = otpRates.get(phone);
    if (!rl || now - rl.windowStart > OTP_SEND_WINDOW_MS) rl = { windowStart: now, count: 0, lastSentAt: 0 };
    if (rl.lastSentAt && now - rl.lastSentAt < RESEND_INTERVAL_MS) {
      throw new Error(`please wait ${Math.ceil((RESEND_INTERVAL_MS - (now - rl.lastSentAt)) / 1000)}s before requesting another code`);
    }
    if (rl.count >= OTP_SEND_MAX) throw new Error('too many codes requested; please try again later');
    const code = sixDigits();
    d.otps[phone] = { code, expiresAt: now + OTP_TTL_MS, attempts: 0 };
    otpRates.set(phone, { ...rl, count: rl.count + 1, lastSentAt: now });
    saveDb(d);
    return { sent: true, devCode: code };
  }

  // Verify a code → mint a short-lived token.
  if (rawPath === '/otp/verify' && method === 'POST') {
    const phone = String(body.phone || '').trim();
    const rec = d.otps[phone];
    if (!rec || rec.expiresAt < Date.now()) throw new Error('code expired; request a new one');
    if (rec.attempts >= OTP_MAX_ATTEMPTS) { delete d.otps[phone]; saveDb(d); throw new Error('too many attempts; request a new code'); }
    if (String(body.code) !== rec.code) { rec.attempts += 1; saveDb(d); throw new Error('incorrect code'); }
    delete d.otps[phone];
    const token = uuid();
    d.sessions[token] = { phone, expiresAt: Date.now() + SESSION_TTL_MS };
    saveDb(d);
    return { token };
  }

  if (rawPath === '/accounts' && method === 'GET') {
    const phone = String(params.get('phone') || '').trim();
    if (!phone) throw new Error('phone is required');
    const accounts = Object.values(d.accounts)
      .filter((a) => a.kind === 'personal' && a.phone === phone)
      .map(serializeAccountSummary);
    return { phone, accounts };
  }

  // Bank verification: request (needs OTP token) then approve (bank app).
  if (parts[0] === 'accounts' && parts.length === 3 && parts[2] === 'verify-request' && method === 'POST') {
    const upiId = decodeURIComponent(parts[1]);
    const account = requireUser(d, upiId, 'account');
    if (sessionPhone(d, body.token) !== account.phone) {
      throw new Error('phone not verified; complete OTP verification first');
    }
    const requestId = uuid();
    bankVerifs.set(requestId, { upiId, status: 'PENDING', expiresAt: Date.now() + BANK_VERIF_TTL_MS });
    return { requestId, bankName: bankName(account.bankId), status: 'PENDING' };
  }

  if (parts[0] === 'bank' && parts[1] === 'verify' && parts[3] === 'approve' && method === 'POST') {
    const requestId = decodeURIComponent(parts[2]);
    const rec = bankVerifs.get(requestId);
    if (!rec || rec.expiresAt < Date.now()) throw new Error('verification request not found or expired');
    rec.status = 'APPROVED';
    return { requestId, status: 'APPROVED' };
  }

  if (parts[0] === 'accounts' && parts.length === 3 && parts[2] === 'claim' && method === 'POST') {
    const upiId = decodeURIComponent(parts[1]);
    const account = requireUser(d, upiId, 'account');
    if (sessionPhone(d, body.token) !== account.phone) {
      throw new Error('phone not verified; complete OTP verification first');
    }
    if (!isBankApproved(upiId)) {
      throw new Error('bank verification required; approve the request in your bank app');
    }
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
const state = { user: null, scanner: null, otpToken: null, pendingPhone: null, resendTimer: null, link: null, bill: null, billers: [] };
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
  if (screenId === 'screen-pay') populatePayFrom();
  if (screenId !== 'screen-home') $('#account-switcher').hidden = true;
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
  renderPeople();
  renderBills();
}

/* ---- People (contacts) ---- */
const AVATAR_COLORS = ['#6d5efc', '#e5484d', '#14a06b', '#b7791f', '#4b3fd6', '#0ea5e9'];
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const colorFor = (s) => AVATAR_COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

async function renderPeople() {
  const row = $('#people-row');
  try {
    const { contacts } = await api(`/contacts?exclude=${encodeURIComponent(state.user.upiId)}`);
    row.innerHTML = '';
    for (const c of contacts) {
      const b = document.createElement('button');
      b.className = 'person';
      b.dataset.pay = c.upiId;
      b.innerHTML = `<span class="avatar" style="background:${colorFor(c.name)}">${escapeHtml(initials(c.name))}</span>
        <span class="person-name">${escapeHtml(c.name.split(' ')[0])}</span>`;
      row.appendChild(b);
    }
    const nw = document.createElement('button');
    nw.className = 'person';
    nw.id = 'person-new';
    nw.innerHTML = `<span class="avatar new">＋</span><span class="person-name">New</span>`;
    row.appendChild(nw);
  } catch { row.innerHTML = ''; }
}

$('#people-row').addEventListener('click', (e) => {
  const person = e.target.closest('[data-pay]');
  const nw = e.target.closest('#person-new');
  if (person) payTo(person.dataset.pay);
  else if (nw) payTo('');
});

function payTo(upiId) {
  show('screen-pay');
  $('#form-pay').reset();
  $('#form-pay').to.value = upiId;
}

/* ---- Search ---- */
let searchTimer;
document.getElementById('btn-search').addEventListener('click', () => {
  $('#search-input').value = '';
  renderSearch({ people: [], billers: [] }, '');
  show('screen-search');
  setTimeout(() => $('#search-input').focus(), 50);
});

$('#search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) return renderSearch({ people: [], billers: [] }, '');
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(
        `/search?q=${encodeURIComponent(q)}&exclude=${encodeURIComponent(state.user.upiId)}`,
      );
      renderSearch(results, q);
    } catch { /* keep prior results on transient error */ }
  }, 200);
});

function renderSearch({ people, billers }, q) {
  const box = $('#search-results');
  box.innerHTML = '';

  const looksLikeVpa = /^[\w.\-]+@[\w.\-]+$/.test(q);
  if (looksLikeVpa && !people.some((p) => p.upiId.toLowerCase() === q.toLowerCase())) {
    box.appendChild(searchRow('＠', `Pay ${q}`, 'UPI ID', () => payTo(q)));
  }

  if (people.length) {
    box.appendChild(sectionTitle('People'));
    for (const p of people) {
      const av = `<span class="avatar" style="background:${colorFor(p.name)}">${escapeHtml(initials(p.name))}</span>`;
      box.appendChild(searchRow(av, p.name, p.upiId, () => payTo(p.upiId)));
    }
  }
  if (billers.length) {
    box.appendChild(sectionTitle('Billers'));
    for (const b of billers) {
      const icon = BILL_ICONS[b.category] || '🧾';
      box.appendChild(searchRow(icon, b.name, BILL_LABELS[b.category] || b.category,
        () => openBill(b, 'search')));
    }
  }

  if (!box.children.length) {
    const p = document.createElement('p');
    p.className = 'search-empty';
    p.innerHTML = q
      ? `No matches for “${escapeHtml(q)}”.`
      : 'Search for a person, a biller, or type a UPI ID like <code>priya@hdfc</code>.';
    box.appendChild(p);
  }
}

function sectionTitle(text) {
  const h = document.createElement('h3');
  h.className = 'section-title';
  h.textContent = text;
  return h;
}

function searchRow(iconHtml, title, sub, onClick) {
  const btn = document.createElement('button');
  btn.className = 'search-row';
  const icon = iconHtml.startsWith('<') ? iconHtml : `<span class="search-row-icon">${iconHtml}</span>`;
  btn.innerHTML = `${icon}<span class="search-row-text">
    <span class="search-row-title">${escapeHtml(title)}</span>
    <span class="search-row-sub">${escapeHtml(sub)}</span></span>`;
  btn.addEventListener('click', onClick);
  return btn;
}

/* ---- Bills & recharges ---- */
const BILL_ICONS = { mobile: '📱', electricity: '💡', dth: '📺', water: '💧', gas: '🔥' };
const BILL_LABELS = { mobile: 'Mobile', electricity: 'Electricity', dth: 'DTH', water: 'Water', gas: 'Gas' };
const BILL_ORDER = ['mobile', 'electricity', 'dth', 'water', 'gas'];

async function renderBills() {
  const grid = $('#bills-grid');
  try {
    const { billers } = await api('/billers');
    state.billers = billers;
    const cats = BILL_ORDER.filter((c) => billers.some((b) => b.category === c));
    grid.innerHTML = '';
    for (const cat of cats) {
      const el = document.createElement('button');
      el.className = 'bill';
      el.dataset.category = cat;
      el.innerHTML = `<span class="bill-icon">${BILL_ICONS[cat] || '🧾'}</span>
        <span>${escapeHtml(BILL_LABELS[cat] || cat)}</span>`;
      grid.appendChild(el);
    }
  } catch { grid.innerHTML = ''; }
}

$('#bills-grid').addEventListener('click', (e) => {
  const t = e.target.closest('[data-category]');
  if (t) openCategory(t.dataset.category);
});

function openCategory(category) {
  const list = (state.billers || []).filter((b) => b.category === category);
  if (list.length === 1) return openBill(list[0], 'home');
  $('#billers-title').textContent = `${BILL_LABELS[category] || 'Select'} — pick a biller`;
  const el = $('#biller-list');
  el.innerHTML = '';
  for (const b of list) {
    const item = document.createElement('button');
    item.className = 'biller-item';
    item.dataset.biller = b.upiId;
    item.innerHTML = `<span class="bill-icon">${BILL_ICONS[category] || '🧾'}</span> ${escapeHtml(b.name)}`;
    el.appendChild(item);
  }
  show('screen-billers');
}

$('#biller-list').addEventListener('click', (e) => {
  const t = e.target.closest('[data-biller]');
  if (!t) return;
  const b = (state.billers || []).find((x) => x.upiId === t.dataset.biller);
  if (b) openBill(b, 'billers');
});

function openBill(biller, backTo) {
  state.bill = { upiId: biller.upiId, name: biller.name, category: biller.category, backTo };
  $('#bill-title').textContent = `${BILL_LABELS[biller.category] || 'Pay'} bill`;
  $('#bill-biller').textContent = biller.name;
  $('#form-fetch-bill').reset();
  $('#bill-result').hidden = true;
  show('screen-bill');
}

$('#btn-bill-back').addEventListener('click', () => {
  const back = state.bill && state.bill.backTo;
  if (back === 'billers') show('screen-billers');
  else if (back === 'search') show('screen-search');
  else show('screen-home');
});

$('#form-fetch-bill').addEventListener('submit', async (e) => {
  e.preventDefault();
  const consumer = new FormData(e.target).get('consumer').trim();
  try {
    const bill = await api(`/billers/${encodeURIComponent(state.bill.upiId)}/fetch-bill`, {
      method: 'POST', body: JSON.stringify({ consumer }),
    });
    state.bill.consumer = consumer;
    $('#bill-due').textContent = rupees(bill.amountRupees);
    $('#bill-consumer').textContent = consumer;
    $('#bill-duedate').textContent = bill.dueDate;
    $('#bill-period').textContent = bill.period;
    $('#form-bill').amount.value = bill.amountRupees;
    await populateBillFrom();
    $('#bill-result').hidden = false;
  } catch (err) { toast(err.message, 'err'); }
});

async function populateBillFrom() {
  const sel = $('#bill-from');
  try {
    const accounts = (await myAccounts()).filter((a) => a.claimed);
    sel.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.upiId;
      opt.textContent = `${a.bankName} ${a.accountMasked} — ₹${rupees(a.balanceRupees)}`;
      if (a.upiId === state.user.upiId) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    sel.innerHTML = `<option value="${escapeAttr(state.user.upiId)}">${escapeHtml(state.user.upiId)}</option>`;
  }
}

$('#form-bill').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const result = await api('/pay', {
      method: 'POST',
      body: JSON.stringify({
        from: f.get('from') || state.user.upiId,
        to: state.bill.upiId,
        amount: Number(f.get('amount')),
        note: `${state.bill.name} · ${state.bill.consumer}`,
        pin: f.get('pin'),
      }),
    });
    state.user = result.payer;
    saveSession(result.payer.upiId);
    renderHome();
    toast(`Paid ₹${rupees(result.transaction.amountRupees)} to ${state.bill.name}`, 'ok');
    show('screen-home');
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-pay-upi').addEventListener('click', () => payTo(''));

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

/* ---- Onboarding: phone -> OTP -> pick account ---- */
function showOnboardStep(step) {
  $('#onboard-phone').hidden = step !== 'phone';
  $('#onboard-otp').hidden = step !== 'otp';
  $('#onboard-accounts').hidden = step !== 'accounts';
  if (step !== 'otp') stopResendCountdown();
}

function stopResendCountdown() {
  if (state.resendTimer) clearInterval(state.resendTimer);
  state.resendTimer = null;
}
function startResendCountdown(seconds = 30) {
  stopResendCountdown();
  const btn = $('#btn-resend');
  let left = seconds;
  const tick = () => {
    if (left <= 0) { stopResendCountdown(); btn.disabled = false; btn.textContent = 'Resend code'; }
    else { btn.disabled = true; btn.textContent = `Resend code in ${left}s`; left -= 1; }
  };
  tick();
  state.resendTimer = setInterval(tick, 1000);
}

async function sendOtpTo(phone, cc, local) {
  const { devCode } = await api('/otp/send', { method: 'POST', body: JSON.stringify({ phone }) });
  state.pendingPhone = phone;
  $('#otp-number').textContent = `${cc} ${local}`;
  $('#otp-hint').innerHTML = `Demo code (no real SMS is sent): <code>${escapeHtml(devCode)}</code>`;
  startResendCountdown(30);
}

$('#btn-resend').addEventListener('click', async () => {
  if ($('#btn-resend').disabled) return;
  const [cc, local] = ($('#otp-number').textContent || ' ').split(' ');
  try { await sendOtpTo(state.pendingPhone, cc, local); toast('New code sent', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});

$('#form-phone').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cc = $('#country-code').value;
  const local = new FormData(e.target).get('phone').replace(/\D/g, '');
  if (!local) return toast('Enter a mobile number', 'err');
  try {
    await sendOtpTo(cc + local, cc, local);
    $('#form-otp').reset();
    showOnboardStep('otp');
  } catch (err) { toast(err.message, 'err'); }
});

$('#form-otp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code').trim();
  try {
    const { token } = await api('/otp/verify', { method: 'POST', body: JSON.stringify({ phone: state.pendingPhone, code }) });
    state.otpToken = token;
    localStorage.setItem('upi_demo_token', token);
    const { accounts } = await api(`/accounts?phone=${encodeURIComponent(state.pendingPhone)}`);
    $('#onboard-number').textContent = $('#otp-number').textContent;
    renderAccountPicker(accounts, state.pendingPhone);
    showOnboardStep('accounts');
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-otp-back').addEventListener('click', () => showOnboardStep('phone'));
$('#btn-onboard-back').addEventListener('click', () => showOnboardStep('otp'));

function renderAccountPicker(accounts, phone) {
  const list = $('#account-list');
  if (!accounts.length) {
    list.innerHTML = `<p class="empty">No accounts are linked to this number in the demo.
      Go back and try 🇮🇳 9810000001 / 9820000002 or 🇦🇪 501234567 / 509876543.</p>`;
    return;
  }
  list.innerHTML = '';
  for (const a of accounts) {
    const el = document.createElement('div');
    el.className = 'acct';
    const action = a.claimed
      ? `<button class="btn" data-login="${escapeAttr(a.upiId)}">Log in</button>`
      : `<button class="btn primary" data-link="${escapeAttr(a.upiId)}">Link account</button>`;
    el.innerHTML = `
      <div class="acct-top">
        <span class="acct-bank">${escapeHtml(a.bankName)}</span>
        <span class="acct-bal">₹${rupees(a.balanceRupees)}</span>
      </div>
      <p class="acct-sub">${escapeHtml(a.holderName)} · ${escapeHtml(a.accountMasked)} · ${escapeHtml(a.upiId)}</p>
      ${action}`;
    list.appendChild(el);
  }
}

$('#account-list').addEventListener('click', async (e) => {
  const login = e.target.closest('[data-login]');
  const link = e.target.closest('[data-link]');
  try {
    if (login) await loadUser(login.dataset.login);
    else if (link) await startBankLink(link.dataset.link, false);
  } catch (err) { toast(err.message, 'err'); }
});

/* ---- Bank verification (approve in your bank app) ---- */
async function startBankLink(upiId, fromHome) {
  const res = await api(`/accounts/${encodeURIComponent(upiId)}/verify-request`, {
    method: 'POST', body: JSON.stringify({ token: state.otpToken }),
  });
  state.link = { upiId, requestId: res.requestId, bankName: res.bankName, fromHome };
  $('#bv-bank').textContent = res.bankName;
  $('#bv-bank2').textContent = res.bankName;
  $('#bv-bank3').textContent = res.bankName;
  $('#bv-upi').textContent = upiId;
  $('#btn-bank-approve').disabled = false;
  $('#bankverify-approved').hidden = true;
  $('#bankverify-pending').hidden = false;
  $('#form-bank-pin').reset();
  show('screen-bankverify');
}

$('#btn-bank-approve').addEventListener('click', async () => {
  const btn = $('#btn-bank-approve');
  btn.disabled = true;
  try {
    await api(`/bank/verify/${state.link.requestId}/approve`, { method: 'POST' });
    toast(`Approved by ${state.link.bankName}`, 'ok');
    $('#bankverify-pending').hidden = true;
    $('#bankverify-approved').hidden = false;
  } catch (err) { btn.disabled = false; toast(err.message, 'err'); }
});

$('#form-bank-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = new FormData(e.target).get('pin');
  try {
    const user = await api(`/accounts/${encodeURIComponent(state.link.upiId)}/claim`, {
      method: 'POST', body: JSON.stringify({ pin, token: state.otpToken }),
    });
    toast(`Activated ${user.upiId} on ${user.bankName}`, 'ok');
    await loadUser(user.upiId);
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-bankverify-back').addEventListener('click', () => {
  if (state.link && state.link.fromHome) show('screen-home');
  else { show('screen-onboard'); showOnboardStep('accounts'); }
});

$('#btn-logout').addEventListener('click', () => {
  clearSession();
  state.user = null;
  state.otpToken = null;
  localStorage.removeItem('upi_demo_token');
  $('#form-phone').reset();
  showOnboardStep('phone');
  show('screen-onboard');
});

$('#btn-refresh').addEventListener('click', () =>
  refreshBalance().then(() => toast('Balance updated', 'ok')).catch((e) => toast(e.message, 'err')),
);

/* ---- Multiple banks per profile ---- */
async function myAccounts() {
  const { accounts } = await api(`/accounts?phone=${encodeURIComponent(state.user.phone)}`);
  return accounts;
}

$('#btn-switch-account').addEventListener('click', () => {
  const panel = $('#account-switcher');
  const willShow = panel.hidden;
  panel.hidden = !willShow;
  if (willShow) loadSwitcher();
});

async function loadSwitcher() {
  const list = $('#switcher-list');
  list.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const accounts = await myAccounts();
    list.innerHTML = '';
    for (const a of accounts) {
      const isActive = a.upiId === state.user.upiId;
      const el = document.createElement('div');
      el.className = 'acct' + (isActive ? ' active' : '');
      let action;
      if (isActive) action = '<span class="acct-tag">Active</span>';
      else if (a.claimed) action = `<button class="btn" data-use="${escapeAttr(a.upiId)}">Use this</button>`;
      else action = `<button class="btn primary" data-link="${escapeAttr(a.upiId)}">Link account</button>`;
      el.innerHTML = `
        <div class="acct-top">
          <span class="acct-bank">${escapeHtml(a.bankName)}</span>
          <span class="acct-bal">₹${rupees(a.balanceRupees)}</span>
        </div>
        <p class="acct-sub">${escapeHtml(a.accountMasked)} · ${escapeHtml(a.upiId)}</p>
        ${action}`;
      list.appendChild(el);
    }
  } catch (err) { list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

$('#switcher-list').addEventListener('click', async (e) => {
  const use = e.target.closest('[data-use]');
  const link = e.target.closest('[data-link]');
  try {
    if (use) {
      await loadUser(use.dataset.use);
      $('#account-switcher').hidden = true;
      toast('Switched account', 'ok');
    } else if (link) {
      $('#account-switcher').hidden = true;
      await startBankLink(link.dataset.link, true);
    }
  } catch (err) { toast(err.message, 'err'); }
});

async function populatePayFrom() {
  const sel = $('#pay-from');
  try {
    const accounts = (await myAccounts()).filter((a) => a.claimed);
    sel.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.upiId;
      opt.textContent = `${a.bankName} ${a.accountMasked} — ₹${rupees(a.balanceRupees)}`;
      if (a.upiId === state.user.upiId) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    sel.innerHTML = `<option value="${escapeAttr(state.user.upiId)}">${escapeHtml(state.user.upiId)}</option>`;
  }
}

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
  const body = { from: f.get('from') || state.user.upiId, amount: Number(f.get('amount')), note: f.get('note') || undefined, pin: f.get('pin') };
  if (to.startsWith('upi://')) body.upiUri = to; else body.to = to;
  try {
    const result = await api('/pay', { method: 'POST', body: JSON.stringify(body) });
    state.user = result.payer;
    saveSession(result.payer.upiId);
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
  state.otpToken = localStorage.getItem('upi_demo_token');
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    try { await loadUser(saved); return; } catch { clearSession(); }
  }
  show('screen-onboard');
})();
