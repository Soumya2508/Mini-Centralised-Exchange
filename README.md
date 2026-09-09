# Mini Centralised Exchange

A durable, decoupled, single-writer order-matching exchange in TypeScript that keeps RAM-speed matching while surviving crashes, using a custom write-ahead log instead of database transactions.

The matching engine holds the order book and every balance in memory and processes orders one at a time with no locks. Durability comes from a write-ahead log that is appended and fsynced before an order touches memory, with group commit to amortise the fsync and CRC32 framing so an interrupted write costs only the unacknowledged tail. Postgres is not the system of record — it is a derived read-model, rebuilt from the log by a separate worker process and served to clients by a separate query API.

The result is **~3,254 orders/sec while remaining crash-durable**, against **~181 orders/sec** for the fully-transactional Postgres implementation the project started from.

## Architecture

<img width="1344" height="896" alt="image" src="https://github.com/user-attachments/assets/eb9b50ad-4a4c-4aa0-8d6f-49f9f35922c3" />


## Key results

All figures are measured on this repository with the k6 harness in `loadtest/`, against a generated seed of 200 funded users and a 2,000-order resting book. Every load run asserts a match rate, so throughput reflects committed trades rather than rejections.

| Configuration | Throughput | p95 | Durable |
|---|---|---|---|
| Postgres, fully transactional (ACID) | ~181 ord/s | 36.5ms @5VU / 162.1ms @25VU | Yes, ACID |
| In-memory matching, no durability | ~2,127 ord/s | 6.62ms | **No** |
| WAL, fsync per order | ~797 ord/s | 16.8ms | Yes |
| WAL, group commit | ~3,294 ord/s | 11.20ms | Yes |
| **WAL, group commit + torn-write protection** | **~3,254 ord/s** | **11.43ms** | **Yes, and crash-corruption safe** |

Cross-session throughput on the test host drifts, so the comparisons that carry weight were re-measured same-session and interleaved. At 25 concurrent clients, three durability strategies back to back:

| Strategy | Throughput | p95 |
|---|---|---|
| No durability at all | 3,380 ord/s | 10.72ms |
| fsync per order | 1,016 ord/s | 30.95ms |
| Group commit | 3,292 ord/s | 11.17ms |

Headline figures:

- **~18x the ACID baseline** while still crash-durable.
- **Group commit recovers 96.3%** of the throughput that per-order fsync cost, for **+0.45ms p95**. Per-order fsync had given back 62.5% of the in-memory speedup.
- **CRC32 framing costs 1.2%** of throughput at 25 clients, and 0.0% pooled across load levels — below the harness's run-to-run noise.
- **Deadlocks eliminated: 40 of 40 concurrent pairs deadlocked before a lock-ordering fix, 0 after** (80 orders, identical workload).
- **Crash recovery proven by hard kill under load.** With `taskkill /F` mid-run: 13,447 orders acknowledged to clients, 13,453 recovered from the log, zero negative balances. **13,453 records replayed in 24.7ms.** The log is always a superset of what was acknowledged, never a subset.
- **Projection throughput 545 → 2,923 records/sec (5.4x)** after batching, taking the read-model from 0.26x the ingest rate — where it could never converge — to 1.4x, where it does.

Profiling of the original Postgres implementation showed the wall was **row-lock contention at 54.2% of backend samples against 0.15% for fsync**, which is what justified moving matching into memory rather than tuning the database.

## Architecture and design decisions

### The write-ahead log is the source of truth, not Redis

Order state lives in the log. Memory is a projection of it, and Postgres is a projection of it. Recovery is a deterministic replay of the log against a fresh engine.

A network-remote system such as Redis cannot be the source of truth for durability. Acknowledging an order means committing to it, and a commitment that depends on a remote hop is only as strong as that hop: a dropped message, a partition, or a failover leaves the exchange unable to say whether an acknowledged order exists. A local append-and-fsync gives an unambiguous answer at the moment of acknowledgement.

The same reasoning removes the need for a message queue between the engine and the read-model. The projection worker tails the log file directly, so there is no second channel through which state could arrive, and therefore no way for the read-model to diverge from the log. Anything Postgres contains was, by construction, read out of the log.

### Single-writer by construction, not by locking

`processOrder()` is synchronous — no `await`, no I/O, no callbacks. Node's event loop cannot interleave two invocations, so the read-modify-write sequence over the book and balances is atomic without any lock.

The Postgres implementation needed `SELECT ... FOR UPDATE` because many backends touched the same rows concurrently. With exactly one writer there is nothing to serialise. Serializability is a structural property here rather than something enforced at runtime, which is why the lock manager could be removed from the hot path entirely.

This constrains the design honestly: a matching engine for one instrument is fundamentally single-writer, because all orders for a symbol must sequence against the same book. Scaling is by sharding across instruments, not by adding threads.

