import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const PIN = '1234';
const makeApp = () => createApp(createStore());

const phoneOf = async (app, upiId) =>
  (await request(app).get(`/users/${encodeURIComponent(upiId)}`)).body.phone;

// Complete OTP for a phone and return the verification token.
async function getToken(app, phone) {
  const { devCode } = (await request(app).post('/otp/send').send({ phone }).expect(200)).body;
  const { token } = (await request(app).post('/otp/verify').send({ phone, code: devCode }).expect(200)).body;
  return token;
}

// Claim (activate) a seeded account: verify the phone by OTP, then set a PIN.
async function claim(app, upiId, pin = PIN) {
  const token = await getToken(app, await phoneOf(app, upiId));
  const res = await request(app)
    .post(`/accounts/${encodeURIComponent(upiId)}/claim`)
    .send({ pin, token })
    .expect(201);
  return res.body;
}
const balance = async (app, upiId) =>
  (await request(app).get(`/users/${encodeURIComponent(upiId)}`).expect(200)).body.balanceRupees;

test('health check', async () => {
  const res = await request(makeApp()).get('/health').expect(200);
  assert.equal(res.body.status, 'ok');
});

test('GET /banks lists the dummy banks', async () => {
  const res = await request(makeApp()).get('/banks').expect(200);
  const names = res.body.banks.map((b) => b.name).sort();
  assert.deepEqual(names, ['Emirates NBD', 'HDFC Bank', 'State Bank of India']);
});

test('GET /accounts?phone finds the bank accounts linked to that number', async () => {
  const res = await request(makeApp()).get('/accounts').query({ phone: '+919810000001' }).expect(200);
  assert.equal(res.body.accounts.length, 2); // Ravi has HDFC + SBI
  assert.deepEqual(res.body.accounts.map((a) => a.upiId).sort(), ['ravi@hdfc', 'ravi@sbi']);
  assert.equal(res.body.accounts.every((a) => a.claimed === false), true);
  assert.ok(res.body.accounts[0].accountMasked.startsWith('••••'));
});

test('GET /accounts?phone finds a UAE (Emirates NBD) account', async () => {
  const res = await request(makeApp()).get('/accounts').query({ phone: '+971501234567' }).expect(200);
  assert.deepEqual(res.body.accounts.map((a) => a.upiId), ['sara@enbd']);
  assert.equal(res.body.accounts[0].bankName, 'Emirates NBD');
});

test('a phone with no accounts returns an empty list', async () => {
  const res = await request(makeApp()).get('/accounts').query({ phone: '9999999999' }).expect(200);
  assert.equal(res.body.accounts.length, 0);
});

test('claiming an account sets it up and keeps its bank balance', async () => {
  const app = makeApp();
  const user = await claim(app, 'ravi@hdfc');
  assert.equal(user.upiId, 'ravi@hdfc');
  assert.equal(user.name, 'Ravi Kumar');
  assert.equal(user.bankName, 'HDFC Bank');
  assert.equal(user.balanceRupees, 5000);
  assert.equal(user.claimed, true);
  assert.equal(user.pin, undefined);
  assert.equal(user.pin_hash, undefined);
});

test('OTP: send returns a 6-digit code, verify issues a token', async () => {
  const app = makeApp();
  const send = await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(200);
  assert.match(send.body.devCode, /^\d{6}$/);
  const verify = await request(app)
    .post('/otp/verify')
    .send({ phone: '+919810000001', code: send.body.devCode })
    .expect(200);
  assert.ok(verify.body.token);
});

test('OTP: a wrong code is rejected', async () => {
  const app = makeApp();
  await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(200);
  const res = await request(app)
    .post('/otp/verify')
    .send({ phone: '+919810000001', code: '000000' })
    .expect(401);
  assert.match(res.body.error, /incorrect code/);
});

test('claiming without OTP verification is rejected', async () => {
  const app = makeApp();
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: PIN }).expect(401);
  assert.match(res.body.error, /not verified/);
  // A token for a DIFFERENT phone must not work either.
  const otherToken = await getToken(app, '+919820000002'); // Priya's phone
  await request(app)
    .post('/accounts/ravi@hdfc/claim')
    .send({ pin: PIN, token: otherToken })
    .expect(401);
});

test('claiming requires a valid 4-6 digit PIN', async () => {
  const app = makeApp();
  const token = await getToken(app, '+919810000001');
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: '12', token }).expect(400);
  assert.match(res.body.error, /pin must be 4 to 6 digits/);
});

test('an already-claimed account cannot be claimed again', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const token = await getToken(app, '+919810000001');
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: '5555', token }).expect(409);
  assert.match(res.body.error, /already set up/);
});

test('QR endpoint returns a upi:// link and PNG for an account', async () => {
  const app = makeApp();
  const res = await request(app).get('/users/priya@hdfc/qr').query({ amount: 250, note: 'Lunch' }).expect(200);
  assert.ok(res.body.upiUri.startsWith('upi://pay?'));
  assert.match(res.body.upiUri, /am=250/);
  assert.match(res.body.upiUri, /pa=priya%40hdfc/);
  assert.ok(res.body.qrDataUrl.startsWith('data:image/png;base64,'));
});

test('walking skeleton: claim an account, pay another, balances update', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // payer (5000)
  const pay = await request(app)
    .post('/pay')
    .send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 300, note: 'Movie', pin: PIN })
    .expect(201);
  assert.equal(pay.body.transaction.amountRupees, 300);
  assert.equal(pay.body.payer.balanceRupees, 4700); // Ravi HDFC
  assert.equal(pay.body.payee.balanceRupees, 8300); // Priya HDFC (received without claiming)
});

test('paying from an un-activated (unclaimed) account is rejected', async () => {
  const app = makeApp();
  // ravi@sbi has never been claimed -> no PIN set.
  const res = await request(app)
    .post('/pay')
    .send({ from: 'ravi@sbi', to: 'priya@sbi', amount: 100, pin: PIN })
    .expect(403);
  assert.match(res.body.error, /not activated/);
  assert.equal(await balance(app, 'ravi@sbi'), 3000);
});

test('a wrong PIN is rejected and moves no money', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const res = await request(app)
    .post('/pay')
    .send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: '9999' })
    .expect(401);
  assert.match(res.body.error, /incorrect PIN/);
  assert.equal(await balance(app, 'ravi@hdfc'), 5000);
  assert.equal(await balance(app, 'priya@hdfc'), 8000);
});

test('the PIN/hash is never returned in a user response', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc', '4321');
  const res = await request(app).get('/users/ravi@hdfc').expect(200);
  assert.equal(res.body.pin, undefined);
  assert.equal(res.body.pin_hash, undefined);
});

test('overspending is rejected and leaves balances untouched', async () => {
  const app = makeApp();
  await claim(app, 'ravi@sbi'); // 3000
  const res = await request(app)
    .post('/pay')
    .send({ from: 'ravi@sbi', to: 'priya@sbi', amount: 999999, pin: PIN })
    .expect(422);
  assert.match(res.body.error, /insufficient balance/);
  assert.equal(await balance(app, 'ravi@sbi'), 3000);
});

test('paying a non-existent payee returns 404', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const res = await request(app)
    .post('/pay')
    .send({ from: 'ravi@hdfc', to: 'ghost@nowhere', amount: 5, pin: PIN })
    .expect(404);
  assert.match(res.body.error, /payee/);
});

test('non-positive amounts are rejected', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 0, pin: PIN }).expect(400);
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: -5, pin: PIN }).expect(400);
});
