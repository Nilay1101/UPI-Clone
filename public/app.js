/* UPI-Clone web front-end. Vanilla JS, talks to the same-origin API. */

const state = {
  user: null, // the active account
  scanner: null, // Html5Qrcode instance when the camera is running
  otpToken: null, // verification token from OTP (needed to activate accounts)
  pendingPhone: null, // phone being verified during sign-up
  resendTimer: null, // countdown interval for the "Resend code" button
  link: null, // account being linked via bank verification
  bill: null, // biller being paid
  billers: [], // cached list of billers
  lastReceipt: null, // last successful payment (for the receipt screen)
  splitId: null, // split being viewed
};

// "Pay UPI ID" opens a blank Pay screen.
document.getElementById('btn-pay-upi').addEventListener('click', () => payTo(''));

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
  if (screenId === 'screen-pay') populatePayFrom();
  if (screenId === 'screen-profile') renderProfile();
  if (screenId === 'screen-rewards') renderRewards();
  if (screenId === 'screen-insights') renderInsights();
  if (screenId === 'screen-splits') renderSplits();
  if (screenId !== 'screen-home') $('#account-switcher').hidden = true;
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
  renderPeople();
  renderBills();
}

/* ---------------- People (contacts) ---------------- */
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

// Navigate to the Pay screen with the payee prefilled.
function payTo(upiId) {
  show('screen-pay');
  $('#form-pay').reset();
  $('#form-pay').to.value = upiId;
}

/* ---------------- Payment success / receipt ---------------- */
// Shape: { transaction, payer, payee }. `statusText` overrides the caption.
function showReceipt(result, statusText = 'Paid successfully') {
  const { transaction: t, payer, payee } = result;
  state.lastReceipt = result;
  $('#rc-amount').textContent = rupees(t.amountRupees);
  $('#rc-status').textContent = statusText;
  $('#rc-to').textContent = `${payee.name} · ${t.to}`;
  $('#rc-from').textContent = `${payer.bankName} · ${payer.accountMasked}`;
  const noteRow = $('#rc-note-row');
  if (t.note) { $('#rc-note').textContent = t.note; noteRow.hidden = false; }
  else noteRow.hidden = true;
  $('#rc-id').textContent = t.id;
  $('#rc-date').textContent = new Date(t.createdAt).toLocaleString('en-IN');
  $('#rc-reward').hidden = !result.cardEarned; // "you earned a scratch card"
  show('screen-success');
}

$('#rc-reward').addEventListener('click', () => show('screen-rewards'));

function receiptText(r) {
  const t = r.transaction;
  return [
    'Payment receipt',
    `₹${rupees(t.amountRupees)} paid to ${r.payee.name} (${t.to})`,
    `From: ${r.payer.bankName} · ${r.payer.accountMasked}`,
    t.note ? `Note: ${t.note}` : null,
    `Transaction ID: ${t.id}`,
    new Date(t.createdAt).toLocaleString('en-IN'),
  ].filter(Boolean).join('\n');
}

$('#btn-share-receipt').addEventListener('click', async () => {
  if (!state.lastReceipt) return;
  const text = receiptText(state.lastReceipt);
  try {
    if (navigator.share) await navigator.share({ title: 'Payment receipt', text });
    else { await navigator.clipboard.writeText(text); toast('Receipt copied to clipboard', 'ok'); }
  } catch { /* user dismissed the share sheet */ }
});

$('#btn-receipt-done').addEventListener('click', () => show('screen-home'));

/* ---------------- Search ---------------- */
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

  // Offer to pay a typed UPI ID directly (contains '@', not already a listed person).
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

/* ---------------- Bills & recharges ---------------- */
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

// A category may have several operators — show the list, or skip it if there's one.
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

