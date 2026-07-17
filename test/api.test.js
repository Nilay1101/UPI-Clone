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

// Request bank verification for an account and approve it (as the bank app would).
async function bankApprove(app, upiId, token) {
  const { requestId } = (
    await request(app).post(`/accounts/${encodeURIComponent(upiId)}/verify-request`).send({ token }).expect(201)
  ).body;
  await request(app).post(`/bank/verify/${requestId}/approve`).expect(200);
}

// Claim (activate) a seeded account: OTP → bank verification → set a PIN.
async function claim(app, upiId, pin = PIN) {
  const token = await getToken(app, await phoneOf(app, upiId));
  await bankApprove(app, upiId, token);
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

test('bank verify-request requires a matching OTP token', async () => {
  const app = makeApp();
  await request(app).post('/accounts/ravi@hdfc/verify-request').send({}).expect(401);
  const wrong = await getToken(app, '+919820000002');
  await request(app).post('/accounts/ravi@hdfc/verify-request').send({ token: wrong }).expect(401);
});

test('claiming without bank verification is rejected', async () => {
  const app = makeApp();
  const token = await getToken(app, '+919810000001');
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: PIN, token }).expect(403);
  assert.match(res.body.error, /bank verification required/);
});

test('claiming requires a valid 4-6 digit PIN', async () => {
  const app = makeApp();
  const token = await getToken(app, '+919810000001');
  await bankApprove(app, 'ravi@hdfc', token);
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: '12', token }).expect(400);
  assert.match(res.body.error, /pin must be 4 to 6 digits/);
});

test('an already-claimed account cannot be claimed again', async () => {
  const app = makeApp();
  // One OTP token + one bank approval, reused for both claim attempts
  // (a second OTP send would be rate-limited).
  const token = await getToken(app, '+919810000001');
  await bankApprove(app, 'ravi@hdfc', token);
  await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: PIN, token }).expect(201);
  const res = await request(app).post('/accounts/ravi@hdfc/claim').send({ pin: '5555', token }).expect(409);
  assert.match(res.body.error, /already set up/);
});

test('OTP sends to a number are rate-limited (min gap)', async () => {
  const app = makeApp();
  await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(200);
  const res = await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(429);
  assert.match(res.body.error, /wait \d+s/);
});

test('OTP sends are capped per window', async () => {
  const app = createApp(createStore({ resendIntervalMs: 0, otpSendMax: 2 }));
  await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(200);
  await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(200);
  const res = await request(app).post('/otp/send').send({ phone: '+919810000001' }).expect(429);
  assert.match(res.body.error, /too many/);
});

test('GET /billers lists multiple billers per category', async () => {
  const app = makeApp();
  const res = await request(app).get('/billers').expect(200);
  const mobile = res.body.billers.filter((b) => b.category === 'mobile').map((b) => b.name).sort();
  assert.deepEqual(mobile, ['Airtel', 'Jio', 'Vi (Vodafone Idea)']);
});

test('fetch-bill returns a stable amount due, due date and period', async () => {
  const app = makeApp();
  const first = await request(app)
    .post('/billers/power@bill/fetch-bill')
    .send({ consumer: 'EB-9988' })
    .expect(200);
  assert.ok(first.body.amountRupees >= 200 && first.body.amountRupees <= 2499);
  assert.match(first.body.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(first.body.billerName, 'State Electricity Board');
  // Deterministic: same consumer → same amount.
  const again = await request(app)
    .post('/billers/power@bill/fetch-bill')
    .send({ consumer: 'EB-9988' })
    .expect(200);
  assert.equal(again.body.amountRupees, first.body.amountRupees);
});

test('fetch-bill rejects a non-biller and a missing consumer number', async () => {
  const app = makeApp();
  await request(app).post('/billers/ravi@hdfc/fetch-bill').send({ consumer: '1' }).expect(400);
  await request(app).post('/billers/power@bill/fetch-bill').send({}).expect(400);
});

test('GET /contacts excludes your own accounts and dedupes people', async () => {
  const app = makeApp();
  const res = await request(app).get('/contacts').query({ exclude: 'ravi@hdfc' }).expect(200);
  const names = res.body.contacts.map((c) => c.name).sort();
  assert.deepEqual(names, ['Omar Khan', 'Priya Shah', 'Sara Ali']); // Ravi excluded, one per person
});

test('GET /search finds people by name and UPI ID, excluding yourself', async () => {
  const app = makeApp();
  const res = await request(app).get('/search').query({ q: 'priya', exclude: 'ravi@hdfc' }).expect(200);
  assert.deepEqual(res.body.people.map((p) => p.name), ['Priya Shah']); // deduped to one row
  assert.ok(res.body.people[0].upiId); // has a payable UPI ID
  assert.deepEqual(res.body.billers, []);

  const byId = await request(app).get('/search').query({ q: 'sara@' }).expect(200);
  assert.deepEqual(byId.body.people.map((p) => p.name), ['Sara Ali']);
});

test('GET /search finds billers by name and category', async () => {
  const app = makeApp();
  const byName = await request(app).get('/search').query({ q: 'airtel' }).expect(200);
  assert.deepEqual(byName.body.billers.map((b) => b.upiId), ['airtel@bill']);

  const byCat = await request(app).get('/search').query({ q: 'electricity' }).expect(200);
  const ids = byCat.body.billers.map((b) => b.upiId).sort();
  assert.deepEqual(ids, ['adani@bill', 'power@bill']);
});

test('GET /search with a blank query returns empty results', async () => {
  const app = makeApp();
  const res = await request(app).get('/search').query({ q: '  ' }).expect(200);
  assert.deepEqual(res.body, { people: [], billers: [] });
});

test('paying a bill is a normal PIN-authorised transfer to the biller', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // 5000
  const pay = await request(app)
    .post('/pay')
    .send({ from: 'ravi@hdfc', to: 'airtel@bill', amount: 200, note: '99xxxx0001', pin: PIN })
    .expect(201);
  assert.equal(pay.body.payer.balanceRupees, 4800);
  assert.equal(pay.body.payee.name, 'Airtel');
});

