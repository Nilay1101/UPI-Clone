import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

/** A throwaway db file path under the OS temp dir. */
function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upi-')), 'test.sqlite');
}

test('data persists across store instances (simulated restart)', () => {
  const dbPath = tmpDbPath();

  // First "run": create two users and make a payment.
  let store = createStore({ dbPath });
  const alice = store.createUser({ name: 'Alice', pin: '1234', openingBalancePaise: 100000 });
  const bob = store.createUser({ name: 'Bob', pin: '5678', openingBalancePaise: 0 });
  store.transfer({
    fromUpiId: alice.upiId,
    toUpiId: bob.upiId,
    amountPaise: 30000,
    note: 'Rent',
    pin: '1234',
  });
  store.db.close();

  // Second "run": reopen the same file. Everything should still be there.
  store = createStore({ dbPath });
  assert.equal(store.getUser(alice.upiId).balancePaise, 70000);
  assert.equal(store.getUser(bob.upiId).balancePaise, 30000);
  const txns = store.getTransactions(bob.upiId);
  assert.equal(txns.length, 1);
  assert.equal(txns[0].note, 'Rent');
  assert.equal(txns[0].amountPaise, 30000);
  store.db.close();

  // Clean up.
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('a failed (over-balance) transfer rolls back and persists nothing', () => {
  const dbPath = tmpDbPath();
  let store = createStore({ dbPath });
  const a = store.createUser({ name: 'A', pin: '1234', openingBalancePaise: 500 });
  const b = store.createUser({ name: 'B', pin: '1234', openingBalancePaise: 0 });
  assert.throws(
    () =>
      store.transfer({
        fromUpiId: a.upiId,
        toUpiId: b.upiId,
        amountPaise: 999999,
        pin: '1234',
      }),
    /insufficient balance/,
  );
  store.db.close();

  store = createStore({ dbPath });
  assert.equal(store.getUser(a.upiId).balancePaise, 500);
  assert.equal(store.getUser(b.upiId).balancePaise, 0);
  assert.equal(store.getTransactions(a.upiId).length, 0);
  store.db.close();

  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
