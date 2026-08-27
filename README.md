# Mini Centralised Exchange

An order-matching exchange built in TypeScript, developed in **measured stages** — starting from a correct, fully-transactional Postgres baseline and building toward a custom Write-Ahead Log, with every optimisation licensed by a benchmark rather than an assumption.

## The Engineering Story

> *"The database gives you safety but safety is slow; RAM is fast but volatile. This project is the disciplined journey away from a correct-but-slow Postgres baseline and BACK to durability by another route — a custom WAL — while keeping RAM-speed matching."*

## Architecture & Stages

| Stage | What | Why |
|-------|------|-----|
| **Stage 0** ✅ | Fully-transactional Postgres baseline | The honest starting point — can't claim I need complexity until I've built the simple thing and shown where it breaks |
| **Stage 0.5** ✅ | Load harness (k6) | Must produce my own numbers, not assert textbook ones |
| **Stage 1** | Measure the baseline under load | The measurement licenses the next stage — if no wall appears, stop |
| **Stage 2** | In-memory matching (single-threaded) | Justified only if Stage 1 shows matching is the bottleneck. Consequence: durability is lost |
| **Stage 3** | Custom WAL with group commit + crash recovery | Rebuild durability without reintroducing the Stage-1 wall. The centerpiece |
| **Stage 4** | Async projection to Postgres read-model | Log stays source of truth; Postgres becomes a derived, queryable view (CQRS) |

### Current status: **Stage 0 hardened; Stage 0.5 measured**

Stage 0 is a correct transactional baseline with a committed invariant harness. Stage 0.5 has produced a measured baseline: the ACID path plateaus at **~135 orders/sec**. Nothing has been tuned or optimised — Stages 1 → 4 are not started.

**What this project does NOT have yet:** no custom WAL, no group commit, no CRC32 torn-write protection, no crash-recovery replay, no in-memory matching engine. Durability in Stage 0 is whatever Postgres itself provides via its own ACID guarantees — nothing custom has been built on top. The Stage 0.5 numbers below are a *baseline measurement*, not an optimisation result: nothing has been tuned, and the dominant cost has not yet been profiled.

---

## What Stage 0 Delivers

Every order is processed inside a single `BEGIN ... COMMIT` with row-level locking.

### The order path — one atomic unit

1. **Find & lock** the best matching resting order (`SELECT ... ORDER BY price, id LIMIT 1 FOR UPDATE`)
2. **Lock every balance row** the trade touches — both parties, both assets — in **one** query, `ORDER BY user_id, asset FOR UPDATE`
3. **Validate the taker** has sufficient funds
4. **Validate the maker** still holds what their resting order promises
5. Debit quote asset from buyer / credit base asset to buyer
6. Debit base asset from seller / credit quote asset to seller
7. Update the resting order's `filled`/`status`, insert the incoming order, insert the trade

**All-or-nothing** — if any step throws, Postgres rolls back everything.

### What it protects against

| Danger | Protection |
|--------|-----------|
| Crash mid-transaction | `BEGIN ... COMMIT` — all writes commit or all roll back |
| Two buyers racing for the same shares (double-spend) | `SELECT ... FOR UPDATE` row lock serialises contenders |
| A resting order backed by funds the maker no longer has | Maker balance validated before execution, **plus** `CHECK (available >= 0)` as a structural backstop |
| Deadlock between two users trading into each other | All balance rows locked in one query in a deterministic global order `(user_id, asset)` |

The last two were real defects found and fixed after the first Stage 0 draft — see [DEVLOG.md](DEVLOG.md).

---

## Correctness — reproducible results only

Every claim below is output from code in this repo, reproducible with `docker compose down -v && docker compose up -d` followed by `npm test`. Nothing here is asserted from a textbook or from a run that no longer reproduces.

### Invariant harness — `npm test`