test('a successful payment earns the payer a scratch card', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const pay = await request(app)
    .post('/pay')
    .send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: PIN })
    .expect(201);
  assert.equal(pay.body.cardEarned, true);

  const { rewards } = (await request(app).get('/users/ravi@hdfc/rewards').expect(200)).body;
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].scratched, false);
  assert.equal(rewards[0].rewardRupees, null); // hidden until scratched
});

test('scratching a card reveals the reward and credits the balance', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // 5000
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: PIN }).expect(201);
  const before = await balance(app, 'ravi@hdfc'); // 4900
  const { rewards } = (await request(app).get('/users/ravi@hdfc/rewards').expect(200)).body;

  const scratch = await request(app)
    .post(`/rewards/${rewards[0].id}/scratch`)
    .send({ upiId: 'ravi@hdfc' })
    .expect(200);
  assert.ok(scratch.body.rewardRupees >= 1 && scratch.body.rewardRupees <= 100);
  assert.equal(scratch.body.balanceRupees, before + scratch.body.rewardRupees);

  // Re-scratching is rejected, and the reward is now visible in the list.
  await request(app).post(`/rewards/${rewards[0].id}/scratch`).send({ upiId: 'ravi@hdfc' }).expect(409);
  const after = (await request(app).get('/users/ravi@hdfc/rewards').expect(200)).body.rewards[0];
  assert.equal(after.scratched, true);
  assert.equal(after.rewardRupees, scratch.body.rewardRupees);
});

test("a card can't be scratched by another account", async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: PIN }).expect(201);
  const { rewards } = (await request(app).get('/users/ravi@hdfc/rewards').expect(200)).body;
  await request(app).post(`/rewards/${rewards[0].id}/scratch`).send({ upiId: 'priya@hdfc' }).expect(403);
});

test('change-pin requires the current PIN and then authorises with the new one', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc', '1234');
  // Wrong current PIN is rejected.
  await request(app).post('/users/ravi@hdfc/change-pin').send({ oldPin: '9999', newPin: '4321' }).expect(401);
  // Correct current PIN succeeds.
  await request(app).post('/users/ravi@hdfc/change-pin').send({ oldPin: '1234', newPin: '4321' }).expect(200);
  // The old PIN no longer works; the new one does.
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: '1234' }).expect(401);
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: '4321' }).expect(201);
});

test('change-pin rejects an invalid new PIN and an unactivated account', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc', '1234');
  await request(app).post('/users/ravi@hdfc/change-pin').send({ oldPin: '1234', newPin: '12' }).expect(400);
  // ravi@sbi is unclaimed (no PIN set).
  await request(app).post('/users/ravi@sbi/change-pin').send({ oldPin: '1234', newPin: '4321' }).expect(403);
});

