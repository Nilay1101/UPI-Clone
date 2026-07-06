import { randomUUID, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPin, verifyPin } from './pin.js';
import { ApiError } from './errors.js';

// One-time-password / verification-token policy (all in-memory + ephemeral).
const OTP_TTL_MS = 5 * 60 * 1000; // a code is valid for 5 minutes
const SESSION_TTL_MS = 30 * 60 * 1000; // a verification token lasts 30 minutes
const OTP_MAX_ATTEMPTS = 5;

/**
 * SQLite-backed data store + core payment logic.
 *
 * GPay-style model: money lives in **bank accounts**. Each bank account has a
 * UPI ID (VPA), a phone number, a holder, and a balance. You sign up by phone
 * number — the app finds the accounts linked to that number, you pick one and
 * set a UPI PIN ("claim" it), and payments draw from that bank account.
 *
 *   createStore()                       -> in-memory DB (tests: fast, isolated)
 *   createStore({ dbPath: 'x.sqlite' }) -> persisted to a file on disk
 *
 * The store is the ONE place money moves, so validation, PIN/lockout and the
 * atomic debit/credit all live here.
 */

const SEED_BANKS = [
  { id: 'hdfc', name: 'HDFC Bank', ifsc: 'HDFC0001' },
  { id: 'sbi', name: 'State Bank of India', ifsc: 'SBIN0001' },
  { id: 'enbd', name: 'Emirates NBD', ifsc: 'EBILAEAD' },
];

// Phone numbers are stored in full international form (country code + number).
// India (+91): Ravi & Priya each hold an account in both HDFC and SBI.
// UAE (+971): Sara & Omar bank with Emirates NBD.
const SEED_ACCOUNTS = [
  { upiId: 'ravi@hdfc', bankId: 'hdfc', accountNumber: '1001', holderName: 'Ravi Kumar', phone: '+919810000001', balancePaise: 500000 },
  { upiId: 'ravi@sbi', bankId: 'sbi', accountNumber: '2001', holderName: 'Ravi Kumar', phone: '+919810000001', balancePaise: 300000 },
  { upiId: 'priya@hdfc', bankId: 'hdfc', accountNumber: '1002', holderName: 'Priya Shah', phone: '+919820000002', balancePaise: 800000 },
  { upiId: 'priya@sbi', bankId: 'sbi', accountNumber: '2002', holderName: 'Priya Shah', phone: '+919820000002', balancePaise: 200000 },
  { upiId: 'sara@enbd', bankId: 'enbd', accountNumber: '3001', holderName: 'Sara Ali', phone: '+971501234567', balancePaise: 1000000 },
  { upiId: 'omar@enbd', bankId: 'enbd', accountNumber: '3002', holderName: 'Omar Khan', phone: '+971509876543', balancePaise: 700000 },
];