`src/test/invariants.ts` calls `processOrder()` **directly** rather than over HTTP. That is deliberate: a stale server process can silently serve old code and make a broken build look green. Importing the module guarantees the code under test is the code on disk.

```
Stage 0 invariant harness
=========================

(a) conservation — SUM(available) per asset unchanged by trading
  PASS  two trades executed
         alice={"ok":true,"qty":5} eve={"ok":true,"qty":3}
  PASS  SUM(available) unchanged for SOL
         before=250.00000000  after=250.00000000
  PASS  SUM(available) unchanged for USDC
         before=50000.00000000  after=50000.00000000

(b) no negative balances — including an insolvent resting-order owner
  PASS  insolvent maker is rejected
         Maker (user 2) has insufficient SOL: have 1, need 5
  PASS  bob's SOL untouched
         bob SOL=1.00000000
  PASS  no negative balances anywhere
  PASS  no negative balances after normal trades

(c) genuine race — two buyers, Promise.all, ONE limited resting order
  PASS  exactly one buyer filled
         alice={"ok":true,"qty":5}  eve={"ok":false,"error":"No matching resting order found"}
  PASS  bob sold exactly 5 SOL, not 10
         bob SOL=45.00000000
  PASS  SUM(available) unchanged for SOL across the race
  PASS  SUM(available) unchanged for USDC across the race
  PASS  no negative balances after race
  PASS  exactly one trade written
         trades=1

=========================
ALL INVARIANTS HOLD
```

**Why the race test is real.** Both buyers bid 90, so only Bob's 5 SOL @ 90 is eligible — Carol @ 95 and Dave @ 110 are above the limit. Both want the full 5, so they must contend for the *same row*. They are dispatched together via `Promise.all`, so both transactions are in flight before either completes. The winner is nondeterministic between runs, which is itself evidence the race is genuine.

**The harness was verified to fail.** With the maker check disabled and the `CHECK` constraint dropped, the same run produced `3 INVARIANT FAILURE(S)` and exit code 1, catching `bob SOL=-4.00000000`. A test that cannot fail proves nothing.

### Deadlock: 50% → 0

Two users trading into each other used to acquire the same two balance rows in opposite order — a guaranteed lock cycle. Measured over **40 concurrent pairs = 80 orders**:

