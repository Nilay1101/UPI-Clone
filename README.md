# UPI-Clone

A UPI-style QR-code payment app — a learning/simulation project inspired by
apps like Google Pay, PhonePe, and Paytm. **No real money or bank integration**:
balances live in the app and transfers are simulated, so it's safe to hack on.

This repo contains the **backend API** (the payment engine) plus a **web
front-end** served from the same server. Open it in a browser to create a
wallet, show a payment QR, scan/enter one to pay, and view history.

## Stack

- **Node.js + Express** HTTP API
- **SQLite** persistence via the built-in `node:sqlite` module (no native
  dependency; a real database in a single file). Tests use an in-memory DB.
- Money tracked as integer **paise** internally to avoid floating-point errors
- **`qrcode`** to render standard `upi://pay` links as scannable QR images
- Tests via Node's built-in test runner + `supertest`

## Getting started

```bash
npm install
npm test        # run the test suite
npm start       # start the app on http://localhost:3000  (PORT env to change)
npm run dev     # start with auto-reload
```

Then open **http://localhost:3000** in a browser for the web app. Camera QR
scanning needs `localhost` or HTTPS (a browser requirement); you can always
paste a `upi://` link or type a UPI ID + amount instead.

## The core flow (walking skeleton)

1. Create two users → each gets a wallet + a UPI ID like `alice7844@upiclone`.
2. A payee generates a **QR code** encoding a `upi://pay` link (optionally with
   an amount + note).
3. A payer **scans** that QR (or pastes the link) and pays.
4. Balances update atomically and both parties see the transaction in history.

## API

| Method | Path                          | Description                                  |
|--------|-------------------------------|----------------------------------------------|
| GET    | `/health`                     | Liveness check                               |
| POST   | `/users`                      | Create a wallet: `{ name, phone?, openingBalance? }` |
| GET    | `/users/:upiId`               | Fetch a user + balance                       |
| GET    | `/users/:upiId/qr`            | Payment QR; optional `?amount=&note=`        |
| GET    | `/users/:upiId/transactions`  | Transaction history                          |
| POST   | `/pay`                        | Pay via `{ from, to, amount }` **or** `{ from, upiUri }` (scanned QR) |

Amounts in requests/responses are in **rupees**. Errors return
`{ "error": "..." }` with an appropriate HTTP status (400 bad input,
404 unknown user, 422 insufficient balance).

### Example

```bash
# Create two users
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"Alice","openingBalance":1000}'
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"Bob"}'

# Bob generates a QR requesting ₹300, Alice pays it
curl -s "localhost:3000/users/<bobUpiId>/qr?amount=300&note=Dinner"
curl -s -X POST localhost:3000/pay -H 'content-type: application/json' \
  -d '{"from":"<aliceUpiId>","to":"<bobUpiId>","amount":300}'
```

## Project layout

```
src/
  server.js   # process entrypoint (starts the HTTP listener)
  app.js      # Express app + routes (built around an injected store)
  store.js    # SQLite data + the one place money moves
  upi.js      # UPI ID generation, upi:// link build/parse, QR rendering
  money.js    # rupee <-> paise helpers
  errors.js   # ApiError (carries an HTTP status)
test/
  api.test.js         # end-to-end API tests
  persistence.test.js # data survives a restart; failed transfers roll back
public/
  index.html  # web app shell (onboarding, home, receive, pay, history)
  styles.css  # styling
  app.js      # front-end logic (talks to the API, QR scan via camera)
```

Data is stored at `data/upi.sqlite` by default (git-ignored). Override the
location with the `DATABASE_PATH` environment variable.

## Roadmap / ideas for next

- Authentication + PIN confirmation for payments
- Request-money / collect flow
- A frontend (web with webcam scanning, or a React Native / Flutter mobile app)
- Idempotency keys + a proper transactions ledger
