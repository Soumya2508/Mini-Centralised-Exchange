# Mini Centralised Exchange

A durable, decoupled, multi-process order-matching exchange built in TypeScript. This project takes a disciplined, **measured** approach — starting from a correct Postgres baseline and building toward a custom Write-Ahead Log (WAL) for durability, with every optimization licensed by real benchmarks.

## The Engineering Story

> *"The database gives you safety but safety is slow; RAM is fast but volatile. This project is the disciplined journey away from a correct-but-slow Postgres baseline and BACK to durability by another route — a custom WAL — while keeping RAM-speed matching."*

## Architecture & Stages

The project is built in **measured stages**, where each stage is justified by a benchmark, not an assumption:

| Stage | What | Why |
|-------|------|-----|
| **Stage 0** ✅ | Fully-transactional Postgres baseline | The honest starting point — can't claim I need complexity until I've built the simple thing and shown where it breaks |
| **Stage 0.5** | Load harness (k6) | Must produce my own numbers, not assert textbook ones |
| **Stage 1** | Measure the baseline under load | The measurement licenses the next stage — if no wall appears, stop |
| **Stage 2** | In-memory matching (single-threaded) | Justified only if Stage 1 shows matching is the bottleneck. Consequence: durability is lost |
| **Stage 3** | Custom WAL with group commit + crash recovery | Rebuild durability without reintroducing the Stage-1 wall. The centerpiece |
| **Stage 4** | Async projection to Postgres read-model | Log stays source of truth; Postgres becomes a derived, queryable view (CQRS) |

### Current Status: **Stage 0 — Complete** ✅

---

## What Stage 0 Delivers

A correct, fully-transactional order-matching exchange where every order is processed inside a single `BEGIN...COMMIT` with row-level locking (`SELECT ... FOR UPDATE`).

### The Non-Negotiable Rule
The order path is **seven writes, one atomic unit**:
1. Lock & read the buyer's balance
2. Lock & read the best matching resting order (price-time priority)
3. Debit USDC from buyer
4. Credit SOL to buyer
5. Debit SOL from seller
6. Credit USDC to seller
7. Update order statuses + insert trade record

**All-or-nothing** — if the process crashes mid-way, Postgres rolls back everything. No half-executed orders, no destroyed money.

### Two Dangers It Protects Against

| Danger | Protection |
|--------|------------|
| **Crash mid-transaction** (atomicity) | `BEGIN...COMMIT` — all 7 writes succeed or all are rolled back |
| **Two buyers racing for the same shares** (double-spend) | `SELECT ... FOR UPDATE` — row lock serializes concurrent access |

---

## Tech Stack

- **TypeScript** — type-safe backend
- **Express** — HTTP API server
- **PostgreSQL 16** — transactional data store (via Docker)
- **node-postgres (pg)** — connection pool to Postgres

## Project Structure

```
Mini-Centralised-Exchange/
├── db/
│   └── init.sql              # Schema + seed data (auto-runs on first Docker start)
├── src/
│   ├── db.ts                 # Postgres connection pool
│   ├── server.ts             # Express API (POST /order, GET /balances, etc.)
│   ├── orderProcessor.ts     # Transactional matching logic (BEGIN...COMMIT)
│   └── test-connection.ts    # DB connectivity test
├── docker-compose.yml        # Postgres container config
├── package.json
└── tsconfig.json
```

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/Soumya2508/Mini-Centralised-Exchange.git
cd Mini-Centralised-Exchange

# 2. Install dependencies
npm install

# 3. Start Postgres (Docker)
docker compose up -d