| | filled | deadlocked | other rejects |
|---|---|---|---|
| Before (own row first, then counterparty's) | 40 | **40** (50% of orders) | 0 |
| After (single query, `ORDER BY user_id, asset`) | 80 | **0** | 0 |

### Matching behaviour

From a pristine book — Bob 5 @ 90, Carol 3 @ 95, Dave 8 @ 110:

```
1) price improvement   — alice bids 100 for 5:
   {"tradeId":1,"price":90,"quantity":5,"buyerOrderId":7,"sellerOrderId":4}

2) price-time priority — eve bids 100 for 3 (bob now filled):
   {"tradeId":2,"price":95,"quantity":3,"buyerOrderId":8,"sellerOrderId":5}

3) no match above limit — alice bids 100 (only dave@110 left):
   REJECTED: No matching resting order found
```

Alice bid 100 and paid 90 — the trade executes at the **resting order's** price, so the taker gets price improvement.

### Partial fills rest on the book

Alice bids 90 for **10** SOL when Bob has only 5:

```
   {"tradeId":3,"price":90,"quantity":5,"buyerOrderId":12,"sellerOrderId":9}

 id | user_id | side | price | quantity | filled | status
  9 |       2 | sell |    90 |        5 |      5 | filled
 10 |       3 | sell |    95 |        3 |      0 | open
 11 |       4 | sell |   110 |        8 |      0 | open
 12 |       1 | buy  |    90 |       10 |      5 | partial   <- original 10 preserved
```

Her unfilled 5 rests. A later seller fills it:

```
5) bob sells 5 @90:
   {"tradeId":4,"price":90,"quantity":5,"buyerOrderId":12,"sellerOrderId":13}

 12 |       1 | buy  |    90 |       10 |     10 | filled
 13 |       2 | sell |    90 |        5 |      5 | filled

totals: SOL=250.00000000  USDC=50000.00000000   (unchanged)
```

---

## Stage 0.5 — Measured baseline (no tuning)

Load generated with k6 against `POST /order`, using a generated seed of 200 funded users and a 2,000-order resting sell book (`db/seed-load.sql`, `loadtest/order-load.js`). Orders are constructed to genuinely **match and commit** — `match_rate` was **100% at every level**, so these numbers measure the real transactional path, not rejection speed.

| VUs | throughput (ord/s) | p50 | p95 | p99 | error% | match% |
|-----|-------------------|-----|-----|-----|--------|--------|
| 1 | 56.95 | 16.04ms | 33.19ms | 42.54ms | 0.00% | 100% |
| 5 | 135.05 | 31.30ms | 67.59ms | 174.14ms | 0.00% | 100% |
| 10 | 138.17 | 28.71ms | 198.26ms | 865.44ms | 0.00% | 100% |
| 25 | 133.21 | 170.41ms | 284.74ms | 360.68ms | 0.00% | 100% |
| 50 | 133.23 | 342.09ms | 576.92ms | 690.98ms | 0.00% | 100% |
| 100 | 140.41 | 675.72ms | 888.67ms | 1.04s | 0.00% | 100% |

**Throughput plateaus at ~135 ord/s from 5 VUs onward.** Going from 5 to 100 concurrent clients bought no extra throughput while p50 latency grew ~21x. Past ~5 concurrent clients, requests queue rather than execute.

Zero errors and **zero deadlocks** at every level — the deterministic lock ordering holds under sustained load. 15,378 trades committed across the sweep with `negative_balances = 0` afterwards.

**No conclusion is drawn yet about *why* the wall is there.** Candidate causes — fsync-per-commit, row-lock contention on the head of the book, the unindexed match predicate on a table growing by one row per request, or client/server round-trips — have not been separated. That profiling is Stage 1, and it is what licenses any optimisation.

Reproduce:

```bash
docker compose down -v && docker compose up -d
npm run seed:load
npm run dev
docker run --rm -i --add-host=host.docker.internal:host-gateway   -e BASE_URL=http://host.docker.internal:3000 -e VUS=25 -e DURATION=20s   grafana/k6:latest run - < loadtest/order-load.js
```

---

## Deliberate scope decisions for Stage 0

These are conscious choices, not oversights. Each is a known limitation with a reason.

**1. Partially-filled taker orders rest on the book — KEPT.**
An order that cannot fill completely records its original quantity, its partial `filled` amount, and `status='partial'`, which leaves it matchable. This is realistic exchange behaviour: match what's available, rest the remainder. The earlier draft stored the *filled* amount as the quantity, which destroyed the user's real request and made every partial fill look complete.

**2. The taker fund check is conservative.**
A taker is validated against `price × full requested quantity`, not against what they will actually spend on a partial fill. So a taker can be rejected for funds they would never have spent. Documented and left as-is for Stage 0.

**3. One price level per incoming order.**
The match query uses `LIMIT 1`, so a single incoming order consults only the best eligible price level. A taker larger than that level fills against it and rests the remainder; it does **not** walk down the book across multiple levels in one pass. Deliberate scope cut for the baseline.

**4. `balances.locked` is unused.**
The column exists with a `CHECK (locked >= 0)` constraint, but no funds-locking flow is implemented. Reserved for later stages.

---

## Tech Stack

- **TypeScript** — type-safe backend
- **Express** — HTTP API server
- **PostgreSQL 16** — transactional data store (via Docker)
- **node-postgres (pg)** — connection pool

## Project Structure

```
Mini-Centralised-Exchange/
├── db/
│   └── init.sql              # Schema + seed data (auto-runs on first Docker start)
├── src/
│   ├── db.ts                 # Postgres connection pool
│   ├── server.ts             # Express API (POST /order, GET /balances, ...)
│   ├── orderProcessor.ts     # Transactional matching logic (BEGIN...COMMIT)
│   ├── test-connection.ts    # DB connectivity check
│   └── test/
│       └── invariants.ts     # Correctness-invariant harness (npm test)
├── docker-compose.yml        # Postgres container config
├── DEVLOG.md                 # Build log: what was found, fixed, and verified
├── package.json
└── tsconfig.json
```

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/Soumya2508/Mini-Centralised-Exchange.git
cd Mini-Centralised-Exchange

npm install
docker compose up -d      # start Postgres; init.sql seeds schema + 5 users
npm test                  # run the invariant harness
npm run dev               # start the exchange API on :3000
```

### Reset the database
```bash
docker compose down -v && docker compose up -d
```

Note: `init.sql` runs only on an **empty** volume. After changing the schema you must `down -v`, not just restart.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/order` | Place a buy/sell order |
| `GET` | `/balances` | View all user balances |
| `GET` | `/orders` | View all orders |
| `GET` | `/trades` | View all executed trades |
| `GET` | `/health` | Health check |

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "symbol": "SOL_USDC", "side": "buy", "price": 100, "quantity": 5}'
```

---

## Seed Data

Five users, each starting with 10,000 USDC and 50 SOL: Alice (1), Bob (2), Carol (3), Dave (4), Eve (5).

Resting sell orders forming the initial book:

| Seller | Price | Quantity |
|--------|-------|----------|
| Bob | 90 USDC | 5 SOL |
| Carol | 95 USDC | 3 SOL |
| Dave | 110 USDC | 8 SOL |

---

## Matching Algorithm: Price-Time Priority

1. A **buy** matches the cheapest available sell at or below the buyer's limit
2. A **sell** matches the most expensive available buy at or above the seller's limit
3. Ties broken by **time** — older order first
4. **Trade price = the resting order's price**, giving the taker price improvement
5. Whatever cannot be filled at that level **rests** as a partial order

```sql
-- For a buy: cheapest eligible sell, oldest first, locked against contenders
SELECT id, user_id, price, quantity, filled
FROM orders
WHERE symbol = $1 AND side = 'sell' AND status IN ('open', 'partial')
  AND price <= $3
