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

Requires **Node.js 22.5+** (for the built-in `node:sqlite` module).

```bash
npm install
npm test        # run the test suite
npm start       # start the app on http://localhost:3000  (PORT env to change)
npm run dev     # start with auto-reload
```

Then open **http://localhost:3000** in a browser for the web app. Camera QR
scanning needs `localhost` or HTTPS (a browser requirement); you can always
paste a `upi://` link or type a UPI ID + amount instead.

## Banks & accounts (GPay-style onboarding)

Like Google Pay, money lives in **bank accounts** and you sign up by **phone
number** (with a country code — 🇮🇳 +91 or 🇦🇪 +971). The app seeds these dummy
banks/accounts:

| Phone | Holder | Bank | UPI ID | Balance |
|-------|--------|------|--------|---------|
| +91 9810000001 | Ravi Kumar | HDFC Bank | `ravi@hdfc` | ₹5,000 |
| +91 9810000001 | Ravi Kumar | State Bank of India | `ravi@sbi` | ₹3,000 |
| +91 9820000002 | Priya Shah | HDFC Bank | `priya@hdfc` | ₹8,000 |
| +91 9820000002 | Priya Shah | State Bank of India | `priya@sbi` | ₹2,000 |
| +971 501234567 | Sara Ali | Emirates NBD | `sara@enbd` | ₹10,000 |
| +971 509876543 | Omar Khan | Emirates NBD | `omar@enbd` | ₹7,000 |

(Amounts are all in the ₹ simulation for now — multi-currency isn't modelled yet.)

## The core flow

1. **Sign up by phone**: pick a country code and enter your number → verify a
   **one-time code (OTP)** "sent" to it → the app lists the bank accounts linked
   to that number → pick one → the app requests **bank verification** which you
   approve in your **banking app** → set a **UPI PIN** ("claiming" the account).
   Activation requires *both* the OTP token *and* an approved bank verification,
   so you can't claim an account just by knowing its number. (No real SMS/bank
   gateway — the demo shows the code and provides an "approve" button.) Codes
   are **rate-limited** (a 30-second resend gap plus a per-window cap), and the
   verify page has a **"Resend code"** button with a countdown.
2. Your balance is that **bank account's** balance; payments draw from it. One
   profile can link **several accounts** and choose which to pay from.
3. A payee shows a **QR code** (a `upi://pay` link) or you enter a UPI ID.
4. A payer pays, **authorising with their PIN**; balances update atomically and
   both parties see the transaction in history. A successful payment shows a
   **receipt screen** (green tick, amount, payee, source account, transaction
   ID, date) with a **Share receipt** option.

The home screen is **GPay-style**: a **🔔 notifications** bell (a live badge
of unread activity — money received, requests to pay, split shares you owe), a
**search bar** (find a person by name or UPI ID, a biller by name or category,
or just type any UPI ID to pay it), a **People** row (tap a contact to pay),
quick actions (Scan & Pay, Pay UPI ID, Receive, Request, Split, Rewards,
Insights, History), a **⚙️ Profile** button, and a **Bills & recharges** grid
(mobile,
electricity, DTH, water, gas). Each
category lists **operators** (Airtel/Jio/Vi, …); you enter a consumer number,
**fetch the bill** (a simulated amount due + due date + period), then pay it —
a bill payment is just a PIN-authorised transfer to the biller.

Every successful payment earns the payer a **scratch card** (GPay-style):
open **Rewards** and scratch it to reveal a small cashback that's credited to
your account. **Spending insights** summarise what you've paid vs received,
break it down by month, and list your top payees. A **Profile & settings**
screen shows your linked accounts and lets you **change your UPI PIN** (which
requires the current PIN and obeys the same lockout rules).

You can also **request money** ("collect"): ask another user to pay you, and
they approve (authorising with their PIN — which runs a normal transfer, so
the PIN + lockout rules apply) or decline.

**Split bills with a group** (Splitwise-style): the person who paid a bill
creates a **split** — a total plus the people to share it with — and the app
divides it equally (to the exact paisa). The creator's share is marked paid
(they fronted the bill); everyone else **owes their share** and settles it
with a **PIN-authorised transfer to the creator**. Each split shows who's
paid and who's pending, and how much **you owe** or **you're owed**.

PINs are never stored in plaintext — only a salted scrypt hash is kept, and a
wrong or missing PIN rejects the payment without moving any money. After 3
consecutive wrong PINs the account is **locked for 15 minutes** (payments are
blocked even with the correct PIN); a correct PIN resets the counter and the
lock auto-expires.

## API