export function createStore({
  dbPath = ':memory:',
  maxPinAttempts = 3,
  lockMs = 15 * 60 * 1000, // 15 minutes
  seed = true,
} = {}) {
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS banks (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ifsc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      upi_id         TEXT PRIMARY KEY,
      bank_id        TEXT NOT NULL REFERENCES banks(id),
      account_number TEXT NOT NULL,
      holder_name    TEXT NOT NULL,
      phone          TEXT NOT NULL,
      balance_paise  INTEGER NOT NULL DEFAULT 0,
      pin_hash       TEXT,
      failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   TEXT,
      claimed        INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acct_phone ON accounts(phone);

    CREATE TABLE IF NOT EXISTS transactions (
      id           TEXT PRIMARY KEY,
      from_upi     TEXT NOT NULL REFERENCES accounts(upi_id),
      to_upi       TEXT NOT NULL REFERENCES accounts(upi_id),
      amount_paise INTEGER NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_txn_from ON transactions(from_upi);
    CREATE INDEX IF NOT EXISTS idx_txn_to   ON transactions(to_upi);

    CREATE TABLE IF NOT EXISTS payment_requests (
      id           TEXT PRIMARY KEY,
      from_upi     TEXT NOT NULL REFERENCES accounts(upi_id),
      to_upi       TEXT NOT NULL REFERENCES accounts(upi_id),
      amount_paise INTEGER NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'PENDING',
      txn_id       TEXT,
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_from ON payment_requests(from_upi);
    CREATE INDEX IF NOT EXISTS idx_req_to   ON payment_requests(to_upi);
  `);

  // Seed the dummy banks + accounts once (only into an empty DB).
  if (seed && db.prepare('SELECT COUNT(*) AS c FROM banks').get().c === 0) {
    const insBank = db.prepare('INSERT INTO banks (id, name, ifsc) VALUES (?, ?, ?)');
    for (const b of SEED_BANKS) insBank.run(b.id, b.name, b.ifsc);
    const now = new Date().toISOString();
    const insAcct = db.prepare(
      `INSERT INTO accounts (upi_id, bank_id, account_number, holder_name, phone, balance_paise, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of SEED_ACCOUNTS) {
      insAcct.run(a.upiId, a.bankId, a.accountNumber, a.holderName, a.phone, a.balancePaise, now);
    }
  }

  // Ephemeral OTP + verification-token state (not persisted — auth is transient).
  const otps = new Map(); // phone -> { code, expiresAt, attempts }
  const sessions = new Map(); // token -> { phone, expiresAt }

  // ---- Mappers (DB snake_case -> app camelCase) ----
  const toAccount = (row) =>
    row && {
      upiId: row.upi_id,
      bankId: row.bank_id,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      holderName: row.holder_name,
      phone: row.phone,
      balancePaise: row.balance_paise,
      claimed: !!row.claimed,
      createdAt: row.created_at,
    };

  const toTxn = (row) =>
    row && {
      id: row.id, from: row.from_upi, to: row.to_upi,
      amountPaise: row.amount_paise, note: row.note, status: row.status, createdAt: row.created_at,
    };

  const toRequest = (row) =>
    row && {
      id: row.id, from: row.from_upi, to: row.to_upi,
      amountPaise: row.amount_paise, note: row.note, status: row.status,
      txnId: row.txn_id, createdAt: row.created_at, resolvedAt: row.resolved_at,
    };

  const ACCOUNT_SELECT = `
    SELECT a.*, b.name AS bank_name FROM accounts a JOIN banks b ON b.id = a.bank_id`;

  const stmts = {
    banks: db.prepare('SELECT * FROM banks ORDER BY name'),
    accountsByPhone: db.prepare(`${ACCOUNT_SELECT} WHERE a.phone = ? ORDER BY b.name`),
    getAccount: db.prepare(`${ACCOUNT_SELECT} WHERE a.upi_id = ?`),
    insertAccount: db.prepare(
      `INSERT INTO accounts (upi_id, bank_id, account_number, holder_name, phone, balance_paise, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    claim: db.prepare(
      `UPDATE accounts SET pin_hash = ?, claimed = 1, failed_pin_attempts = 0, locked_until = NULL WHERE upi_id = ?`,
    ),
    getAuth: db.prepare(
      `SELECT pin_hash, failed_pin_attempts, locked_until FROM accounts WHERE upi_id = ?`,
    ),
    resetPinFailures: db.prepare(
      `UPDATE accounts SET failed_pin_attempts = 0, locked_until = NULL WHERE upi_id = ?`,
    ),
    setPinAttempts: db.prepare(`UPDATE accounts SET failed_pin_attempts = ? WHERE upi_id = ?`),
    setPinLock: db.prepare(`UPDATE accounts SET failed_pin_attempts = ?, locked_until = ? WHERE upi_id = ?`),
    debit: db.prepare('UPDATE accounts SET balance_paise = balance_paise - ? WHERE upi_id = ?'),
    credit: db.prepare('UPDATE accounts SET balance_paise = balance_paise + ? WHERE upi_id = ?'),
    insertTxn: db.prepare(
      `INSERT INTO transactions (id, from_upi, to_upi, amount_paise, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    txnsForUser: db.prepare(
      `SELECT * FROM transactions WHERE from_upi = ? OR to_upi = ? ORDER BY rowid DESC`,
    ),
    insertRequest: db.prepare(
      `INSERT INTO payment_requests (id, from_upi, to_upi, amount_paise, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
    ),
    getRequest: db.prepare('SELECT * FROM payment_requests WHERE id = ?'),
    requestsIncoming: db.prepare('SELECT * FROM payment_requests WHERE to_upi = ? ORDER BY rowid DESC'),
    requestsOutgoing: db.prepare('SELECT * FROM payment_requests WHERE from_upi = ? ORDER BY rowid DESC'),
    resolveRequest: db.prepare(
      'UPDATE payment_requests SET status = ?, txn_id = ?, resolved_at = ? WHERE id = ?',
    ),
  };

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------------- Phone OTP verification ---------------- */

  /**
   * "Send" a one-time code to a phone number. There is no real SMS gateway —
   * this generates + stores a 6-digit code and returns it so the simulation can
   * display it. In production the code would be texted, not returned.
   */
  function sendOtp(phone) {
    const p = String(phone || '').trim();
    if (!p) throw new ApiError(400, 'phone is required');
    const code = String(randomInt(100000, 1000000)); // 6 digits
    otps.set(p, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    return { phone: p, code };
  }

  /** Verify a code for a phone; on success mint a short-lived token. */
  function verifyOtp(phone, code) {
    const p = String(phone || '').trim();
    const rec = otps.get(p);
    if (!rec || rec.expiresAt < Date.now()) {
      throw new ApiError(410, 'code expired; request a new one');
    }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      otps.delete(p);
      throw new ApiError(429, 'too many attempts; request a new code');
    }
    if (String(code) !== rec.code) {
      rec.attempts += 1;
      throw new ApiError(401, 'incorrect code');
    }
    otps.delete(p);
    const token = randomUUID();
    sessions.set(token, { phone: p, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token };
  }

  /** The verified phone for a token, or null if missing/expired. */
  function sessionPhone(token) {
    const s = sessions.get(token);
    if (!s || s.expiresAt < Date.now()) return null;
    return s.phone;
  }

  /* ---------------- Banks & accounts ---------------- */

  function getBanks() {
    return stmts.banks.all();
  }

  function getBank(id) {
    return getBanks().find((b) => b.id === id) || null;
  }

  /** Accounts linked to a phone number (for sign-up / login). */
  function getAccountsByPhone(phone) {
    return stmts.accountsByPhone.all(String(phone || '')).map(toAccount);
  }

  function getUser(upiId) {
    return toAccount(stmts.getAccount.get(upiId)) || null;
  }

  function requireUser(upiId, label) {
    const u = getUser(upiId);
    if (!u) throw new ApiError(404, `${label} '${upiId}' not found`);
    return u;
  }

  /**
   * "Claim" a bank account: set its UPI PIN and mark it active. This is how a
   * user signs up — after this they can pay from the account.
   */
  function claimAccount(upiId, pin) {
    const account = requireUser(upiId, 'account');
    if (account.claimed) {
      throw new ApiError(409, 'this account is already set up; just log in');
    }
    const pinHash = hashPin(pin); // validates 4-6 digits
    stmts.claim.run(pinHash, upiId);
    return getUser(upiId);
  }

  /** Test/helper: add an extra bank account (unclaimed). */
  function addAccount({ upiId, bankId, accountNumber, holderName, phone, balancePaise = 0 }) {
    if (!getBank(bankId)) throw new ApiError(400, `unknown bank '${bankId}'`);
    if (!Number.isInteger(balancePaise) || balancePaise < 0) {
      throw new ApiError(400, 'balance must be a non-negative amount');
    }
    stmts.insertAccount.run(
      upiId, bankId, String(accountNumber), String(holderName), String(phone),
      balancePaise, new Date().toISOString(),
    );
    return getUser(upiId);
  }

  /* ---------------- PIN authorisation + lockout ---------------- */

  function authorizePin(upiId, pin) {
    const auth = stmts.getAuth.get(upiId);
    if (!auth.pin_hash) {
      throw new ApiError(403, 'this account is not activated; set a UPI PIN first');
    }

    const now = new Date();
    if (auth.locked_until) {
      const until = new Date(auth.locked_until);
      if (until > now) {
        const mins = Math.ceil((until - now) / 60000);
        throw new ApiError(423, `account locked after too many wrong PIN attempts; try again in ${mins} minute(s)`);
      }
      stmts.resetPinFailures.run(upiId);
      auth.failed_pin_attempts = 0;
    }

    if (verifyPin(pin, auth.pin_hash)) {
      if (auth.failed_pin_attempts) stmts.resetPinFailures.run(upiId);
      return;
    }

    const attempts = auth.failed_pin_attempts + 1;
    if (attempts >= maxPinAttempts) {
      const lockedUntil = new Date(now.getTime() + lockMs).toISOString();
      stmts.setPinLock.run(attempts, lockedUntil, upiId);
      throw new ApiError(423, `too many wrong PIN attempts; account locked for ${Math.round(lockMs / 60000)} minute(s)`);
    }
    stmts.setPinAttempts.run(attempts, upiId);
    throw new ApiError(401, `incorrect PIN; ${maxPinAttempts - attempts} attempt(s) left before lockout`);
  }

  /* ---------------- Money movement ---------------- */

  function transfer({ fromUpiId, toUpiId, amountPaise, note, pin }) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new ApiError(400, 'amount must be a positive value');
    }
    if (fromUpiId === toUpiId) {
      throw new ApiError(400, 'cannot transfer to the same account');
    }

    requireUser(fromUpiId, 'payer');
    requireUser(toUpiId, 'payee');
    authorizePin(fromUpiId, pin); // persists its own bookkeeping outside the txn

    return inTransaction(() => {
      const payer = requireUser(fromUpiId, 'payer');
      if (payer.balancePaise < amountPaise) {
        throw new ApiError(422, 'insufficient balance');
      }
      stmts.debit.run(amountPaise, fromUpiId);
      stmts.credit.run(amountPaise, toUpiId);

      const txn = {
        id: randomUUID(),
        from: fromUpiId,
        to: toUpiId,
        amountPaise,
        note: note ? String(note) : null,
        status: 'SUCCESS',
        createdAt: new Date().toISOString(),
      };
      stmts.insertTxn.run(txn.id, txn.from, txn.to, txn.amountPaise, txn.note, txn.status, txn.createdAt);
      return txn;
    });
  }

  function getTransactions(upiId) {
    return stmts.txnsForUser.all(upiId, upiId).map(toTxn);
  }

  /* ---------------- Money requests ("collect") ---------------- */

  function createRequest({ fromUpiId, toUpiId, amountPaise, note }) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new ApiError(400, 'amount must be a positive value');
    }
    if (fromUpiId === toUpiId) {
      throw new ApiError(400, 'cannot request money from yourself');
    }
    requireUser(fromUpiId, 'requester');
    requireUser(toUpiId, 'payer');

    const req = {
      id: randomUUID(), from: fromUpiId, to: toUpiId, amountPaise,
      note: note ? String(note) : null, status: 'PENDING', createdAt: new Date().toISOString(),
    };
    stmts.insertRequest.run(req.id, req.from, req.to, req.amountPaise, req.note, req.createdAt);
    return toRequest(stmts.getRequest.get(req.id));
  }

  function getRequest(id) {
    return toRequest(stmts.getRequest.get(id)) || null;
  }

  function getRequestsForUser(upiId) {
    return {
      incoming: stmts.requestsIncoming.all(upiId).map(toRequest),
      outgoing: stmts.requestsOutgoing.all(upiId).map(toRequest),
    };
  }

  function approveRequest(id, pin) {
    const req = stmts.getRequest.get(id);
    if (!req) throw new ApiError(404, `request '${id}' not found`);
    if (req.status !== 'PENDING') {
      throw new ApiError(409, `request already ${req.status.toLowerCase()}`);
    }
    const txn = transfer({
      fromUpiId: req.to_upi, toUpiId: req.from_upi,
      amountPaise: req.amount_paise, note: req.note, pin,
    });
    stmts.resolveRequest.run('APPROVED', txn.id, new Date().toISOString(), id);
    return { request: toRequest(stmts.getRequest.get(id)), transaction: txn };
  }

  function declineRequest(id) {
    const req = stmts.getRequest.get(id);
    if (!req) throw new ApiError(404, `request '${id}' not found`);
    if (req.status !== 'PENDING') {
      throw new ApiError(409, `request already ${req.status.toLowerCase()}`);
    }
    stmts.resolveRequest.run('DECLINED', null, new Date().toISOString(), id);
    return toRequest(stmts.getRequest.get(id));
  }

  return {
    sendOtp, verifyOtp, sessionPhone,
    getBanks, getBank, getAccountsByPhone, getUser, requireUser, claimAccount, addAccount,
    transfer, getTransactions,
    createRequest, getRequest, getRequestsForUser, approveRequest, declineRequest,
    db,
  };
}