ORDER BY price ASC, id ASC
LIMIT 1
FOR UPDATE;
```

---

## Concepts Showcased

| Domain | Concepts |
|--------|----------|
| **DBMS** | Transactions, ACID, atomicity, row-level locking, `SELECT ... FOR UPDATE`, `CHECK` constraints as structural invariants |
| **Concurrency** | Race-condition prevention, serialisation via row locks, deterministic lock ordering to eliminate deadlock |
| **System Design** | Connection pooling, price-time priority matching, maker/taker roles |
| **Testing** | Invariant-based correctness testing, genuine concurrent race testing, negative-control verification |

Concepts belonging to later stages — WAL design, group commit, CRC32 torn-write protection, crash recovery, in-memory matching, CQRS projection — are **not** implemented yet and are not claimed here.

## Honest Scalability Position

A matching engine for one instrument is fundamentally **single-writer** — all orders for a symbol must sequence against the same book, or double-spends occur. This project does **not** claim "scalable." The production scaling answer is **sharding across instruments** (one engine per symbol) plus decoupling the stateless API tier.

---

## Roadmap

- [x] **Stage 0** — Transactional Postgres baseline, hardened, with committed invariant harness
- [x] **Stage 0.5** — Load harness (k6) + measured baseline (no tuning)
- [ ] **Stage 1** — Baseline measurement under load; profile the wall
- [ ] **Stage 2** — In-memory matching (single-threaded, lock-free)
- [ ] **Stage 3** — Custom WAL (group commit, CRC32 torn-write protection, crash recovery)
- [ ] **Stage 4** — Async projection to Postgres read-model (CQRS)

## License

ISC
