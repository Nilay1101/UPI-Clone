import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStore } from '../src/store.js';

function throwsStatus(fn, status, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

// Claim the payer account so it can pay; return payer/payee UPI IDs.
function seed(store) {
  store.claimAccount('ravi@hdfc', '1234');
  return { a: 'ravi@hdfc', b: 'priya@hdfc' };
}

test('account locks after the configured number of wrong PINs', () => {
  const store = createStore({ maxPinAttempts: 3 });
  const { a, b } = seed(store);
  const wrong = () => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '0000' });

  throwsStatus(wrong, 401, /2 attempt\(s\) left/);
  throwsStatus(wrong, 401, /1 attempt\(s\) left/);
  throwsStatus(wrong, 423, /locked/);

  // Even the CORRECT PIN is blocked while locked.
  throwsStatus(() => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '1234' }), 423, /locked/);

  // No money moved.
  assert.equal(store.getUser(a).balancePaise, 500000);
  assert.equal(store.getUser(b).balancePaise, 800000);
});

test('a correct PIN resets the failed-attempt counter', () => {
  const store = createStore({ maxPinAttempts: 3 });
  const { a, b } = seed(store);
  throwsStatus(() => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '0000' }), 401);
  throwsStatus(() => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '0000' }), 401);
  store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '1234' }); // correct -> resets
  throwsStatus(() => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '0000' }), 401, /2 attempt\(s\) left/);
});

test('the lock expires after the cooldown window', async () => {
  const store = createStore({ maxPinAttempts: 2, lockMs: 60 });
  const { a, b } = seed(store);
  const wrong = () => store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 100, pin: '0000' });
  throwsStatus(wrong, 401);
  throwsStatus(wrong, 423, /locked/);

  await sleep(90);

  const txn = store.transfer({ fromUpiId: a, toUpiId: b, amountPaise: 500, pin: '1234' });
  assert.equal(txn.amountPaise, 500);
  assert.equal(store.getUser(b).balancePaise, 800500);
});