| Method | Path                          | Description                                  |
|--------|-------------------------------|----------------------------------------------|
| GET    | `/health`                     | Liveness check                               |
| GET    | `/banks`                      | List the (dummy) banks                       |
| GET    | `/contacts?exclude=`          | People you can pay (one per person, excluding you) |
| GET    | `/search?q=&exclude=`         | Search people (name/UPI ID) + billers (name/category) → `{ people, billers }` |
| GET    | `/billers`                    | Billers you can pay (mobile, electricity, …) |
| POST   | `/billers/:upiId/fetch-bill`  | Simulated bill for a consumer no.: `{ consumer }` → amount due, due date |
| POST   | `/otp/send`                   | "Send" a code: `{ phone }` → `{ devCode }` (sim; rate-limited, 429 if too frequent) |
| POST   | `/otp/verify`                 | Verify a code: `{ phone, code }` → `{ token }` |
| GET    | `/accounts?phone=`            | Bank accounts linked to a phone              |
| POST   | `/accounts/:upiId/verify-request` | Ask the bank to verify linking: `{ token }` → `{ requestId }` |
| POST   | `/bank/verify/:requestId/approve` | Approve the request (stands in for the bank app) |
| POST   | `/accounts/:upiId/claim`      | Activate: `{ pin, token }` (OTP token **and** bank approval required) |
| POST   | `/users/:upiId/change-pin`    | Change the UPI PIN: `{ oldPin, newPin }` (current PIN required) |
| GET    | `/users/:upiId`               | Fetch an account + balance                   |
| GET    | `/users/:upiId/qr`            | Payment QR; optional `?amount=&note=`        |
| GET    | `/users/:upiId/transactions`  | Transaction history (the web app filters it by direction / month / text) |
| GET    | `/users/:upiId/notifications` | Activity feed: money received, requests to pay, split shares owed |
| GET    | `/users/:upiId/insights`      | Spending insights: totals, by month, top payees |
| GET    | `/users/:upiId/rewards`       | Scratch cards earned (reward hidden until scratched) |
| POST   | `/rewards/:id/scratch`        | Scratch a card: reveal + credit the reward: `{ upiId }` |
| POST   | `/pay`                        | Pay via `{ from, to, amount, pin }` **or** `{ from, upiUri, pin }` (scanned QR) |
| POST   | `/requests`                   | Request money: `{ from (requester), to (payer), amount, note? }` |
| GET    | `/users/:upiId/requests`      | A user's requests: `{ incoming, outgoing }` |
| POST   | `/requests/:id/approve`       | Payer approves & pays: `{ pin }` |
| POST   | `/requests/:id/decline`       | Decline a pending request |
| POST   | `/splits`                     | Create a group split: `{ creator, description?, total, members: [upiId,…] }` |
| GET    | `/users/:upiId/splits`        | Splits you created or are part of |
| GET    | `/splits/:id`                 | A split's detail; optional `?viewer=` for your owe/owed view |
| POST   | `/splits/:id/pay`             | Settle your share: `{ from, pin }` (transfer to the creator) |

`pin` is the payer's 4–6 digit payment PIN. Amounts in requests/responses are
in **rupees**. Errors return `{ "error": "..." }` with an appropriate HTTP
status (400 bad input, 401 incorrect PIN, 403 account not activated, 404
unknown account, 422 insufficient balance, 423 account locked after too many
wrong PINs).

### Example

```bash
# Find the accounts linked to a phone, then activate one with a PIN
curl -s "localhost:3000/accounts?phone=9810000001"
curl -s -X POST localhost:3000/accounts/ravi@hdfc/claim \
  -H 'content-type: application/json' -d '{"pin":"1234"}'

# Ravi pays Priya ₹300 with his PIN
curl -s -X POST localhost:3000/pay -H 'content-type: application/json' \
  -d '{"from":"ravi@hdfc","to":"priya@hdfc","amount":300,"pin":"1234"}'
```

## Project layout

```
src/
  server.js   # process entrypoint (starts the HTTP listener)
  app.js      # Express app + routes (built around an injected store)
  store.js    # SQLite data + the one place money moves
  upi.js      # UPI ID generation, upi:// link build/parse, QR rendering
  money.js    # rupee <-> paise helpers
  pin.js      # payment-PIN hashing/verification (salted scrypt)
  errors.js   # ApiError (carries an HTTP status)
test/
  api.test.js         # end-to-end API tests
  persistence.test.js # data survives a restart; failed transfers roll back
  lockout.test.js     # wrong-PIN lockout: locks, resets, and expires
  requests.test.js    # request-money: create, approve (with PIN), decline
public/
  index.html  # web app shell (onboarding, home, receive, pay, history)
  styles.css  # styling
  app.js      # front-end logic (talks to the API, QR scan via camera)
```

Data is stored at `data/upi.sqlite` by default (git-ignored). Override the
location with the `DATABASE_PATH` environment variable.

## Roadmap / ideas for next

- User login/accounts (session or token auth) instead of entering a UPI ID
- Idempotency keys + a proper transactions ledger
- A native mobile app (React Native / Flutter)
