import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

/** Fresh, isolated app per test. */
function makeApp() {
  return createApp(createStore());
}

async function createUser(app, name, openingBalance) {
  const res = await request(app)
    .post('/users')
    .send({ name, openingBalance })
    .expect(201);
  return res.body;
}

test('health check', async () => {
  const res = await request(makeApp()).get('/health').expect(200);
  assert.equal(res.body.status, 'ok');
});

test('creating a user mints a UPI ID and sets the opening balance', async () => {
  const app = makeApp();
  const user = await createUser(app, 'Nilay', 500);
  assert.match(user.upiId, /@upiclone$/);
  assert.equal(user.balanceRupees, 500);
  assert.equal(user.name, 'Nilay');
});

test('creating a user without a name is rejected', async () => {
  const res = await request(makeApp()).post('/users').send({}).expect(400);
  assert.match(res.body.error, /name is required/);
});

test('QR endpoint returns a upi:// link and a PNG data URL', async () => {
  const app = makeApp();
  const user = await createUser(app, 'Asha', 0);
  const res = await request(app)
    .get(`/users/${user.upiId}/qr`)
    .query({ amount: 250, note: 'Lunch' })
    .expect(200);
  assert.ok(res.body.upiUri.startsWith('upi://pay?'));
  assert.match(res.body.upiUri, /am=250/);
  assert.match(res.body.upiUri, new RegExp(`pa=${encodeURIComponent(user.upiId)}`));
  assert.ok(res.body.qrDataUrl.startsWith('data:image/png;base64,'));
});

test('walking skeleton: two users, generate QR, scan & pay, balances update', async () => {
  const app = makeApp();
  const alice = await createUser(app, 'Alice', 1000);
  const bob = await createUser(app, 'Bob', 100);

  // Bob (payee) shows a QR requesting 300.
  const qr = await request(app)
    .get(`/users/${bob.upiId}/qr`)
    .query({ amount: 300, note: 'Concert ticket' })
    .expect(200);

  // Alice (payer) "scans" it and pays using the encoded link.
  const pay = await request(app)
    .post('/pay')
    .send({ from: alice.upiId, upiUri: qr.body.upiUri })
    .expect(201);

  assert.equal(pay.body.transaction.amountRupees, 300);
  assert.equal(pay.body.transaction.to, bob.upiId);
  assert.equal(pay.body.transaction.note, 'Concert ticket');
  assert.equal(pay.body.payer.balanceRupees, 700);
  assert.equal(pay.body.payee.balanceRupees, 400);

  // History reflects the payment for both parties.
  const aliceTxns = await request(app)
    .get(`/users/${alice.upiId}/transactions`)
    .expect(200);
  assert.equal(aliceTxns.body.transactions.length, 1);
  assert.equal(aliceTxns.body.transactions[0].from, alice.upiId);
});

test('direct pay with explicit to + amount works', async () => {
  const app = makeApp();
  const a = await createUser(app, 'Payer', 50);
  const b = await createUser(app, 'Payee', 0);
  const pay = await request(app)
    .post('/pay')
    .send({ from: a.upiId, to: b.upiId, amount: 20.5 })
    .expect(201);
  assert.equal(pay.body.payer.balanceRupees, 29.5);
  assert.equal(pay.body.payee.balanceRupees, 20.5);
});

test('overspending is rejected and leaves balances untouched', async () => {
  const app = makeApp();
  const a = await createUser(app, 'Broke', 10);
  const b = await createUser(app, 'Rich', 0);
  const res = await request(app)
    .post('/pay')
    .send({ from: a.upiId, to: b.upiId, amount: 999 })
    .expect(422);
  assert.match(res.body.error, /insufficient balance/);

  const after = await request(app).get(`/users/${a.upiId}`).expect(200);
  assert.equal(after.body.balanceRupees, 10);
});

test('paying a non-existent payee returns 404', async () => {
  const app = makeApp();
  const a = await createUser(app, 'Someone', 100);
  const res = await request(app)
    .post('/pay')
    .send({ from: a.upiId, to: 'ghost9999@upiclone', amount: 5 })
    .expect(404);
  assert.match(res.body.error, /payee/);
});

test('non-positive amounts are rejected', async () => {
  const app = makeApp();
  const a = await createUser(app, 'A', 100);
  const b = await createUser(app, 'B', 0);
  await request(app)
    .post('/pay')
    .send({ from: a.upiId, to: b.upiId, amount: 0 })
    .expect(400);
  await request(app)
    .post('/pay')
    .send({ from: a.upiId, to: b.upiId, amount: -5 })
    .expect(400);
});
