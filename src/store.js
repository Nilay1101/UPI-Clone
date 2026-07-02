import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { generateUpiId } from './upi.js';
import { ApiError } from './errors.js';

/**
 * SQLite-backed data store + core payment logic.
 *
 * This is deliberately the ONE place money moves, so the rules (validation,
 * sufficient balance, atomic debit/credit) live in a single, testable spot.
 *
 * Data is persisted with the built-in `node:sqlite` module — a real SQL
 * database in a single file, no separate server and no native dependency.
 *
 *   createStore()                       -> in-memory DB (used by tests: fast,
 *                                          isolated, gone when the process ends)
 *   createStore({ dbPath: 'x.sqlite' }) -> persisted to a file on disk
 *
 * The public interface (createUser / getUser / requireUser / transfer /
 * getTransactions) is unchanged from the original in-memory version, so the
 * rest of the app and the tests don't care that there's now a database here.
 */
export function createStore({ dbPath = ':memory:' } = {}) {
  const db = new DatabaseSync(dbPath);

  // Better durability + concurrency for file-backed databases.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      upi_id       TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      phone        TEXT,
      balance_paise INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           TEXT PRIMARY KEY,
      from_upi     TEXT NOT NULL REFERENCES users(upi_id),
      to_upi       TEXT NOT NULL REFERENCES users(upi_id),
      amount_paise INTEGER NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_txn_from ON transactions(from_upi);
    CREATE INDEX IF NOT EXISTS idx_txn_to   ON transactions(to_upi);
  `);

  // ---- Row <-> domain-object mappers (DB is snake_case, app is camelCase) ----
  const toUser = (row) =>
    row && {
      upiId: row.upi_id,
      name: row.name,
      phone: row.phone,
      balancePaise: row.balance_paise,
      createdAt: row.created_at,
    };

  const toTxn = (row) =>
    row && {
      id: row.id,
      from: row.from_upi,
      to: row.to_upi,
      amountPaise: row.amount_paise,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
    };

  // ---- Prepared statements ----
  const stmts = {
    insertUser: db.prepare(
      `INSERT INTO users (upi_id, name, phone, balance_paise, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getUser: db.prepare(`SELECT * FROM users WHERE upi_id = ?`),
    debit: db.prepare(
      `UPDATE users SET balance_paise = balance_paise - ? WHERE upi_id = ?`,
    ),
    credit: db.prepare(
      `UPDATE users SET balance_paise = balance_paise + ? WHERE upi_id = ?`,
    ),
    insertTxn: db.prepare(
      `INSERT INTO transactions (id, from_upi, to_upi, amount_paise, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    txnsForUser: db.prepare(
      `SELECT * FROM transactions
       WHERE from_upi = ? OR to_upi = ?
       ORDER BY rowid DESC`,
    ),
  };

  /** Run `fn` inside a database transaction; roll back if it throws. */
  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function createUser({ name, phone, openingBalancePaise = 0 }) {
    if (!name || !String(name).trim()) {
      throw new ApiError(400, 'name is required');
    }
    if (!Number.isInteger(openingBalancePaise) || openingBalancePaise < 0) {
      throw new ApiError(400, 'openingBalance must be a non-negative amount');
    }

    let upiId = generateUpiId(name);
    while (stmts.getUser.get(upiId)) upiId = generateUpiId(name);

    const createdAt = new Date().toISOString();
    stmts.insertUser.run(
      upiId,
      String(name).trim(),
      phone ? String(phone) : null,
      openingBalancePaise,
      createdAt,
    );
    return toUser(stmts.getUser.get(upiId));
  }

  function getUser(upiId) {
    return toUser(stmts.getUser.get(upiId)) || null;
  }

  function requireUser(upiId, label) {
    const user = getUser(upiId);
    if (!user) throw new ApiError(404, `${label} '${upiId}' not found`);
    return user;
  }

  /**
   * Move money from one account to another. Validates everything up front,
   * then applies the debit, credit and ledger insert inside a single DB
   * transaction so a balance can never be left half-updated.
   */
  function transfer({ fromUpiId, toUpiId, amountPaise, note }) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new ApiError(400, 'amount must be a positive value');
    }
    if (fromUpiId === toUpiId) {
      throw new ApiError(400, 'cannot transfer to the same account');
    }

    return inTransaction(() => {
      const payer = requireUser(fromUpiId, 'payer');
      requireUser(toUpiId, 'payee');
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
      stmts.insertTxn.run(
        txn.id,
        txn.from,
        txn.to,
        txn.amountPaise,
        txn.note,
        txn.status,
        txn.createdAt,
      );
      return txn;
    });
  }

  /** All transactions this account was a party to, newest first. */
  function getTransactions(upiId) {
    return stmts.txnsForUser.all(upiId, upiId).map(toTxn);
  }

  return { createUser, getUser, requireUser, transfer, getTransactions, db };
}
