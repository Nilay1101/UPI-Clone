import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.js';
import { rupeesToPaise, paiseToRupees } from './money.js';
import { buildUpiUri, parseUpiUri, generateQrDataUrl } from './upi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Build the Express app around a given store. Taking the store as an argument
 * (rather than importing a singleton) lets tests spin up an isolated app with
 * its own data.
 */
export function createApp(store) {
  const app = express();
  app.use(express.json());

  // Serve the web front-end (public/index.html etc.). API routes below use
  // distinct paths, so they take priority over static assets.
  app.use(express.static(PUBLIC_DIR));

  const maskAccount = (n) => `••••${String(n).slice(-4)}`;

  const serializeUser = (u) => ({
    upiId: u.upiId,
    name: u.holderName, // the bank account holder is the display name
    holderName: u.holderName,
    phone: u.phone,
    bankId: u.bankId,
    bankName: u.bankName,
    accountMasked: maskAccount(u.accountNumber),
    claimed: u.claimed,
    balanceRupees: paiseToRupees(u.balancePaise),
    createdAt: u.createdAt,
  });

  // Summary shown during sign-up / login (no balance-moving fields).
  const serializeAccountSummary = (a) => ({
    upiId: a.upiId,
    holderName: a.holderName,
    bankName: a.bankName,
    bankId: a.bankId,
    accountMasked: maskAccount(a.accountNumber),
    balanceRupees: paiseToRupees(a.balancePaise),
    claimed: a.claimed,
  });

  const serializeTxn = (t) => ({
    id: t.id,
    from: t.from,
    to: t.to,
    amountRupees: paiseToRupees(t.amountPaise),
    note: t.note,
    status: t.status,
    createdAt: t.createdAt,
  });

  const serializeRequest = (r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    amountRupees: paiseToRupees(r.amountPaise),
    note: r.note,
    status: r.status,
    txnId: r.txnId,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  });

  // Wrap async handlers so rejected promises reach the error middleware.
  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // List the (dummy) banks.
  app.get('/banks', (_req, res) => {
    res.json({ banks: store.getBanks() });
  });

  // Send a one-time code to a phone (sign-up step 1). devCode is a SIMULATION
  // convenience — a real app texts the code and never returns it.
  app.post('/otp/send', (req, res) => {
    const { phone } = req.body ?? {};
    const { code } = store.sendOtp(phone);
    res.json({ sent: true, devCode: code });
  });

  // Verify a code and receive a short-lived verification token (step 2).
  app.post('/otp/verify', (req, res) => {
    const { phone, code } = req.body ?? {};
    const { token } = store.verifyOtp(phone, code);
    res.json({ token });
  });

  // People you can pay (exclude yourself via ?exclude=<your upiId>).
  app.get('/contacts', (req, res) => {
    const me = req.query.exclude ? store.getUser(String(req.query.exclude)) : null;
    res.json({ contacts: store.getContacts(me ? me.phone : '') });
  });

  // Billers you can pay (mobile, electricity, …).
  app.get('/billers', (_req, res) => {
    res.json({ billers: store.getBillers() });
  });

  // Search people (by name/UPI ID) and billers (by name/category).
  app.get('/search', (req, res) => {
    const me = req.query.exclude ? store.getUser(String(req.query.exclude)) : null;
    res.json(store.search(String(req.query.q ?? ''), me ? me.phone : ''));
  });

  // "Fetch" a bill for a consumer number (simulated amount due + due date).
  app.post('/billers/:upiId/fetch-bill', (req, res) => {
    const { consumer } = req.body ?? {};
    const bill = store.fetchBill(req.params.upiId, consumer);
    res.json({
      upiId: bill.upiId,
      billerName: bill.billerName,
      category: bill.category,
      consumer: bill.consumer,
      amountRupees: paiseToRupees(bill.amountPaise),
      dueDate: bill.dueDate,
      period: bill.period,
    });
  });

  // Find the bank accounts linked to a phone number (sign-up / login).
  app.get('/accounts', (req, res) => {
    const phone = String(req.query.phone ?? '').trim();
    if (!phone) throw new ApiError(400, 'phone is required');
    const accounts = store.getAccountsByPhone(phone).map(serializeAccountSummary);
    res.json({ phone, accounts });
  });

  // Ask the bank to verify linking this account (needs the OTP token). Returns
  // a pending request the user approves in their bank app.
  app.post('/accounts/:upiId/verify-request', (req, res) => {
    const { token } = req.body ?? {};
    res.status(201).json(store.requestBankVerification(req.params.upiId, token));
  });

  // Approve a bank-verification request — simulates the user tapping "approve"
  // in their bank's app.
  app.post('/bank/verify/:requestId/approve', (req, res) => {
    res.json(store.approveBankVerification(req.params.requestId));
  });

  // Claim a bank account by setting a UPI PIN. Requires (1) an OTP token proving
  // control of the phone number, and (2) an approved bank verification — so you
  // can't activate an account just by knowing its number.
  app.post('/accounts/:upiId/claim', (req, res) => {
    const { pin, token } = req.body ?? {};
    const account = store.requireUser(req.params.upiId, 'account');
    if (store.sessionPhone(token) !== account.phone) {
      throw new ApiError(401, 'phone not verified; complete OTP verification first');
    }
    if (!store.isBankApproved(req.params.upiId)) {
      throw new ApiError(403, 'bank verification required; approve the request in your bank app');
    }
    const claimed = store.claimAccount(req.params.upiId, pin);
    res.status(201).json(serializeUser(claimed));
  });

  // Look up a user by UPI ID.
  app.get('/users/:upiId', (req, res) => {
    const user = store.requireUser(req.params.upiId, 'user');
    res.json(serializeUser(user));
  });

  // Generate a payment QR for a user. Optional ?amount= (rupees) & ?note=.
  app.get(
    '/users/:upiId/qr',
    asyncHandler(async (req, res) => {
      const user = store.requireUser(req.params.upiId, 'user');
      const { amount, note } = req.query;
      const upiUri = buildUpiUri({
        pa: user.upiId,
        pn: user.holderName,
        am: amount != null && amount !== '' ? Number(amount) : undefined,
        tn: note,
      });
      const qrDataUrl = await generateQrDataUrl(upiUri);
      res.json({ upiId: user.upiId, upiUri, qrDataUrl });
    }),
  );

  // Transactions for a user.
  app.get('/users/:upiId/transactions', (req, res) => {
    store.requireUser(req.params.upiId, 'user');
    const txns = store.getTransactions(req.params.upiId).map(serializeTxn);
    res.json({ transactions: txns });
  });

  // Make a payment. Accepts either an explicit { from, to, amount } or a
  // scanned QR link via { from, upiUri } (amount/note taken from the link,
  // and can still be overridden in the body).
  app.post('/pay', (req, res) => {
    const body = req.body ?? {};
    let { from, to, amount, note, upiUri, pin } = body;

    if (upiUri) {
      const parsed = parseUpiUri(upiUri);
      if (!parsed || !parsed.pa) {
        throw new ApiError(400, 'upiUri is not a valid upi://pay link');
      }
      to = to ?? parsed.pa;
      if (amount == null || amount === '') amount = parsed.am;
      note = note ?? parsed.tn ?? undefined;
    }

    if (!from) throw new ApiError(400, 'from (payer UPI ID) is required');
    if (!to) throw new ApiError(400, 'to (payee UPI ID) is required');
    if (amount == null || amount === '') {
      throw new ApiError(400, 'amount is required');
    }

    const amountPaise = rupeesToPaise(amount);
    if (Number.isNaN(amountPaise)) {
      throw new ApiError(400, 'amount must be a number');
    }

    const txn = store.transfer({
      fromUpiId: from,
      toUpiId: to,
      amountPaise,
      note,
      pin,
    });

    res.status(201).json({
      transaction: serializeTxn(txn),
      payer: serializeUser(store.getUser(from)),
      payee: serializeUser(store.getUser(to)),
      cardEarned: !!txn.cardId, // the payer earned a scratch card
    });
  });

  // Create a money request: { from (requester), to (payer), amount, note? }.
  app.post('/requests', (req, res) => {
    const { from, to, amount, note } = req.body ?? {};
    if (!from) throw new ApiError(400, 'from (requester UPI ID) is required');
    if (!to) throw new ApiError(400, 'to (payer UPI ID) is required');
    if (amount == null || amount === '') throw new ApiError(400, 'amount is required');
    const amountPaise = rupeesToPaise(amount);
    if (Number.isNaN(amountPaise)) throw new ApiError(400, 'amount must be a number');

    const request = store.createRequest({ fromUpiId: from, toUpiId: to, amountPaise, note });
    res.status(201).json(serializeRequest(request));
  });

  // A user's requests: incoming (to pay) and outgoing (they raised).
  app.get('/users/:upiId/requests', (req, res) => {
    store.requireUser(req.params.upiId, 'user');
    const { incoming, outgoing } = store.getRequestsForUser(req.params.upiId);
    res.json({
      incoming: incoming.map(serializeRequest),
      outgoing: outgoing.map(serializeRequest),
    });
  });

  // Approve a request (payer pays, authorised with their PIN).
  app.post('/requests/:id/approve', (req, res) => {
    const { pin } = req.body ?? {};
    const { request, transaction } = store.approveRequest(req.params.id, pin);
    res.status(201).json({
      request: serializeRequest(request),
      transaction: serializeTxn(transaction),
      payer: serializeUser(store.getUser(request.to)),
      payee: serializeUser(store.getUser(request.from)),
      cardEarned: !!transaction.cardId,
    });
  });

  // Decline a request.
  app.post('/requests/:id/decline', (req, res) => {
    const request = store.declineRequest(req.params.id);
    res.json(serializeRequest(request));
  });

  // Change the UPI PIN (requires the current PIN): { oldPin, newPin }.
  app.post('/users/:upiId/change-pin', (req, res) => {
    const { oldPin, newPin } = req.body ?? {};
    if (!oldPin || !newPin) throw new ApiError(400, 'oldPin and newPin are required');
    res.json(serializeUser(store.changePin(req.params.upiId, oldPin, newPin)));
  });

  // Spending insights: totals, per-month breakdown, top payees.
  app.get('/users/:upiId/insights', (req, res) => {
    store.requireUser(req.params.upiId, 'user');
    const ins = store.getInsights(req.params.upiId);
    res.json({
      paidRupees: paiseToRupees(ins.paidPaise),
      receivedRupees: paiseToRupees(ins.receivedPaise),
      txnCount: ins.txnCount,
      months: ins.months.map((m) => ({
        month: m.label,
        paidRupees: paiseToRupees(m.paidPaise),
        receivedRupees: paiseToRupees(m.receivedPaise),
      })),
      topPayees: ins.topPayees.map((p) => ({
        upiId: p.upiId,
        name: p.name,
        kind: p.kind,
        category: p.category,
        totalRupees: paiseToRupees(p.totalPaise),
        count: p.count,
      })),
    });
  });

  // Scratch cards (rewards) a user has earned.
  app.get('/users/:upiId/rewards', (req, res) => {
    store.requireUser(req.params.upiId, 'user');
    const rewards = store.getRewards(req.params.upiId).map((c) => ({
      id: c.id,
      scratched: c.scratched,
      rewardRupees: c.rewardPaise == null ? null : paiseToRupees(c.rewardPaise),
      createdAt: c.createdAt,
    }));
    res.json({ rewards });
  });

  // Scratch a card: reveal + credit the reward. Body: { upiId } (the owner).
  app.post('/rewards/:id/scratch', (req, res) => {
    const { upiId } = req.body ?? {};
    if (!upiId) throw new ApiError(400, 'upiId is required');
    const result = store.scratchCard(req.params.id, upiId);
    res.json({
      id: result.id,
      rewardRupees: paiseToRupees(result.rewardPaise),
      balanceRupees: paiseToRupees(result.balancePaise),
    });
  });

  // 404 for anything unmatched.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Central error handler: ApiError -> its status; anything else -> 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err instanceof ApiError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'internal server error' });
  });

  return app;
}
