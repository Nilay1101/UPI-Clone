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

  const serializeUser = (u) => ({
    upiId: u.upiId,
    name: u.name,
    phone: u.phone,
    balanceRupees: paiseToRupees(u.balancePaise),
    createdAt: u.createdAt,
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

  // Wrap async handlers so rejected promises reach the error middleware.
  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Create a user (wallet). openingBalance is in rupees.
  app.post('/users', (req, res) => {
    const { name, phone, pin, openingBalance } = req.body ?? {};
    const openingBalancePaise = rupeesToPaise(openingBalance ?? 0);
    if (Number.isNaN(openingBalancePaise)) {
      throw new ApiError(400, 'openingBalance must be a number');
    }
    const user = store.createUser({ name, phone, pin, openingBalancePaise });
    res.status(201).json(serializeUser(user));
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
        pn: user.name,
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