test('insights summarise paid vs received, by month and top payees', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // 5000
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 300, pin: PIN }).expect(201);
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'airtel@bill', amount: 200, pin: PIN }).expect(201);
  await request(app).post('/pay').send({ from: 'ravi@hdfc', to: 'priya@hdfc', amount: 100, pin: PIN }).expect(201);

  const ins = (await request(app).get('/users/ravi@hdfc/insights').expect(200)).body;
  assert.equal(ins.paidRupees, 600);
  assert.equal(ins.receivedRupees, 0);
  assert.equal(ins.txnCount, 3);
  assert.ok(ins.months.length >= 1);
  const priya = ins.topPayees.find((p) => p.upiId === 'priya@hdfc');
  assert.equal(priya.totalRupees, 400); // 300 + 100
  assert.equal(priya.count, 2);
  assert.equal(priya.name, 'Priya Shah');
});

test('a split divides a bill equally and the creator is pre-settled', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  const res = await request(app)
    .post('/splits')
    .send({ creator: 'ravi@hdfc', description: 'Dinner', total: 900, members: ['priya@hdfc', 'ravi@sbi'] })
    .expect(201);
  assert.equal(res.body.totalRupees, 900);
  assert.equal(res.body.members.length, 3); // creator + 2 others
  // Shares sum to the total.
  const sum = res.body.members.reduce((a, m) => a + m.shareRupees, 0);
  assert.equal(sum, 900);
  const creator = res.body.members.find((m) => m.upiId === 'ravi@hdfc');
  assert.equal(creator.status, 'PAID'); // creator fronted the bill
  assert.equal(creator.isCreator, true);
  assert.equal(res.body.members.filter((m) => m.status === 'PENDING').length, 2);
  assert.equal(res.body.owedToYouRupees, 600); // two ₹300 shares owed to Ravi
});

test('a split needs at least one other member', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  await request(app).post('/splits').send({ creator: 'ravi@hdfc', total: 100, members: [] }).expect(400);
  await request(app).post('/splits').send({ creator: 'ravi@hdfc', total: 100, members: ['ravi@hdfc'] }).expect(400);
});

test('paying a split share transfers to the creator and settles the member', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc'); // 5000
  await claim(app, 'priya@hdfc'); // 8000, will pay her share
  const split = (await request(app)
    .post('/splits')
    .send({ creator: 'ravi@hdfc', description: 'Cab', total: 300, members: ['priya@hdfc'] })
    .expect(201)).body;
  const share = split.members.find((m) => m.upiId === 'priya@hdfc').shareRupees; // 150

  const pay = await request(app)
    .post(`/splits/${split.id}/pay`)
    .send({ from: 'priya@hdfc', pin: PIN })
    .expect(201);
  assert.equal(pay.body.transaction.amountRupees, share);
  assert.equal(pay.body.payee.name, 'Ravi Kumar');
  assert.equal(await balance(app, 'ravi@hdfc'), 5000 + share); // creator reimbursed
  assert.equal(await balance(app, 'priya@hdfc'), 8000 - share);
  // Priya's share is now settled and the whole split is settled.
  const after = (await request(app).get(`/splits/${split.id}`).query({ viewer: 'priya@hdfc' }).expect(200)).body;
  assert.equal(after.members.find((m) => m.upiId === 'priya@hdfc').status, 'PAID');
  assert.equal(after.settled, true);
  assert.equal(after.youOweRupees, 0);
});

test('a member cannot pay their split share twice, and the creator has nothing to pay', async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  await claim(app, 'priya@hdfc');
  const split = (await request(app)
    .post('/splits')
    .send({ creator: 'ravi@hdfc', total: 200, members: ['priya@hdfc'] })
    .expect(201)).body;
  await request(app).post(`/splits/${split.id}/pay`).send({ from: 'priya@hdfc', pin: PIN }).expect(201);
  await request(app).post(`/splits/${split.id}/pay`).send({ from: 'priya@hdfc', pin: PIN }).expect(409);
  await request(app).post(`/splits/${split.id}/pay`).send({ from: 'ravi@hdfc', pin: PIN }).expect(400);
});

test("a user's splits list includes ones they created and ones they're in", async () => {
  const app = makeApp();
  await claim(app, 'ravi@hdfc');
  await request(app).post('/splits').send({ creator: 'ravi@hdfc', description: 'Trip', total: 600, members: ['priya@hdfc'] }).expect(201);
  const ravi = (await request(app).get('/users/ravi@hdfc/splits').expect(200)).body;
  assert.equal(ravi.splits.length, 1);
  assert.equal(ravi.splits[0].youAreCreator, true);
  const priya = (await request(app).get('/users/priya@hdfc/splits').expect(200)).body;
  assert.equal(priya.splits.length, 1);
  assert.equal(priya.splits[0].youAreCreator, false);
  assert.equal(priya.splits[0].youOweRupees, 300);
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