### Append before execute

The record is written to the log before the order touches memory, and fsynced before anything is acknowledged to the client. If the process dies at any point, either the record is on disk and replay re-applies it, or it is not and the order was never acknowledged. Memory can never be ahead of the log.

The log records submitted commands, not their effects — recovery re-executes them. This is sound only because the engine is deterministic: no clock, no randomness, no I/O, no concurrency. The trade-off is that recovery is O(orders) rather than O(state), and matching logic cannot change in a way that alters replay of old records without a log version bump.

### Group commit

One fsync per order capped throughput at the disk's synchronous-write rate: flat across concurrency while latency scaled linearly, the signature of a fixed-rate serialised resource. Batching many orders into one fsync recovered 96.3% of that loss for 0.45ms of added p95.

The ordering is what preserves correctness. The record is written, the order is applied, the batch is fsynced, and only then is the client acknowledged. Writing precedes applying, so this is never apply-then-log. The fsync precedes the acknowledgement, so nothing is confirmed before it is on disk. An order applied but not yet fsynced exists only in RAM — if the process dies there, memory dies with it and the client was never told otherwise. There is no acknowledged-but-lost window.

Batch triggers are size, or end of event-loop turn. The delay trigger uses `setImmediate` rather than a timer: Windows has a default timer resolution near 15.6ms, so `setTimeout(1)` does not fire in 1ms, and the timer-based version measured 69 ord/s against 603 ord/s at a single client.

### CRC32 with length-prefixed framing

Each record is `[4-byte length][JSON payload][4-byte CRC32]`. The payload stays JSON so the log remains readable; only the frame is binary.

Bare JSON lines cannot self-verify. A crash midway through a write left a truncated final line, and recovery refused to start at all — making three already-acknowledged records unrecoverable. Framing fixes that with two independent checks: the length tells the reader how many bytes to expect, so a short tail is detected without parsing anything, and the CRC catches a record that is the right length but whose bytes are damaged, which length alone cannot see.

Discarding a torn trailing record is correct rather than a compromise: it can only be a record whose fsync never completed, so it was never acknowledged to anyone. A checksum failure that is not at the tail is a different thing, and recovery reports it distinctly instead of treating the log as merely short.

### CQRS: Postgres as a derived read-model

The log is the truth; Postgres is a queryable projection of it. A separate worker process tails the log and writes a normalised `readmodel` schema. A separate query API process serves clients from that schema and imports nothing but a database pool — no engine, no log, no WAL module.

The read-model lives in its own schema because the engine reads `public.*` for its genesis state. Projecting into those tables would make the next engine restart load a different genesis and replay the wrong world, letting the derived view corrupt the source of truth.

The projection cursor is updated in the same transaction as the rows it accounts for, so "wrote the data but lost the offset" is not a window that idempotency has to paper over — it cannot occur. A hard kill mid-projection rolls back cleanly and resumes from the last committed offset, with no duplicates and no gaps.

Because the read-model is derived and disposable, a schema change needs no migration: the version is bumped and the worker rebuilds from the log.

Reads and writes are decoupled but co-tenant. The engine holds zero database connections while serving, so queries cannot contend with matching on locks, connections or transactions. On a single host they still compete for CPU: hammering the query API with 25 concurrent clients moved engine throughput from 2,023 to 1,446 ord/s. That is co-tenancy, not coupling, and the decoupling is what makes the fix a deployment change — move the read side to separate hardware — rather than a redesign.

## Correctness

`npm test` runs an invariant harness of 59 assertions against both matching implementations, then compares them directly.

Three invariants are asserted throughout. **Conservation**: per-asset totals are unchanged by trading. **No negative balances**, including the case where a resting order's owner no longer holds what the order promises — a defect conservation alone cannot catch, since a negative balance still sums correctly. **A genuine concurrent race**: two buyers dispatched together against a single limited resting order, asserting that exactly one fills and the maker sells what it has and no more. The race is constructed so both buyers are eligible only for the same order, and the winner varies between runs, which is itself evidence the contention is real rather than sequential.

Dual-engine parity is the strongest check. The transactional Postgres engine and the in-memory engine are driven through identical scenarios — price improvement, price-time priority, no match above limit, partial fill resting on the book, and a rested remainder filled by a later seller — and asserted to produce identical outcomes and identical balances, down to exact error strings. This is what makes "the in-memory engine is a port, not a redesign" a verified claim rather than an assertion.

The harness also covers the durability layer: that every acknowledged order is on disk, that fsyncs are genuinely amortised across a batch, that sequence numbers are gapless, that a replayed log reconstructs state identical to the live engine, and that a torn tail is discarded without aborting recovery. The CRC implementation is checked against the standard `0xCBF43926` vector, so it is a real CRC32 rather than a self-consistent checksum.

