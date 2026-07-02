import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const PIN = '1234';
const makeApp = () => createApp(createStore());

async function createUser(app, name, openingBalance, pin = PIN) {
  const res = await request(app).post('/users').send({ name, openingBalance, pin }).expect(201);
  return res.body;
}

test('request-money happy path: create, appears incoming/outgoing, approve pays', async () => {
  const app = makeApp();
  const alice = await createUser(app, 'Alice', 0); // requester (will be paid)
  const bob = await createUser(app, 'Bob', 1000); // payer

  // Alice requests ₹250 from Bob.
  const req = await request(app)
    .post('/requests')
    .send({ from: alice.upiId, to: bob.upiId, amount: 250, note: 'Movie' })
    .expect(201);
  assert.equal(req.body.status, 'PENDING');
  assert.equal(req.body.amountRupees, 250);

  // Bob sees it incoming; Alice sees it outgoing.
  const bobReqs = await request(app).get(`/users/${bob.upiId}/requests`).expect(200);
  assert.equal(bobReqs.body.incoming.length, 1);
  assert.equal(bobReqs.body.incoming[0].from, alice.upiId);
  const aliceReqs = await request(app).get(`/users/${alice.upiId}/requests`).expect(200);
  assert.equal(aliceReqs.body.outgoing.length, 1);

  // Bob approves with his PIN -> money moves Bob -> Alice.
  const approve = await request(app)
    .post(`/requests/${req.body.id}/approve`)
    .send({ pin: PIN })
    .expect(201);
  assert.equal(approve.body.request.status, 'APPROVED');
  assert.equal(approve.body.transaction.amountRupees, 250);
  assert.equal(approve.body.payer.balanceRupees, 750); // Bob
  assert.equal(approve.body.payee.balanceRupees, 250); // Alice
  assert.ok(approve.body.request.txnId);
});

test('approving with a wrong PIN does not move money and leaves request pending', async () => {
  const app = makeApp();
  const alice = await createUser(app, 'Alice', 0);
  const bob = await createUser(app, 'Bob', 1000);
  const req = await request(app)
    .post('/requests')
    .send({ from: alice.upiId, to: bob.upiId, amount: 100 })
    .expect(201);

  await request(app)
    .post(`/requests/${req.body.id}/approve`)
    .send({ pin: '0000' })
    .expect(401);

  // Request still pending, balances untouched.
  const bobReqs = await request(app).get(`/users/${bob.upiId}/requests`).expect(200);
  assert.equal(bobReqs.body.incoming[0].status, 'PENDING');
  assert.equal((await request(app).get(`/users/${bob.upiId}`)).body.balanceRupees, 1000);
  assert.equal((await request(app).get(`/users/${alice.upiId}`)).body.balanceRupees, 0);
});

test('approving with insufficient balance keeps the request pending', async () => {
  const app = makeApp();
  const alice = await createUser(app, 'Alice', 0);
  const bob = await createUser(app, 'Bob', 50);
  const req = await request(app)
    .post('/requests')
    .send({ from: alice.upiId, to: bob.upiId, amount: 500 })
    .expect(201);
  await request(app).post(`/requests/${req.body.id}/approve`).send({ pin: PIN }).expect(422);
  const bobReqs = await request(app).get(`/users/${bob.upiId}/requests`).expect(200);
  assert.equal(bobReqs.body.incoming[0].status, 'PENDING');
});

test('a declined request cannot be approved, and vice versa', async () => {
  const app = makeApp();
  const alice = await createUser(app, 'Alice', 0);
  const bob = await createUser(app, 'Bob', 1000);
  const req = await request(app)
    .post('/requests')
    .send({ from: alice.upiId, to: bob.upiId, amount: 100 })
    .expect(201);

  const declined = await request(app).post(`/requests/${req.body.id}/decline`).expect(200);
  assert.equal(declined.body.status, 'DECLINED');

  // Approving a declined request is a conflict.
  const res = await request(app)
    .post(`/requests/${req.body.id}/approve`)
    .send({ pin: PIN })
    .expect(409);
  assert.match(res.body.error, /already declined/);
  // No money moved.
  assert.equal((await request(app).get(`/users/${bob.upiId}`)).body.balanceRupees, 1000);
});

test('cannot request money from yourself', async () => {
  const app = makeApp();
  const a = await createUser(app, 'Solo', 100);
  const res = await request(app)
    .post('/requests')
    .send({ from: a.upiId, to: a.upiId, amount: 10 })
    .expect(400);
  assert.match(res.body.error, /yourself/);
});

test('approving a non-existent request returns 404', async () => {
  const app = makeApp();
  await createUser(app, 'X', 100);
  const res = await request(app)
    .post('/requests/does-not-exist/approve')
    .send({ pin: PIN })
    .expect(404);
  assert.match(res.body.error, /not found/);
});