# 4. Start the exchange API
npm run dev
```

The `init.sql` script automatically creates tables and seeds 5 test users on first run.

### Reset Database
```bash
docker compose down -v && docker compose up -d
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/order` | Place a buy/sell order |
| `GET` | `/balances` | View all user balances |
| `GET` | `/orders` | View all orders |
| `GET` | `/trades` | View all executed trades |
| `GET` | `/health` | Health check |

### Example: Place an Order
```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "symbol": "SOL_USDC", "side": "buy", "price": 100, "quantity": 5}'
```

---

## Seed Data

### Users & Balances
| User | USDC | SOL |
|------|------|-----|
| Alice (id=1) | 10,000 | 50 |
| Bob (id=2) | 10,000 | 50 |
| Carol (id=3) | 10,000 | 50 |
| Dave (id=4) | 10,000 | 50 |
| Eve (id=5) | 10,000 | 50 |

### Resting Sell Orders (Order Book)
| Seller | Price | Quantity | Status |
|--------|-------|----------|--------|
| Bob | 90 USDC | 5 SOL | Open |
| Carol | 95 USDC | 3 SOL | Open |
| Dave | 110 USDC | 8 SOL | Open |

---

## Correctness Tests — Stage 0

### Test 1: Price Improvement ✅
**Scenario:** Alice bids 100 USDC for 5 SOL. Bob's resting sell is at 90.

**Expected:** Trade executes at **90** (resting order's price), not 100. Buyer gets price improvement.

**Result:**
```
Trade: { price: 90, quantity: 5 }
Alice: USDC 10000 → 9550 (-450), SOL 50 → 55 (+5)
Bob:   USDC 10000 → 10450 (+450), SOL 50 → 45 (-5)
```
✅ Alice saved 50 USDC (5 × 10) through price improvement. Zero money created or destroyed.

---

### Test 2: Price-Time Priority ✅
**Scenario:** After Bob's order is filled, Eve bids 100 for 3 SOL. Carol's sell at 95 is the next cheapest.

**Expected:** Skips the filled order, matches Carol at **95**.

**Result:**
```
Trade: { price: 95, quantity: 3 }
Eve:   matched Carol at 95, not the filled Bob order
```
✅ The matching engine correctly walks the price ladder.

---

### Test 3: No Match Above Limit ✅
**Scenario:** Only Dave's sell at 110 remains. Alice bids 100.

**Expected:** Rejected — 110 > 100, no valid match.

**Result:**
```
{ "success": false, "error": "No matching resting order found" }
```
✅ The engine correctly refuses to match when no sell exists at or below the buyer's limit.

---

### Test 4: Double-Spend Prevention (Concurrent Buyers) ✅
**Scenario:** Bob has ONE sell order for 5 SOL. Alice and Eve BOTH send buy orders for 5 SOL **simultaneously**.

**Expected:** Only ONE buyer fills. The other is rejected. Bob does NOT sell 10 SOL when he only has 5.

**Result:**
```
Alice: ✅ Filled (5 SOL at 90)
Eve:   ❌ Rejected ("No matching resting order found")

Final balances:
  Alice: USDC -450, SOL +5
  Bob:   USDC +450, SOL -5
  Eve:   UNCHANGED (0, 0)
  Total: USDC net = 0, SOL net = 0 ← conservation holds
```
✅ `SELECT ... FOR UPDATE` serialized the two concurrent transactions. First to acquire the lock wins; second sees the order is filled and rolls back. **No double-spend.**

---

## Matching Algorithm: Price-Time Priority

The matching engine follows the standard price-time priority algorithm used by NYSE, NASDAQ, and all major exchanges:

1. **A buy order** matches the **cheapest available sell** at or below the buyer's limit price
2. **A sell order** matches the **most expensive available buy** at or above the seller's limit price
3. **Ties** are broken by **time** — the older order gets filled first
4. **Trade price** = the resting order's price (price improvement for the taker)

```sql
-- For a buy order: find the cheapest sell at or below the bid
SELECT * FROM orders
WHERE symbol = $1 AND side = 'sell' AND status IN ('open', 'partial')
  AND price <= $3          -- at or below buyer's limit
ORDER BY price ASC, id ASC -- cheapest first, then oldest
LIMIT 1 FOR UPDATE;        -- lock to prevent double-spend
```

---

## Concepts Showcased

| Domain | Concepts |
|--------|----------|
| **DBMS** | Transactions, ACID, atomicity, durability via fsync, row-level locking, `SELECT ... FOR UPDATE` |
| **System Design** | Multi-process architecture, connection pooling, price-time priority matching |
| **Concurrency** | Race condition prevention, serialization via row locks (Stage 0) → single-writer (Stage 2+) |
| **OS** | OS page cache vs fsync, buffered I/O, memory volatility |

## Honest Scalability Position

A matching engine for one instrument is fundamentally **single-writer** — all orders for a symbol must sequence against the same book, or double-spends occur. This project does **not** claim "scalable." The production scaling answer is **sharding across instruments** (one engine per symbol) and decoupling the stateless API tier.

---

## Roadmap

- [x] **Stage 0** — Transactional Postgres baseline with correctness tests
- [ ] **Stage 0.5** — Load harness (k6) for benchmark-driven development
- [ ] **Stage 1** — Baseline measurement under load; profile the wall
- [ ] **Stage 2** — In-memory matching (single-threaded, lock-free)
- [ ] **Stage 3** — Custom WAL (group commit, CRC32 torn-write protection, crash recovery)
- [ ] **Stage 4** — Async projection to Postgres read-model (CQRS)

## License

ISC
