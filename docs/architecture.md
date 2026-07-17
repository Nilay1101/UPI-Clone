# UPI-Clone — Data-flow architecture

How data moves through the app. The **store is the single source of truth** and
the only place money changes; the API is a thin validation/serialization layer;
auth state (OTP codes, session tokens, bank approvals) lives in ephemeral memory,
while money and records live in SQLite.

```mermaid
flowchart TB
  subgraph CLIENT["🖥️  Client (browser)"]
    UI["public/app.js<br/>screens + fetch() to same-origin API"]
    DEMO["docs/demo.js — standalone demo<br/>same UI, API reimplemented in-browser<br/>persists to localStorage"]
  end

  subgraph API["⚙️  HTTP API · src/app.js (Express)"]
    AUTHR["/otp/send · /otp/verify<br/>/accounts · /verify-request<br/>/bank/verify · /claim"]
    MONEYR["/pay · /splits · /requests<br/>/rewards/:id/scratch"]
    READR["/users/:id · /transactions · /qr<br/>/notifications · /insights<br/>/search · /billers · /contacts"]
    SER["serializers<br/>paise→rupees · mask account · hide pin_hash"]
    ERR["error middleware<br/>ApiError → HTTP status + {error}"]
  end

  subgraph STORE["🧠  Store · src/store.js — single source of truth (all money moves here)"]
    AUTHZ["authorizePin()<br/>scrypt verify + wrong-PIN lockout"]
    TX["transfer() / paySplitShare()<br/>BEGIN → debit + credit → insert txn<br/>→ award scratch card → COMMIT / ROLLBACK"]
    READS["reads: getUser · getTransactions<br/>getNotifications · getInsights<br/>getSplits · getRewards · search"]
    PIN["pin.js — hashPin / verifyPin<br/>(salted scrypt, constant-time)"]
  end

  subgraph DB["💾  SQLite · node:sqlite · data/upi.sqlite (money in integer paise)"]
    ACC["accounts<br/>balance_paise · pin_hash · claimed<br/>failed_pin_attempts · locked_until"]
    TXN["transactions"]
    REQ["payment_requests"]
    CARD["scratch_cards"]
    SPL["splits · split_members"]
  end

  subgraph MEM["⏳  In-memory Maps · ephemeral, not persisted"]
    OTP["otps — codes + 5-min TTL"]
    SESS["sessions — OTP tokens (30-min TTL)"]
    BV["bankVerifs — bank approvals"]
    RATE["otpRates — send rate limits"]
  end

  UI -->|"HTTP JSON e.g. {from,to,amount,pin}"| API
  DEMO -.->|"same request/response shapes,<br/>localStorage instead of SQLite"| DEMO

  AUTHR --> MEM
  AUTHR --> STORE
  MONEYR --> STORE
  READR --> READS
  API --> SER
  API --> ERR

  TX --> AUTHZ
  AUTHZ --> PIN
  AUTHZ -->|"read/update pin bookkeeping<br/>(outside the money txn)"| ACC
  TX -->|"atomic BEGIN/COMMIT/ROLLBACK"| ACC
  TX --> TXN
  TX --> CARD
  READS --> DB
  STORE --> SPL
  STORE --> REQ
```

## Two representative flows

**Onboarding (GPay-style claim):**
`phone → POST /otp/send` (code stored in `otps`) `→ POST /otp/verify` (issues a
token in `sessions`) `→ GET /accounts?phone` `→ POST /verify-request` (pending
entry in `bankVerifs`) `→ POST /bank/verify/:id/approve` `→ POST /claim`
(needs **both** a valid session token **and** an approved bank verification →
stores a salted scrypt PIN hash and flips `claimed=1` on the account row).

**Payment:**
`POST /pay {from,to,amount,pin}` → `app.js` validates + converts rupees→paise →
`store.transfer()` → `authorizePin()` (scrypt verify; on 3 wrong PINs the account
locks for 15 min, and that bookkeeping persists *outside* the money transaction)
→ atomic `BEGIN` → debit payer, credit payee, insert transaction, award a scratch
card → `COMMIT` (or `ROLLBACK` on any failure, e.g. insufficient balance) →
serialized response (paise→rupees, PIN hash never included).
