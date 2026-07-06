import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const PIN = '1234';
const makeApp = () => createApp(createStore());

async function claim(app, upiId, pin = PIN) {
  const phone = (await request(app).get(`/users/${encodeURIComponent(upiId)}`)).body.phone;
  const { devCode } = (await request(app).post('/otp/send').send({ phone })).body;
  const { token } = (await request(app).post('/otp/verify').send({ phone, code: devCode })).body;
  const { requestId } = (await request(app).post(`/accounts/${encodeURIComponent(upiId)}/verify-request`).send({ token })).body;
  await request(app).post(`/bank/verify/${requestId}/approve`).expect(200);
  await request(app).post(`/accounts/${encodeURIComponent(upiId)}/claim`).send({ pin, token }).expect(201);
}
const balance = async (app, upiId) =>
  (await request(app).get(`/users/${encodeURIComponent(upiId)}`).expect(200)).body.balanceRupees;

test('request-money happy path: create, appears incoming/outgoing, approve pays', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // payer (5000)

  // Priya requests ₹250 from Ravi.
  const req = await request(app)
    .post('/requests')
    .send({ from: 'priya@hdfc', to: 'ravi@hdfc', amount: 250, note: 'Movie' })
    .expect(201);
  assert.equal(req.body.status, 'PENDING');

  const raviReqs = await request(app).get('/users/ravi@hdfc/requests').expect(200);
  assert.equal(raviReqs.body.incoming.length, 1);
  assert.equal(raviReqs.body.incoming[0].from, 'priya@hdfc');
  const priyaReqs = await request(app).get('/users/priya@hdfc/requests').expect(200);
  assert.equal(priyaReqs.body.outgoing.length, 1);

  // Ravi approves with his PIN.
  const approve = await request(app)
    .post(`/requests/${req.body.id}/approve`)
    .send({ pin: PIN })
    .expect(201);
  assert.equal(approve.body.request.status, 'APPROVED');
  assert.equal(approve.body.payer.balanceRupees, 4750); // Ravi
  assert.equal(approve.body.payee.balanceRupees, 8250); // Priya
  assert.ok(approve.body.request.txnId);
});

test('approving with a wrong PIN keeps the request pending and moves no money', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const req = await request(app)
    .post('/requests')
    .send({ from: 'priya@hdfc', to: 'ravi@hdfc', amount: 100 })
    .expect(201);
  await request(app).post(`/requests/${req.body.id}/approve`).send({ pin: '0000' }).expect(401);

  const raviReqs = await request(app).get('/users/ravi@hdfc/requests').expect(200);
  assert.equal(raviReqs.body.incoming[0].status, 'PENDING');
  assert.equal(await balance(app, 'ravi@hdfc'), 5000);
  assert.equal(await balance(app, 'priya@hdfc'), 8000);
});

test('approving with insufficient balance keeps the request pending', async () => {
  const app = makeApp();
  await claim(app, 'ravi@sbi'); // 3000
  const req = await request(app)
    .post('/requests')
    .send({ from: 'priya@sbi', to: 'ravi@sbi', amount: 5000 })
    .expect(201);
  await request(app).post(`/requests/${req.body.id}/approve`).send({ pin: PIN }).expect(422);
  const reqs = await request(app).get('/users/ravi@sbi/requests').expect(200);
  assert.equal(reqs.body.incoming[0].status, 'PENDING');
});

test('a declined request cannot be approved', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const req = await request(app)
    .post('/requests')
    .send({ from: 'priya@hdfc', to: 'ravi@hdfc', amount: 100 })
    .expect(201);
  const declined = await request(app).post(`/requests/${req.body.id}/decline`).expect(200);
  assert.equal(declined.body.status, 'DECLINED');
  const res = await request(app).post(`/requests/${req.body.id}/approve`).send({ pin: PIN }).expect(409);
  assert.match(res.body.error, /already declined/);
  assert.equal(await balance(app, 'ravi@hdfc'), 5000);
});

test('cannot request money from yourself', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/requests')
    .send({ from: 'ravi@hdfc', to: 'ravi@hdfc', amount: 10 })
    .expect(400);
  assert.match(res.body.error, /yourself/);
});

test('approving a non-existent request returns 404', async () => {
  const app = makeApp();
  const res = await request(app).post('/requests/does-not-exist/approve').send({ pin: PIN }).expect(404);
  assert.match(res.body.error, /not found/);
});
