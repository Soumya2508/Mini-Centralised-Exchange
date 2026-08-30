# Mini Centralised Exchange

An order-matching exchange built in TypeScript, developed in **measured stages** — starting from a correct, fully-transactional Postgres baseline and building toward a custom Write-Ahead Log, with every optimisation licensed by a benchmark rather than an assumption.

## The Engineering Story

> *"The database gives you safety but safety is slow; RAM is fast but volatile. This project is the disciplined journey away from a correct-but-slow Postgres baseline and BACK to durability by another route — a custom WAL — while keeping RAM-speed matching."*

## Architecture & Stages

| Stage | What | Why |
|-------|------|-----|
| **Stage 0** ✅ | Fully-transactional Postgres baseline | The honest starting point — can't claim I need complexity until I've built the simple thing and shown where it breaks |
| **Stage 0.5** ✅ | Load harness (k6) | Must produce my own numbers, not assert textbook ones |
| **Stage 1** ✅ | Measure the baseline under load | The measurement licenses the next stage — if no wall appears, stop |
| **Stage 2** ✅ | In-memory matching (single-threaded) | Justified only if Stage 1 shows matching is the bottleneck. Consequence: durability is lost |
| **Stage 3** ◐ | Custom WAL with group commit + crash recovery | Rebuild durability without reintroducing the Stage-1 wall. The centerpiece |
| **Stage 4** | Async projection to Postgres read-model | Log stays source of truth; Postgres becomes a derived, queryable view (CQRS) |

### Current status: **Stage 3 Step 2 — durable WAL with group commit**

Stage 0 built a correct transactional Postgres baseline. Stage 1 profiled its wall at **~181 orders/sec**, dominated by **row-lock contention** (54.2% of backend samples) rather than fsync (0.15%). Stage 2 moved matching into a **single-threaded in-memory engine** — fast, but durability deliberately deleted. Stage 3 rebuilds durability by another route: a **write-ahead log**, written before each order touches memory and fsync'd before any acknowledgement, with crash recovery by deterministic replay. Step 2 adds **group commit**, amortising one fsync across a batch.

| Stage | throughput (ord/s) | p95 | durable? |
|-------|-------------------|-----|----------|
| Stage 0: Postgres ACID | ~181 | 36.5ms @5VU / 162.1ms @25VU | yes (ACID) |
| Stage 2: in-memory | ~2127 | 6.62ms | **no** |
| Stage 3 Step 1: WAL, fsync-per-order | ~797 | 16.8ms | yes |
| **Stage 3 Step 2: WAL, group commit** | **~3216** | **11.6ms** | **yes** |

Because cross-session throughput on this host drifts, the load-bearing comparison is a **same-session, interleaved A/B** at 25 VUs (n=3 each):

| mode | median ord/s | p95 |
|------|-------------|-----|
| no durability at all | 3380 | 10.72ms |
| fsync per order | 1016 | 30.95ms |
| **group commit** | **3292** | **11.17ms** |

Durability cost 2365 ord/s; **group commit recovers 96.3% of it for +0.45ms p95**. Against fsync-per-order it is both **3.24x faster** and **2.8x lower latency**. A hard kill mid-load confirmed the property batching risks: 13,320 orders acknowledged, 13,341 recovered from the log — **nothing acknowledged-but-lost**, with 13,341 records replayed in 28.2ms.

Step 3 (CRC32 + length-prefixed binary format) is **not** built — the log is still JSON lines and cannot self-verify a torn trailing record. Stage 4 is not started.

**What this project does NOT have yet:** no custom WAL, no group commit, no CRC32 torn-write protection, no crash-recovery replay, no async projection. The Stage 0 Postgres path still exists in `src/orderProcessor.ts` and is still exercised by `npm test`, but the served hot path is now the in-memory engine and is **not durable**.

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

## Stage 2 — In-memory engine: ~2,127 orders/sec (11.8x)

`src/engine.ts` holds the order book and all balances in RAM and processes orders one at a time. `processOrder()` is **synchronous** — no `await`, no I/O — so Node's event loop cannot interleave two invocations. That is the whole guarantee: Stage 0 needed `SELECT ... FOR UPDATE` because many database backends touched the same rows at once; here there is exactly one writer, so there is nothing to serialise. Race-freedom is structural, not enforced at runtime.

Postgres is read **once** at boot to load the seeded starting state, then the connection pool is closed — the order path provably cannot reach the database.

Same k6 harness and steady-state protocol as Stage 1. Because state lives in RAM, every run restarts the server so it re-bootstraps a fresh engine from a freshly reset database. 25 runs, interleaved, round 1 discarded, medians of n=4 per level:

