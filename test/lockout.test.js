import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStore } from '../src/store.js';

/** Assert `fn` throws an ApiError with the given status (and optional message). */
function throwsStatus(fn, status, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status}`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

function seed(store) {
  const a = store.createUser({ name: 'Payer', pin: '1234', openingBalancePaise: 100000 });
  const b = store.createUser({ name: 'Payee', pin: '4321', openingBalancePaise: 0 });
  return { a, b };
}

test('account locks after the configured number of wrong PINs', () => {
  const store = createStore({ maxPinAttempts: 3 });
  const { a, b } = seed(store);
  const wrong = () =>
    store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '0000' });

  throwsStatus(wrong, 401, /2 attempt\(s\) left/);
  throwsStatus(wrong, 401, /1 attempt\(s\) left/);
  throwsStatus(wrong, 423, /locked/); // third wrong attempt trips the lock

  // Even the CORRECT PIN is now blocked while locked.
  throwsStatus(
    () => store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '1234' }),
    423,
    /locked/,
  );

  // No money moved through any of it.
  assert.equal(store.getUser(a.upiId).balancePaise, 100000);
  assert.equal(store.getUser(b.upiId).balancePaise, 0);
});

test('a correct PIN resets the failed-attempt counter', () => {
  const store = createStore({ maxPinAttempts: 3 });
  const { a, b } = seed(store);

  // Two wrong, then a correct payment.
  throwsStatus(
    () => store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '0000' }),
    401,
  );
  throwsStatus(
    () => store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '0000' }),
    401,
  );
  store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '1234' });

  // Counter is reset: two fresh wrong attempts still don't lock (would need 3).
  throwsStatus(
    () => store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '0000' }),
    401,
    /2 attempt\(s\) left/,
  );
});

test('the lock expires after the cooldown window', async () => {
  const store = createStore({ maxPinAttempts: 2, lockMs: 60 });
  const { a, b } = seed(store);
  const wrong = () =>
    store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 100, pin: '0000' });

  throwsStatus(wrong, 401);
  throwsStatus(wrong, 423, /locked/); // locked now

  await sleep(90); // wait out the 60ms cooldown

  // Correct PIN works again after the lock expires.
  const txn = store.transfer({ fromUpiId: a.upiId, toUpiId: b.upiId, amountPaise: 500, pin: '1234' });
  assert.equal(txn.amountPaise, 500);
  assert.equal(store.getUser(b.upiId).balancePaise, 500);
});
