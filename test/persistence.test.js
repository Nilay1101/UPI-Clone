import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upi-')), 'test.sqlite');
}

test('data persists across store instances (simulated restart)', () => {
  const dbPath = tmpDbPath();

  // First run: claim an account and make a payment.
  let store = createStore({ dbPath });
  store.claimAccount('ravi@hdfc', '1234'); // 5000.00 -> 500000 paise
  store.transfer({ fromUpiId: 'ravi@hdfc', toUpiId: 'priya@hdfc', amountPaise: 30000, note: 'Rent', pin: '1234' });
  store.db.close();

  // Second run: reopen the same file. Everything should still be there.
  store = createStore({ dbPath });
  assert.equal(store.getUser('ravi@hdfc').balancePaise, 470000);
  assert.equal(store.getUser('priya@hdfc').balancePaise, 830000);
  assert.equal(store.getUser('ravi@hdfc').claimed, true); // activation persisted
  const txns = store.getTransactions('priya@hdfc');
  assert.equal(txns.length, 1);
  assert.equal(txns[0].note, 'Rent');
  store.db.close();

  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('a failed (over-balance) transfer rolls back and persists nothing', () => {
  const dbPath = tmpDbPath();
  let store = createStore({ dbPath });
  store.claimAccount('ravi@sbi', '1234'); // 3000.00
  assert.throws(
    () => store.transfer({ fromUpiId: 'ravi@sbi', toUpiId: 'priya@sbi', amountPaise: 99999999, pin: '1234' }),
    /insufficient balance/,
  );
  store.db.close();

  store = createStore({ dbPath });
  assert.equal(store.getUser('ravi@sbi').balancePaise, 300000);
  assert.equal(store.getUser('priya@sbi').balancePaise, 200000);
  assert.equal(store.getTransactions('ravi@sbi').length, 0);
  store.db.close();

  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('seed data is only inserted once (no duplicate banks on reopen)', () => {
  const dbPath = tmpDbPath();
  let store = createStore({ dbPath });
  assert.equal(store.getBanks().length, 3);
  store.db.close();
  store = createStore({ dbPath });
  assert.equal(store.getBanks().length, 3); // not 6
  store.db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