// "Fetch" the bill for the entered consumer number → show amount due + details.
$('#form-fetch-bill').addEventListener('submit', async (e) => {
  e.preventDefault();
  const consumer = new FormData(e.target).get('consumer').trim();
  try {
    const bill = await api(`/billers/${encodeURIComponent(state.bill.upiId)}/fetch-bill`, {
      method: 'POST',
      body: JSON.stringify({ consumer }),
    });
    state.bill.consumer = consumer;
    $('#bill-due').textContent = rupees(bill.amountRupees);
    $('#bill-consumer').textContent = consumer;
    $('#bill-duedate').textContent = bill.dueDate;
    $('#bill-period').textContent = bill.period;
    $('#form-bill').amount.value = bill.amountRupees;
    await populateBillFrom();
    $('#bill-result').hidden = false;
  } catch (err) {
    toast(err.message, 'err');
  }
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
    showReceipt(result, `Bill paid to ${state.bill.name}`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

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

/* ---------------- Onboarding: step 1 phone → step 2 pick account ---------------- */
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');

// Step navigation across phone → OTP → account picker.
function showOnboardStep(step) {
  $('#onboard-phone').hidden = step !== 'phone';
  $('#onboard-otp').hidden = step !== 'otp';
  $('#onboard-accounts').hidden = step !== 'accounts';
  if (step !== 'otp') stopResendCountdown();
}

// "Resend code" with a countdown so it can't be spammed (mirrors the server rate limit).
function stopResendCountdown() {
  if (state.resendTimer) clearInterval(state.resendTimer);
  state.resendTimer = null;
}
function startResendCountdown(seconds = 30) {
  stopResendCountdown();
  const btn = $('#btn-resend');
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      stopResendCountdown();
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.disabled = true;
      btn.textContent = `Resend code in ${left}s`;
      left -= 1;
    }
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
  try {
    await sendOtpTo(state.pendingPhone, cc, local);
    toast('New code sent', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

// Step 1: enter number → "send" an OTP → show the verify page.
$('#form-phone').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cc = $('#country-code').value;
  const local = new FormData(e.target).get('phone').replace(/\D/g, '');
  if (!local) return toast('Enter a mobile number', 'err');
  const full = cc + local;
  try {
    await sendOtpTo(full, cc, local);
    $('#form-otp').reset();
    showOnboardStep('otp');
  } catch (err) {
    toast(err.message, 'err');
  }
});

// Step 2: verify the code → get a token → fetch and show the accounts.
$('#form-otp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code').trim();
  try {
    const { token } = await api('/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: state.pendingPhone, code }),
    });
    state.otpToken = token;
    localStorage.setItem('upi_token', token);
    const { accounts } = await api(`/accounts?phone=${encodeURIComponent(state.pendingPhone)}`);
    $('#onboard-number').textContent = $('#otp-number').textContent;
    renderAccountPicker(accounts, state.pendingPhone);
    showOnboardStep('accounts');
  } catch (err) {
    toast(err.message, 'err');
  }
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

// Delegate clicks for "Log in" (claimed) and "Link account" (bank-verify flow).
$('#account-list').addEventListener('click', async (e) => {
  const login = e.target.closest('[data-login]');
  const link = e.target.closest('[data-link]');
  try {
    if (login) await loadUser(login.dataset.login);
    else if (link) await startBankLink(link.dataset.link, false);
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ---------------- Bank verification (approve in your bank app) ---------------- */
// Kick off linking an account: ask the bank to verify, then show the approval screen.
async function startBankLink(upiId, fromHome) {
  const res = await api(`/accounts/${encodeURIComponent(upiId)}/verify-request`, {
    method: 'POST',
    body: JSON.stringify({ token: state.otpToken }),
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
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'err');
  }
});

$('#form-bank-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = new FormData(e.target).get('pin');
  try {
    const user = await api(`/accounts/${encodeURIComponent(state.link.upiId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ pin, token: state.otpToken }),
    });
    toast(`Activated ${user.upiId} on ${user.bankName}`, 'ok');
    await loadUser(user.upiId);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-bankverify-back').addEventListener('click', () => {
  if (state.link && state.link.fromHome) show('screen-home');
  else { show('screen-onboard'); showOnboardStep('accounts'); }
});

$('#btn-logout').addEventListener('click', () => {
  clearSession();
  state.user = null;
  state.otpToken = null;
  localStorage.removeItem('upi_token');
  $('#form-phone').reset();
  showOnboardStep('phone');
  show('screen-onboard');
});

$('#btn-refresh').addEventListener('click', () =>
  refreshBalance().then(() => toast('Balance updated', 'ok')).catch((e) => toast(e.message, 'err')),
);

/* ---------------- Multiple banks per profile ---------------- */
// All bank accounts linked to the logged-in phone number.
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
  } catch (err) {
    list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
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
      await startBankLink(link.dataset.link, true); // fromHome
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ---------------- Profile & settings ---------------- */
async function renderProfile() {
  const u = state.user;
  if (!u) return;
  $('#profile-avatar').textContent = initials(u.name);
  $('#profile-avatar').style.background = colorFor(u.name);
  $('#profile-name').textContent = u.name;
  $('#profile-phone').textContent = u.phone;
  $('#profile-bank').textContent = `${u.bankName} · ${u.accountMasked}`;
  $('#profile-upiid').textContent = u.upiId;
  $('#profile-balance').textContent = `₹${rupees(u.balanceRupees)}`;

  const list = $('#profile-accounts');
  list.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const accounts = await myAccounts();
    list.innerHTML = '';
    for (const a of accounts) {
      const active = a.upiId === state.user.upiId;
      const tag = active ? '<span class="acct-tag">Active</span>'
        : a.claimed ? '<span class="acct-tag">Linked</span>'
          : '<span class="acct-sub">Not linked</span>';
      const el = document.createElement('div');
      el.className = 'acct' + (active ? ' active' : '');
      el.innerHTML = `
        <div class="acct-top">
          <span class="acct-bank">${escapeHtml(a.bankName)}</span>
          <span class="acct-bal">₹${rupees(a.balanceRupees)}</span>
        </div>
        <p class="acct-sub">${escapeHtml(a.accountMasked)} · ${escapeHtml(a.upiId)}</p>
        ${tag}`;
      list.appendChild(el);
    }
  } catch (err) { list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

$('#form-change-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const oldPin = f.get('oldPin'), newPin = f.get('newPin'), confirmPin = f.get('confirmPin');
  if (newPin !== confirmPin) return toast('New PINs do not match', 'err');
  if (newPin === oldPin) return toast('New PIN must be different from the current one', 'err');
  try {
    await api(`/users/${encodeURIComponent(state.user.upiId)}/change-pin`, {
      method: 'POST', body: JSON.stringify({ oldPin, newPin }),
    });
    e.target.reset();
    toast('UPI PIN updated', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/* ---------------- Rewards (scratch cards) ---------------- */
async function renderRewards() {
  const grid = $('#rewards-grid');
  const summary = $('#rewards-summary');
  grid.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const { rewards } = await api(`/users/${encodeURIComponent(state.user.upiId)}/rewards`);
    const scratched = rewards.filter((r) => r.scratched);
    const earned = scratched.reduce((s, r) => s + Number(r.rewardRupees || 0), 0);
    const toScratch = rewards.length - scratched.length;
    summary.textContent = rewards.length
      ? `₹${rupees(earned)} earned · ${toScratch} card${toScratch === 1 ? '' : 's'} to scratch`
      : 'No cards yet — make a payment to earn one.';
    grid.innerHTML = '';
    for (const r of rewards) {
      const card = document.createElement('button');
      card.className = 'scratch-card' + (r.scratched ? ' done' : '');
      if (r.scratched) {
        card.disabled = true;
        card.innerHTML = `<span class="sc-reward">₹${rupees(r.rewardRupees)}</span><span class="sc-label">Cashback</span>`;
      } else {
        card.dataset.card = r.id;
        card.innerHTML = `<span class="sc-gift">🎁</span><span class="sc-label">Scratch to reveal</span>`;
      }
      grid.appendChild(card);
    }
  } catch (err) {
    grid.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    summary.textContent = '';
  }
}

$('#rewards-grid').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-card]');
  if (!card) return;
  card.disabled = true;
  try {
    const res = await api(`/rewards/${card.dataset.card}/scratch`, {
      method: 'POST', body: JSON.stringify({ upiId: state.user.upiId }),
    });
    state.user.balanceRupees = res.balanceRupees; // reward credited to balance
    renderHome();
    toast(`You won ₹${rupees(res.rewardRupees)} cashback!`, 'ok');
    renderRewards();
  } catch (err) { toast(err.message, 'err'); card.disabled = false; }
});

/* ---------------- Spending insights ---------------- */
async function renderInsights() {
  try {
    const ins = await api(`/users/${encodeURIComponent(state.user.upiId)}/insights`);
    $('#ins-paid').textContent = rupees(ins.paidRupees);
    $('#ins-received').textContent = rupees(ins.receivedRupees);
    $('#ins-count').textContent = ins.txnCount;

    const months = $('#ins-months');
    months.innerHTML = ins.months.length ? '' : '<p class="empty">No activity yet.</p>';
    const maxPaid = Math.max(1, ...ins.months.map((m) => m.paidRupees));
    for (const m of ins.months) {
      const pct = Math.round((m.paidRupees / maxPaid) * 100);
      const row = document.createElement('div');
      row.className = 'ins-month';
      row.innerHTML = `
        <span class="im-label">${escapeHtml(m.month)}</span>
        <span class="im-bar"><span class="im-fill" style="width:${pct}%"></span></span>
        <span class="im-amt">₹${rupees(m.paidRupees)}</span>`;
      months.appendChild(row);
    }

    const payees = $('#ins-payees');
    payees.innerHTML = ins.topPayees.length ? '' : '<p class="empty">No payments yet.</p>';
    for (const p of ins.topPayees) {
      const isBiller = p.kind === 'biller';
      const icon = isBiller ? (BILL_ICONS[p.category] || '🧾') : initials(p.name);
      const bg = isBiller ? '' : ` style="background:${colorFor(p.name)};color:#fff"`;
      const row = document.createElement('div');
      row.className = 'ins-payee';
      row.innerHTML = `
        <span class="ip-icon"${bg}>${escapeHtml(icon)}</span>
        <span class="ip-text">
          <span class="ip-name">${escapeHtml(p.name)}</span>
          <span class="ip-sub">${p.count} payment${p.count === 1 ? '' : 's'}</span>
        </span>
        <span class="ip-amt">₹${rupees(p.totalRupees)}</span>`;
      payees.appendChild(row);
    }
  } catch (err) {
    $('#ins-months').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------- Split bills (group) ---------------- */
async function renderSplits() {
  const list = $('#splits-list');
  list.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const { splits } = await api(`/users/${encodeURIComponent(state.user.upiId)}/splits`);
    if (!splits.length) {
      list.innerHTML = '<p class="empty">No splits yet. Create one to share a bill.</p>';
      return;
    }
    list.innerHTML = '';
    for (const s of splits) {
      let tag;
      if (s.settled) tag = '<span class="split-tag ok">Settled</span>';
      else if (s.youAreCreator) tag = `<span class="split-tag owed">You're owed ₹${rupees(s.owedToYouRupees)}</span>`;
      else if (s.youOweRupees > 0) tag = `<span class="split-tag owe">You owe ₹${rupees(s.youOweRupees)}</span>`;
      else tag = '<span class="split-tag ok">Settled</span>';
      const el = document.createElement('button');
      el.className = 'split-item';
      el.dataset.split = s.id;
      el.innerHTML = `
        <div class="split-item-top">
          <span class="split-item-desc">${escapeHtml(s.description || 'Split')}</span>
          <span class="split-item-total">₹${rupees(s.totalRupees)}</span>
        </div>
        <div class="split-item-sub">${tag} · ${s.members.length} people</div>`;
      list.appendChild(el);
    }
  } catch (err) { list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

$('#splits-list').addEventListener('click', (e) => {
  const item = e.target.closest('[data-split]');
  if (item) openSplitDetail(item.dataset.split);
});

$('#btn-new-split').addEventListener('click', openNewSplit);

async function openNewSplit() {
  $('#form-split').reset();
  $('#split-preview').textContent = 'Select people and enter an amount.';
  const box = $('#split-members');
  box.innerHTML = '<p class="empty">Loading…</p>';
  show('screen-split-new');
  try {
    const { contacts } = await api(`/contacts?exclude=${encodeURIComponent(state.user.upiId)}`);
    box.innerHTML = '';
    for (const c of contacts) {
      const label = document.createElement('label');
      label.className = 'split-pick';
      label.innerHTML = `<input type="checkbox" value="${escapeAttr(c.upiId)}" />
        <span class="avatar sm" style="background:${colorFor(c.name)}">${escapeHtml(initials(c.name))}</span>
        <span class="split-pick-name">${escapeHtml(c.name)}</span>`;
      box.appendChild(label);
    }
  } catch (err) { box.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`; }
}

function updateSplitPreview() {
  const total = Number($('#form-split').total.value) || 0;
  const checked = $('#split-members').querySelectorAll('input:checked').length;
  const prev = $('#split-preview');
  if (!total || !checked) { prev.textContent = 'Select people and enter an amount.'; return; }
  const n = checked + 1; // you + the people you picked
  prev.textContent = `₹${rupees(total)} split ${n} ways ≈ ₹${rupees(total / n)} each (you + ${checked}).`;
}
$('#form-split').addEventListener('input', updateSplitPreview);

$('#form-split').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const members = [...$('#split-members').querySelectorAll('input:checked')].map((c) => c.value);
  if (!members.length) return toast('Select at least one person to split with', 'err');
  try {
    const split = await api('/splits', {
      method: 'POST',
      body: JSON.stringify({
        creator: state.user.upiId,
        description: f.get('description') || undefined,
        total: Number(f.get('total')),
        members,
      }),
    });
    toast('Split created', 'ok');
    openSplitDetail(split.id);
  } catch (err) { toast(err.message, 'err'); }
});

async function openSplitDetail(id) {
  state.splitId = id;
  show('screen-split-detail');
  await renderSplitDetail();
}

async function renderSplitDetail() {
  try {
    const s = await api(`/splits/${state.splitId}?viewer=${encodeURIComponent(state.user.upiId)}`);
    $('#sd-desc').textContent = s.description || 'Split';
    $('#sd-total').textContent = rupees(s.totalRupees);
    $('#sd-meta').textContent = `Created by ${s.youAreCreator ? 'you' : s.creatorName} · ${s.members.length} people`;

    const banner = $('#sd-banner');
    if (s.settled) { banner.hidden = false; banner.className = 'split-status-banner ok'; banner.textContent = '✓ All settled'; }
    else if (s.youAreCreator) { banner.hidden = false; banner.className = 'split-status-banner owed'; banner.textContent = `You're owed ₹${rupees(s.owedToYouRupees)}`; }
    else if (s.youOweRupees > 0) { banner.hidden = false; banner.className = 'split-status-banner owe'; banner.textContent = `You owe ₹${rupees(s.youOweRupees)}`; }
    else banner.hidden = true;

    const mem = $('#sd-members');
    mem.innerHTML = '';
    for (const m of s.members) {
      const badge = m.status === 'PAID'
        ? `<span class="sd-badge ok">${m.isCreator ? 'Paid bill' : 'Settled'}</span>`
        : '<span class="sd-badge pending">Pending</span>';
      const row = document.createElement('div');
      row.className = 'sd-member';
      row.innerHTML = `
        <span class="avatar sm" style="background:${colorFor(m.name)}">${escapeHtml(initials(m.name))}</span>
        <span class="sd-member-text">
          <span class="sd-member-name">${escapeHtml(m.name)}${m.isYou ? ' (you)' : ''}</span>
          <span class="sd-member-share">₹${rupees(m.shareRupees)}</span>
        </span>
        ${badge}`;
      mem.appendChild(row);
    }

    const you = s.members.find((m) => m.isYou);
    const canPay = you && !s.youAreCreator && you.status === 'PENDING';
    $('#sd-pay').hidden = !canPay;
    if (canPay) {
      $('#sd-owe').textContent = `₹${rupees(you.shareRupees)}`;
      $('#sd-creator').textContent = s.creatorName;
      $('#form-split-pay').reset();
    }
  } catch (err) { toast(err.message, 'err'); }
}

$('#form-split-pay').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = new FormData(e.target).get('pin');
  try {
    const result = await api(`/splits/${state.splitId}/pay`, {
      method: 'POST', body: JSON.stringify({ from: state.user.upiId, pin }),
    });
    state.user = result.payer;
    saveSession(result.payer.upiId);
    renderHome();
    showReceipt(result, 'Split share paid');
  } catch (err) { toast(err.message, 'err'); }
});

// Fill the "Pay from" dropdown with your activated accounts (default = active).
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
    from: f.get('from') || state.user.upiId, // chosen "pay from" account
    amount: Number(f.get('amount')),
    note: f.get('note') || undefined,
    pin: f.get('pin'),
  };
  // Accept either a raw UPI ID or a full upi:// link in the "to" field.
  if (to.startsWith('upi://')) body.upiUri = to;
  else body.to = to;

  try {
    const result = await api('/pay', { method: 'POST', body: JSON.stringify(body) });
    state.user = result.payer; // the account paid from becomes the active one
    saveSession(result.payer.upiId);
    renderHome();
    e.target.reset();
    $('#qr-result') && ($('#qr-result').hidden = true);
    showReceipt(result);
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
    loadRequests();
    showReceipt(result);
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
  state.otpToken = localStorage.getItem('upi_token'); // reuse within its TTL to add banks
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