| VUs | median ord/s | min | max | spread | p50 | p95 | p99 | vs Stage 1 |
|-----|-------------|-----|-----|--------|-----|-----|-----|-----------|
| 1 | 405.9 | 384.2 | 438.4 | 13.4% | 1.40ms | 8.75ms | 17.52ms | 3.0x |
| 5 | **2194.8** | 2163.1 | 2267.3 | 4.7% | 2.08ms | 3.14ms | 5.01ms | 12.2x |
| 10 | 2090.1 | 2016.2 | 2168.9 | 7.3% | 4.54ms | 6.62ms | 8.80ms | 11.6x |
| 25 | 2027.5 | 1974.9 | 2119.5 | 7.1% | 12.10ms | 16.66ms | 19.84ms | 11.0x |
| 50 | 2048.6 | 2031.3 | 2093.2 | 3.0% | 24.42ms | 31.38ms | 36.25ms | 11.9x |

**Plateau: ~2,127 ord/s** (pooled median, VUs 5-25, n=12) against the **~181 ord/s** Stage 1 baseline — **11.8x**. p95 at the plateau fell from 36.5ms/162.1ms to a median of **6.62ms**. Match rate 100.00% on every run. Run-to-run spread tightened from 10-17% to 3-7%: with the lock manager gone, timing is far more predictable.

### Lock contention: 54.2% → 0%

`pg_stat_activity` sampled 40 times during a 25-VU in-memory run (2,136 ord/s, 42,743 orders):

```
     40 active|RUNNING          <- the sampling psql session itself, nothing else
  lock-wait samples: 0
```

The exchange holds zero database connections while serving orders. Stage 1 had 306 `Lock|tuple` + 52 `Lock|transactionid` out of 660 samples. Contention is gone by construction, not merely reduced.

### What it cost

Everything Stage 0's transaction gave for free. No atomicity across a crash, no recovery, no persistence of any kind. That is the trade this stage exists to make explicit, and Stage 3 is the answer to it.

---

## Stage 1 — The Postgres baseline it replaced: ~180 orders/sec

## Measured baseline — ~180 orders/sec

Load generated with k6 against `POST /order`, using a generated seed of 200 funded users and a 2,000-order resting sell book (`db/seed-load.sql`, `loadtest/order-load.js`). Orders are constructed to genuinely **match and commit** — `match_rate` was **100% on all 34 runs**, so these numbers measure the real transactional path, not rejection speed.

Figures below are **medians of 5 interleaved runs per level**, each against a freshly reset and reseeded database. Single-run numbers are not quoted.

| VUs | median tput (ord/s) | min | max | spread | median p95 |
|-----|--------------------|-----|-----|--------|-----------|
| 1 | 137.1 | 121.9 | 145.3 | 17.1% | 9.2ms |
| 5 | 180.2 | 167.0 | 184.8 | 9.9% | 36.5ms |
| 10 | 180.9 | 151.0 | 182.5 | 17.4% | 82.5ms |
| 25 | **184.2** | 162.3 | 185.3 | 12.5% | 162.1ms |
| 50 | 172.2 | 164.4 | 181.2 | 9.8% | 332.9ms |

**Authoritative baseline: ~180 ord/s**, pooled median across the VUs 5-25 plateau (n=15, min 151, max 185). Throughput is flat from 5 to 25 VUs — going from 5 to 25 concurrent clients buys nothing while p95 grows 36ms → 162ms. A single client already reaches 137 ord/s, so the ceiling is only ~1.3x one client.

Zero errors and **zero deadlocks** across all 34 runs — the deterministic lock ordering holds under sustained load.

> **On earlier figures.** Two superseded numbers appear in the git history: 135 ord/s (Stage 0.5) and 83 ord/s (first Stage 1 pass). Neither should be quoted. The stack is strongly warm-up sensitive — the first run of a session measures 22-41% low — and a cold drift probe here reproduced **135.3**, matching the Stage 0.5 figure and identifying it as a cold-start measurement. The 83 was measured on a Docker host degraded by hours of container churn. Full evidence in [DEVLOG.md](DEVLOG.md).

### Why the wall is where it is

Every load order is a buy at one price against one book, so all takers contend for the **head-of-book row** — a single serialisation point by construction. Profiling the remaining wall (60 samples of `pg_stat_activity` under load, 660 backend observations):

- **54.2%** of samples in lock waits (`Lock|tuple` 46.4% + `Lock|transactionid` 7.9%)
- 11.4% actually executing
- **0.15%** fsync (`IO|WALSync`)

Cross-checked with an alternating `synchronous_commit` A/B (diagnostic only, reverted): turning off durability entirely buys only **~14%**. The pool is not exhausted — ~3.2 of 10 connections sat idle under load — so it was left at its default.

Reproduce (discard at least one warm-up round):

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
- [x] **Stage 1** — Profiled the wall: index separated, dominant cost = row-lock contention
- [x] **Stage 2** — In-memory matching (single-threaded, lock-free) — 11.8x, durability dropped by design
- [◐] **Stage 3** — Custom WAL: Step 1 (append-before-execute + crash recovery) and Step 2 (group commit, ~3216 ord/s) done. Step 3 (CRC32 torn-write) pending.
- [ ] **Stage 4** — Async projection to Postgres read-model (CQRS)

## License

ISC