`npx tsc --noEmit` reports zero errors under `strict` and `noUncheckedIndexedAccess`.

## How it evolved

The system was built in measured stages, each licensed by a benchmark rather than an assumption. It began as a fully-transactional Postgres implementation, whose wall was profiled at ~181 ord/s and attributed to row-lock contention rather than fsync. Matching then moved into memory, which removed the contention and deliberately destroyed durability. Durability was rebuilt as a write-ahead log — first naively with one fsync per order, then with group commit once the fsync ceiling was measured, then with CRC32 framing once a torn write was shown to make recovery fail outright. Finally Postgres returned as a derived read-model, projected from the log by a separate worker and served by a separate query API.

Several defects were found and fixed along the way, including a maker-solvency hole that let the exchange create assets from nothing, a lock-ordering bug that deadlocked 40 of 40 concurrent pairs, and a partial-fill record that discarded the user's real requested quantity. `DEVLOG.md` records each with its reproduction, fix and verification.

## Scope and limitations

**Single price level per incoming order.** The matcher consults only the best eligible price level. A taker larger than that level fills against it and rests the remainder rather than walking down the book in one pass. This is a deliberate scope cut, annotated at the call site. The extension is to loop the match step until the order is filled or no eligible level remains, accumulating fills — which changes what a single log record produces on replay, and so needs a log version bump.

**Conservative taker fund check.** A taker is validated against price × full requested quantity rather than what it will actually spend on a partial fill, so it can be rejected for funds it would never have spent. Documented and unchanged.

**Read and write sides are co-tenant.** They are architecturally decoupled — no shared locks, connections or transactions — but share CPU on one host, which is measurable under concurrent load. Separating them is a deployment change.

**Single instrument, single writer.** Matching for one symbol cannot be parallelised without losing sequencing. Scaling is by sharding across instruments and decoupling the stateless tiers, not by threading the engine.

**Genesis state comes from the seeded database**, with the log authoritative for everything after boot. This is sound while the seed is fixed; a production system would pin it with a snapshot, or log genesis as record zero.

**Measurement caveat.** All figures come from a single Windows host with client, engine and Postgres co-resident, and run-to-run variance is roughly 10%. Numbers are order-of-magnitude rather than server-grade, and are quoted at the precision the measurements support.

## Running it

Requires Node.js 18+ and Docker.

```bash
npm install
docker compose up -d          # Postgres 16; db/init.sql creates schema and seeds 5 users
```

Run the correctness harness:

```bash
npm test
```

Start the exchange. Each of these is an independent process:

```bash
npm run dev                   # matching engine + write API on :3000
npm run projector             # projection worker: tails the WAL into readmodel.*
npm run readapi               # query API on :3001, reads readmodel.* only
```

Place an order:

```bash
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "symbol": "SOL_USDC", "side": "buy", "price": 100, "quantity": 5}'
```

Query the read-model:

```bash
curl "http://localhost:3001/history?userId=1"
curl "http://localhost:3001/openorders?userId=1"
curl "http://localhost:3001/orderbook?symbol=SOL_USDC"
curl "http://localhost:3001/stats"          # read-model freshness and projection lag
```

Load testing. Seed the larger book first, and restart the engine afterwards so it bootstraps the new genesis:

```bash
npm run seed:load             # 200 funded users, 2,000-order resting book

docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e BASE_URL=http://host.docker.internal:3000 -e VUS=25 -e DURATION=20s \
  grafana/k6:latest run - < loadtest/order-load.js

docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e READ_URL=http://host.docker.internal:3001 -e VUS=25 -e DURATION=20s \
  grafana/k6:latest run - < loadtest/read-load.js
```

Discard at least one warm-up round before recording numbers: the first run of a session measures 22-40% low.

Reset everything:

```bash
docker compose down -v && docker compose up -d
rm -rf data                   # clears the write-ahead log
```

### API reference

Write side, port 3000:

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/order` | Place an order |
| `GET` | `/health` | Engine status, WAL mode, batch settings |
| `GET` | `/state` | Balance totals, order and trade counts |
| `GET` | `/orders`, `/trades`, `/balances` | In-memory state, for debugging |

Read side, port 3001, served entirely from `readmodel.*`:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/history?userId=` | A user's trade history |
| `GET` | `/openorders?userId=` | A user's resting orders |
| `GET` | `/balances[?userId=]` | Per-user balances, or per-asset totals |
| `GET` | `/orderbook?symbol=` | Aggregated book by price level |
| `GET` | `/market?symbol=` | Recent trade tape |
| `GET` | `/stats` | Projection cursor and read-model freshness |

## Tech stack

TypeScript, Node.js, Express, PostgreSQL 16 (Docker), node-postgres, k6 for load generation.

## License

ISC
