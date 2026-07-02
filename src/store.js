import { randomUUID } from 'node:crypto';
import { generateUpiId } from './upi.js';
import { ApiError } from './errors.js';

/**
 * In-memory data store + core payment logic.
 *
 * This is deliberately the ONE place money moves, so the rules (validation,
 * sufficient balance, atomic debit/credit) live in a single, testable spot.
 * It's in-memory for now — every call to `createStore()` yields a fresh,
 * isolated dataset, which keeps tests hermetic. Swapping this for a real
 * database later means reimplementing this same interface; nothing else in
 * the app needs to change.
 */
export function createStore() {
  const users = new Map(); // upiId -> user record
  const transactions = []; // newest first

  function createUser({ name, phone, openingBalancePaise = 0 }) {
    if (!name || !String(name).trim()) {
      throw new ApiError(400, 'name is required');
    }
    if (!Number.isInteger(openingBalancePaise) || openingBalancePaise < 0) {
      throw new ApiError(400, 'openingBalance must be a non-negative amount');
    }

    let upiId = generateUpiId(name);
    while (users.has(upiId)) upiId = generateUpiId(name);

    const user = {
      upiId,
      name: String(name).trim(),
      phone: phone ? String(phone) : null,
      balancePaise: openingBalancePaise,
      createdAt: new Date().toISOString(),
    };
    users.set(upiId, user);
    return user;
  }

  function getUser(upiId) {
    return users.get(upiId) || null;
  }

  function requireUser(upiId, label) {
    const user = users.get(upiId);
    if (!user) throw new ApiError(404, `${label} '${upiId}' not found`);
    return user;
  }

  /**
   * Move money from one account to another. Validates everything up front,
   * then applies the debit and credit together so a balance can never be
   * left half-updated.
   */
  function transfer({ fromUpiId, toUpiId, amountPaise, note }) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new ApiError(400, 'amount must be a positive value');
    }
    if (fromUpiId === toUpiId) {
      throw new ApiError(400, 'cannot transfer to the same account');
    }
    const payer = requireUser(fromUpiId, 'payer');
    const payee = requireUser(toUpiId, 'payee');
    if (payer.balancePaise < amountPaise) {
      throw new ApiError(422, 'insufficient balance');
    }

    payer.balancePaise -= amountPaise;
    payee.balancePaise += amountPaise;

    const txn = {
      id: randomUUID(),
      from: fromUpiId,
      to: toUpiId,
      amountPaise,
      note: note ? String(note) : null,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
    };
    transactions.unshift(txn);
    return txn;
  }

  /** All transactions this account was a party to, newest first. */
  function getTransactions(upiId) {
    return transactions.filter((t) => t.from === upiId || t.to === upiId);
  }

  return { createUser, getUser, requireUser, transfer, getTransactions };
}
