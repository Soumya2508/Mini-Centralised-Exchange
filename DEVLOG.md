# DEVLOG

A running record of what was actually built, found, and verified. Only observed facts — outputs are pasted from real runs, not summarised.

---

## [2026-08-27] — Stage 0 hardening: three defects found, fixed, and verified

**Stage:** 0
**Trigger:** independent verification of the first Stage 0 draft. The draft's README claimed four passing correctness tests. Re-running them showed one was not reproducible, and reading the code surfaced two further defects.

**Schema note:** the balance amount column is **`available`** (`NUMERIC(20,8) NOT NULL DEFAULT 0`). There is no `amount` column. Any invariant query written against `SUM(amount)` would have errored rather than passed.

### What was wrong with the original "Test 4"

The draft claimed `SELECT ... FOR UPDATE` was proven to prevent double-spend, with Eve rejected while Alice filled. Re-run as a genuine race (`Promise.all`, both requests in flight):

```
Alice: FILLED  {"price":90,"quantity":5}
Eve:   FILLED  {"price":95,"quantity":3}
```

Eve was **not** rejected — she correctly fell through to the next price level. The original test had run after earlier tests had already consumed both Bob's and Carol's orders, so Eve was rejected for having *no eligible supply*, not because of locking. The test passed for the wrong reason.

Proving the lock required forcing contention on one row — both buyers bidding 90, so only Bob's 5 @ 90 is eligible:

```
Alice: REJECTED (No matching resting order found)
Eve:   FILLED  {"price":90,"quantity":5}
```

Bob sold exactly 5, Alice untouched, totals unchanged. The winner varies between runs.

### Bug 1 — maker balance never validated (critical)

The processor validated the **taker's** balance but never the **resting order owner's**. A resting order backed by funds the maker no longer held would still execute.

Reproduced — Bob holds `1.00000000` SOL against a resting 5 SOL sell; Alice buys 5:

```
{"success":true,"trade":{"tradeId":1,"price":90,"quantity":5}}
bob | SOL | -4.00000000
negative_balances = 1
```

The exchange created 4 SOL from nothing.

**Critically, the conservation invariant does not catch this.** `SUM(SOL)` was `201.00000000` both before and after — identical — because a negative balance still sums correctly. Conservation alone is insufficient; a no-negative-balances assertion is required.

A second defect surfaced in the same code: the counterparty lock query passed `input.userId` on the sell path, i.e. it re-locked the *taker*, so a sell-side maker was never row-locked at all.

**Fixed:**
- `db/init.sql:19` — `CHECK (available >= 0)` (and `:20` for `locked`) as a structural backstop
- `src/orderProcessor.ts:116-129` — maker balance validated before execution

**Confirmed**, identical reproduction:

```
{"success":false,"error":"Maker (user 2) has insufficient SOL: have 1, need 5"}
bob | SOL | 1.00000000
negative_balances = 0 | trades = 0 | order still open
```

Both layers were verified independently: during an interim run where the application check was not yet live, the constraint alone rejected the write with `violates check constraint "balances_available_check"`.

### Bug 3 — inconsistent lock ordering caused deadlocks

Each transaction locked its **own** balance row first, then the counterparty's. Two users trading into each other therefore acquired the same two rows in opposite order — a guaranteed cycle.

Reproduced over **40 concurrent pairs = 80 orders**:

```
filled = 40   DEADLOCK = 40   other rejects = 0
```

**Fixed:** `src/orderProcessor.ts:87-96` — every balance row for both parties locked in a single query, `ORDER BY user_id, asset FOR UPDATE`. Postgres locks rows in the order the plan returns them, so both sides of any pair acquire them in the same global order and queue instead of cycling.

**Confirmed**, same 40 pairs / 80 orders:

```
filled = 80   DEADLOCK = 0   other rejects = 0
```

Deadlocks 40 → 0. This was fixed *before* any load work, so that Stage 1's measurement is not polluted by deadlock retries masquerading as the bottleneck.

### Bug 4 — partial fills falsified the order record

The incoming order was stored with `quantity = fillQty`, destroying the user's real request.

Reproduced — Bob rests 5 SOL @ 90, Alice buys **10** @ 90:

```
 4 | 1 | buy | 90.00000000 | 5.00000000 | 5.00000000 | filled
```

Alice's request for 10 is gone, and a partial fill is recorded as complete.

**Fixed:** `src/orderProcessor.ts:170-182` — store the original `quantity`, the separate `filled` amount, and `status='partial'`.

**Confirmed:**

```
 4 | 1 | buy | 90.00000000 | 10.00000000 | 5.00000000 | partial
```

### Decision 1 (new) — partially-filled taker orders rest on the book: KEPT

`status='partial'` falls inside the match query's `status IN ('open','partial')`, so the Bug 4 fix has a behavioural consequence: an unfilled remainder now **rests** and is matchable. Stage 0 previously never created resting orders.

Verified — a later seller filled Alice's rested remainder:

```
bob sells 5 @90:  {"tradeId":4,"price":90,"quantity":5,"buyerOrderId":12,"sellerOrderId":13}

 12 | 1 | buy  | 90 | 10 | 10 | filled
 13 | 2 | sell | 90 |  5 |  5 | filled

totals: SOL=250.00000000  USDC=50000.00000000  (unchanged)
```

**Ratified as deliberate.** "Match what's available, rest the remainder" is realistic exchange behaviour. Docs updated to describe this, replacing the old "reject the remainder" description.

### Decision 2 (new) — conservative taker fund check: documented, left as-is

The taker is validated against `price × full requested quantity`, not against what they will actually spend on a partial fill. A taker can therefore be rejected for funds they would never have spent. Known behaviour for Stage 0, deliberately unchanged.

### Still open — Bug 5, single-level match

The match query uses `LIMIT 1`, so one incoming order consults only the best eligible price level and does not walk down the book across multiple levels in a single pass. **Deliberate scope cut**, unchanged, annotated in place at `src/orderProcessor.ts:69-75`.

### Harness — `src/test/invariants.ts`, committed, wired to `npm test`

Asserts (a) conservation per asset, (b) no negative balances, (c) a genuine concurrent race via `Promise.all` against one limited resting order.

It calls `processOrder()` **directly rather than over HTTP**. This is deliberate: during this session a stale server process kept serving old code on port 3000 and made one confirmation step report the wrong mechanism. Importing the module guarantees the code under test is the code on disk.

```
Stage 0 invariant harness
=========================

(a) conservation — SUM(available) per asset unchanged by trading
  PASS  two trades executed
         alice={"ok":true,"qty":5} eve={"ok":true,"qty":3}
  PASS  SUM(available) unchanged for SOL   | before=250.00000000   after=250.00000000
  PASS  SUM(available) unchanged for USDC  | before=50000.00000000 after=50000.00000000

(b) no negative balances — including an insolvent resting-order owner
  PASS  insolvent maker is rejected | Maker (user 2) has insufficient SOL: have 1, need 5
  PASS  bob's SOL untouched | bob SOL=1.00000000
  PASS  no negative balances anywhere
  PASS  no negative balances after normal trades

(c) genuine race — two buyers, Promise.all, ONE limited resting order
  PASS  exactly one buyer filled
         alice={"ok":true,"qty":5}  eve={"ok":false,"error":"No matching resting order found"}
  PASS  bob sold exactly 5 SOL, not 10 | bob SOL=45.00000000
  PASS  SUM(available) unchanged for SOL across the race
  PASS  SUM(available) unchanged for USDC across the race
  PASS  no negative balances after race
  PASS  exactly one trade written | trades=1

=========================
ALL INVARIANTS HOLD
EXIT CODE: 0
```

**Negative control.** With the maker check disabled and the `CHECK` constraint dropped, the same harness produced `3 INVARIANT FAILURE(S)`, exit code 1, catching `bob SOL=-4.00000000`. A harness that cannot fail proves nothing — this one was verified to fail before being trusted.

### Lesson recorded

The original Stage 0 was reported as complete with four passing tests. Three of those claims were fine; one was a test that passed for the wrong reason, and two serious defects sat in code that no test exercised. Documentation of a test is not verification of a test. Every claim in the README is now output from code in the repo, reproducible from a clean `docker compose down -v`.

**Next:** decide whether to lift the Bug 5 scope cut; then Stage 0.5 (load harness).

---

## [2026-08-27 17:40] — Stage 0.5 load harness + baseline measurement

**Tool:** k6 v2.2.0, run from the official `grafana/k6` Docker image (no local install; `winget` had no working package). Script: `loadtest/order-load.js`. Seed: `db/seed-load.sql`, wired to `npm run seed:load`.

**Seed:** 200 load users (`load_u1`..`load_u200`), each funded in **both** assets — 10,000,000 USDC and 100,000 SOL. Resting book of 2,000 generated sell orders (10 per user, 50 SOL each @ 100) = 100,000 SOL of liquidity. Generated with `generate_series`, idempotent, reproducible from a fresh DB. Confirmed on a clean run:

```
 load_users | funded_balance_rows | resting_sells |  sol_liquidity
        200 |                 400 |          2003 | 100016.00000000
```

(2,003 not 2,000 — the three `init.sql` demo sells are still present.)

**Path exercised:** `match_rate = 100.00%` at every level. Every request committed a real trade — 15,378 trades written across the sweep. This measures the full transactional path (lock → match → move funds → commit), **not** rejection speed. Liquidity was never exhausted: 84,638 SOL still resting at the end. Post-run integrity: `negative_balances = 0`.

**Baseline results (fresh DB, post-deadlock-fix, 20s per level):**

| VUs | throughput (ord/s) | p50 | p95 | p99 | error% | match% |
|-----|-------------------|-----|-----|-----|--------|--------|
| 1 | 56.95 | 16.04ms | 33.19ms | 42.54ms | 0.00% | 100% |
| 5 | 135.05 | 31.30ms | 67.59ms | 174.14ms | 0.00% | 100% |
| 10 | 138.17 | 28.71ms | 198.26ms | 865.44ms | 0.00% | 100% |
| 25 | 133.21 | 170.41ms | 284.74ms | 360.68ms | 0.00% | 100% |
| 50 | 133.23 | 342.09ms | 576.92ms | 690.98ms | 0.00% | 100% |
| 100 | 140.41 | 675.72ms | 888.67ms | 1.04s | 0.00% | 100% |

Raw k6 summary at VUs=100:

```
  █ TOTAL RESULTS

    CUSTOM
    commit_latency.................: avg=699.69ms min=33.38ms med=675.72ms p(95)=888.67ms p(99)=1.04s max=2.82s
    match_rate.....................: 100.00% 2901 out of 2901
    orders_filled..................: 2901    140.414073/s

    HTTP
    http_req_duration..............: avg=699.69ms min=33.38ms med=675.72ms p(95)=888.67ms p(99)=1.04s max=2.82s
      { expected_response:true }...: avg=699.69ms min=33.38ms med=675.72ms p(95)=888.67ms p(99)=1.04s max=2.82s
    http_req_failed................: 0.00%   0 out of 2901
    http_reqs......................: 2901    140.414073/s

    EXECUTION
    iteration_duration.............: avg=700.73ms min=57.16ms med=675.92ms p(95)=888.9ms  p(99)=1.04s max=2.82s
    iterations.....................: 2901    140.414073/s
    vus............................: 100     min=100          max=100
```

**Throughput plateau observed at:** ~**135 ord/s**, reached by **5 VUs** and flat from there to 100 VUs (135 → 138 → 133 → 133 → 140). Adding 20× the concurrency bought **zero** extra throughput while p50 latency grew ~21× (31ms → 676ms) and p95 ~13× (68ms → 889ms). That is textbook saturation: past 5 concurrent clients, requests queue rather than execute. **This is the wall.** A single client already gets 57 ord/s, so the ceiling is roughly 2.4× one client's rate.

**Notes / caveats affecting the numbers:**
- **Zero deadlocks and zero errors at every level** — the Stage 0 deadlock fix holds under sustained concurrent load. Before that fix this workload would have been unusable.
- All takers are BUYs at a single price against one book, so every request contends for the **head of the book** — the same resting-order row, one at a time. That is intrinsic to a single-symbol matching engine (the single-writer property this project claims), not an artifact of the harness.
- The `orders` table grows by one row per request (~17k rows by the end) and there is **no index** on the match predicate (`symbol, side, status, price`). Part of the measured cost is therefore a growing sequential scan. Stage 1 must separate that from lock/commit cost before concluding anything.
- p99 at 10 VUs (865ms, max 8.71s) is an outlier versus its neighbours — likely a first-touch/warm-up effect. Worth re-running before treating it as signal.
- Occasional self-trades are possible (buyer randomly equals the head order's seller); they net to zero and are not prevented in Stage 0.
- Measured on a 20-core Windows host with Postgres in Docker and the API on the host — client, server and DB share one machine, so absolute numbers are not server-grade.

**Not done (deliberate):** no tuning of any kind. Pool size untouched, `synchronous_commit` untouched, no index added, no in-memory move. Stage 0.5 only measures; optimisation must be licensed by Stage 1 profiling.

**Next:** Stage 1 — profile WHICH cost dominates at the ~135 ord/s wall (fsync vs row-lock contention vs the unindexed match scan vs round-trips).

---

## [2026-08-27 22:20] — Stage 1: true wall profiling

**Index effect:** before **~87 ord/s peak, decaying to 68** → after index on `(symbol, side, price, id) WHERE status IN ('open','partial')` **~83 ord/s peak, holding 82-83**. The scan was **~0% of the ceiling** but ~100% of the *degradation*.

The index did **not** raise peak throughput. What it removed was the decay: without it throughput fell as the `orders` table grew, because every match re-scanned the whole table.

Identical sweeps, both from a fresh DB + `seed:load`, 20s per level, 10s warm-up discarded:

| VUs | no index (ord/s) | p95 | with index (ord/s) | p95 |
|-----|-----------------|-----|-------------------|-----|
| 1 | 56.18 | 27.64ms | 60.19 | 27.16ms |
| 5 | 85.00 | 126.52ms | 83.56 | 86.07ms |
| 10 | 86.96 | 371.46ms | 81.32 | 190.17ms |
| 25 | 78.90 | 424.77ms | 82.51 | 394.58ms |
| 50 | 68.44 | 935.03ms | 82.98 | 754.42ms |
| 100 | 68.09 | 1.91s | 72.42 | 2.15s |

Direct proof the scan caused the decay — same VUs=10, larger table:

```
5,000 rows  -> 86.96 ord/s
11,760 rows -> 60.83 ord/s     (-30% for ~2x the rows)
```

```
EXPLAIN (ANALYZE, BUFFERS) ... ORDER BY price, id LIMIT 1;
 Limit  (actual time=2.064..2.074 rows=1)
   ->  Sort  Sort Key: price, id
         ->  Seq Scan on orders  (actual time=0.053..1.789 rows=1781)
               Rows Removed by Filter: 11206
               Buffers: shared hit=146
 Execution Time: 3.029 ms
```

After the index — same query, no sort, 46x faster:

```
 Limit  (actual time=0.037..0.038 rows=1)
   ->  Index Scan using idx_orders_match on orders (actual time=0.036..0.036 rows=1)
 Execution Time: 0.065 ms
```

**Dominant cost of remaining wall: ROW-LOCK CONTENTION.** Evidence — 60 samples of `pg_stat_activity` during a 25-VU run, 660 backend observations:

```
    306 active|Lock|tuple              46.4%   waiting for a row lock
    193 idle|Client|ClientRead         29.2%   idle pool connection
     75 active|RUNNING|-               11.4%   actually executing
     52 active|Lock|transactionid       7.9%   waiting on another txn to finish
     27 idle in transaction|ClientRead  4.1%
      1 active|IO|WALSync               0.15%  fsync
```

Lock waits (`Lock|tuple` + `Lock|transactionid`) = **54.2%** of all backend samples. Actually executing = 11.4%. fsync = **0.15%**.

Corroborated by an alternating A/B on `synchronous_commit` (diagnostic only, reverted immediately):

```
pass1 synchronous_commit=on   tput=81.11/s  p95=439.62ms
pass1 synchronous_commit=off  tput=94.65/s  p95=352.80ms
pass2 synchronous_commit=on   tput=78.13/s  p95=420.46ms
pass2 synchronous_commit=off  tput=87.57/s  p95=394.21ms
```

Mean on = 79.6 ord/s, mean off = 91.1 ord/s. **Turning off fsync entirely buys only ~14%.** It is a real cost but not the wall. `synchronous_commit` was reset to `on` and verified.

Why this is expected rather than surprising: every load order is a BUY at one price against one book, so all takers contend for the **head-of-book row**. That row is a single serialisation point by construction — the single-writer property. Concurrency cannot help; a single client already achieves ~60 ord/s and 100 clients reach only ~72-83.

**Pool tuning: not warranted, lock contention dominates.** The pool is not exhausted — ~3.2 of 10 connections were *idle* at any instant (29.2% of samples) while 25 VUs were in flight. Exhaustion would show all connections busy and zero idle. The connections that exist are blocked on row locks; adding more would only add more waiters on the same row. Pool config left untouched at its default (`max` unset = 10).

**True measured wall (post-index):** **~83 ord/s peak**, flat from 5 to 50 VUs, p95 **86ms at 5 VUs** rising to **754ms at 50 VUs**.

**Measurement caveats:** run-to-run variance at fixed load is ~10% (three consecutive VUs=25 runs: 73.2 / 67.6 / 75.0). Stage 0.5 reported ~135 ord/s peak; this Stage 1 baseline reproduced ~85 on the same code and seed, so that earlier figure is **not reliable** and should be read as "same order of magnitude" only. Absolute numbers here are a range, not a point. Client, API and Postgres all share one Windows host. Throughput still decays slowly with table size even with the index (index maintenance on insert, growing `trades`).

**Not done (deliberate):** matching not moved in-memory, no WAL, no pool change, `synchronous_commit` reverted to default.

**Licensing question for human:** the wall is row-lock contention on a single head-of-book row, at ~83 ord/s. Postgres row locking is doing exactly what it should. Removing fsync buys 14%; indexing bought stability but no ceiling. The remaining lever that addresses the *actual* dominant cost is removing the round-trip-per-lock model entirely — i.e. single-threaded in-memory matching where the "lock" is just being the only writer. **Does this measurement license Stage 2, or is ~83 ord/s adequate and the honest move to stop?** Human decides.

---

## [2026-08-28] — Stage 1: repeated-measures baseline (settles the 135 vs 83 gap)

**Why:** Stage 0.5 reported ~135 ord/s and Stage 1 reported ~83 on identical code, seed and protocol. A 1.6x gap that ~10% run-to-run variance cannot explain. No code was changed for this entry — measurement only.

**Method:** 34 k6 runs, 15s each, `VUS` levels 1/5/10/25/50, **interleaved** (6 rounds, each round sweeping all five levels in order — not all runs of one level back-to-back). Every run preceded by a `TRUNCATE trades, orders RESTART IDENTITY` + balance reset + re-insert of the 2,003-order resting book, so each run starts from an identical data state. Drift probes at VUs=25 at both the start and end of the session. Match rate was **100.00% on all 34 runs**.

**Per-level steady state (rounds 2-6, n=5 per level; round 1 discarded as cold):**

| VUs | n | median tput | min | max | spread | median p95 |
|-----|---|------------|-----|-----|--------|-----------|
| 1 | 5 | 137.1 | 121.9 | 145.3 | 17.1% | 9.2ms |
| 5 | 5 | 180.2 | 167.0 | 184.8 | 9.9% | 36.5ms |
| 10 | 5 | 180.9 | 151.0 | 182.5 | 17.4% | 82.5ms |
| 25 | 5 | **184.2** | 162.3 | 185.3 | 12.5% | 162.1ms |
| 50 | 5 | 172.2 | 164.4 | 181.2 | 9.8% | 332.9ms |

Plateau pooled across VUs 5/10/25 (n=15): **median 180.9**, min 151.0, max 185.3.

**Explanation of the 1.6x gap: warm-up / host state, not the code.**

Evidence 1 — the stack is strongly warm-up sensitive. Round 1 versus steady-state median, same levels, same session:

```
  VUs=1    cold=106.5   steady=137.1   cold is 22% lower
  VUs=5    cold=139.4   steady=180.2   cold is 23% lower
  VUs=10   cold=137.3   steady=180.9   cold is 24% lower
  VUs=25   cold=134.1   steady=184.2   cold is 27% lower
  VUs=50   cold=101.1   steady=172.2   cold is 41% lower
```

Evidence 2 — **the cold number reproduces the 135 almost exactly.** The start-of-session drift probe, taken on a freshly started Docker Desktop before any warm-up:

```
  driftA (session start, cold): [132.9, 137.8]  median=135.3
  driftB (session end, warm):   [172.1, 168.5]  median=170.3
```

`driftA` median **135.3** against Stage 0.5's reported **135**. Stage 0.5 ran its sweep immediately after starting the stack, with no warm-up — it measured the cold state and reported it as the baseline.

Evidence 3 — direction of drift. Within this session throughput went *up* (135 cold → 181 warm → 170 at end), so there is no monotonic within-session decay. The previous session's slide to 83 was a more severe degradation of a Docker Desktop instance that had been running for hours across dozens of container and volume recreations. That environment no longer exists, so this cause is **inferred, not proven**: what is proven is that identical code, seed and protocol on a freshly restarted Docker Desktop yields ~181, and that the measurement is highly sensitive to stack warmth.

**Both prior figures are superseded.** 135 was a cold-start measurement. 83 was measured on a degraded host. Neither should be quoted.

**AUTHORITATIVE BASELINE: ~181 orders/sec** — median of 15 steady-state runs across the VUs 5-25 plateau (min 151, max 185). p95 at the plateau: **36ms at 5 VUs**, **162ms at 25 VUs**. Throughput is flat from 5 to 25 VUs and falls to 172 at 50 VUs while p95 rises to 333ms.

**Caveats that remain:** measured on a shared Windows host with client, API and Postgres co-resident; per-level spread is 10-17%, so quote 181 as "~180 ord/s", not three significant figures. Any future measurement must discard at least one warm-up round or it will under-report by 20-40%.

**Mechanism findings from the prior entry are unaffected** — lock contention dominating (54.2% of backend samples) versus fsync (0.15%), and the index removing decay rather than the ceiling, are ratios measured within single sessions and do not depend on the absolute scale.

**Not done:** Stage 2 not started. No code changed in this entry.

---

## [2026-08-28] — Stage 2: in-memory single-writer matching

**Change:** matching moved to RAM — a single-threaded engine (`src/engine.ts`) holding the order book and all balances in memory. No row locks, no per-order DB transaction, nothing written to disk on the hot path. Postgres is read exactly once at boot (`src/bootstrap.ts`) to load the seeded starting state, then the pool is closed, so the order path provably cannot touch the database.

Licensed by Stage 1: row-lock contention was 54.2% of backend samples against 0.15% for fsync, so the indicated move was to remove the lock manager from the hot path.

**Race-free by construction, not by locking.** `processOrder()` is **synchronous** — no `await`, no I/O, no callback. Node's event loop cannot interleave two invocations: one runs to completion before any other JavaScript runs. Stage 0 needed `SELECT ... FOR UPDATE` because many Postgres backends touched the same rows concurrently; here there is exactly one writer, so there is nothing to serialise. Making this function `async` would silently destroy the guarantee, and the file says so at the call site.

**Matching semantics: unchanged from Stage 0.** Price-time priority, at-or-below limit for buys, trade at the resting order's price, ONE price level per incoming order (the `LIMIT 1` scope cut, Bug 5, still open), partial takers keep their original quantity and rest on the book, conservative taker fund check, maker solvency check. The in-memory negative-balance guard replaces `CHECK (available >= 0)`, which does not exist in RAM.

### ⚠️ DURABILITY: DELIBERATELY DROPPED

A crash — process kill, power loss, unhandled throw — now loses **all** state: every balance, every resting order, every trade executed since boot. There is no log, no snapshot, no recovery. Money that "moved" is gone. Restarting reloads only the seeded starting state.

This is the intended consequence of the Stage 1 → Stage 2 trade, not an oversight, and must not be patched in place. Stage 3 rebuilds durability by another route (write-ahead log, group commit, crash recovery). Adding any persistence here would pre-empt Stage 3 and make its measurement meaningless. The warning is repeated in `engine.ts`, `bootstrap.ts`, `server.ts`, the harness banner and the README.

**Correctness:** `npm test` now runs the same invariants against **both** engines and then compares them directly, so "a port, not a redesign" is proved rather than asserted — 33 assertions, all passing:

```
A. STAGE 0 — transactional Postgres engine
  (a) conservation      PASS x3   alice={"ok":true,"qty":5,"price":90} eve={"ok":true,"qty":3,"price":95}
  (b) no negatives      PASS x3   Maker (user 2) has insufficient SOL: have 1, need 5
  (c) genuine race      PASS x6   exactly one buyer filled; bob sold exactly 5, not 10; trades=1

B. STAGE 2 — in-memory single-writer engine
  (a) conservation      PASS x3   total unchanged USDC 50000, SOL 250
  (b) no negatives      PASS x3   Maker (user 2) has insufficient SOL: have 1, need 5
  (c) genuine race      PASS x6   exactly one buyer filled; bob SOL=45; trades=1

C. PARITY — identical scenarios, identical observable outcomes
  PASS  price improvement                    FILL 5@90
  PASS  price-time priority                  FILL 5@90 | FILL 3@95
  PASS  no match above limit                 FILL 5@90 | FILL 3@95 | REJECT No matching resting order found
  PASS  partial fill rests remainder         FILL 5@90
  PASS  rested remainder filled later        FILL 5@90 | FILL 5@90
  (each paired with a same-balances assertion: alice/bob SOL,USDC identical)

ALL INVARIANTS HOLD (both engines agree)
```

Parity holds down to the exact error strings and final balances, across all five scenarios.

**Throughput:** same k6 harness and steady-state protocol as Stage 1. Because state now lives in RAM, resetting the database no longer resets the engine — so **every run restarts the server**, which re-bootstraps a fresh engine from a freshly reset and reseeded database. 25 runs, 15s each, interleaved, round 1 discarded.

| VUs | n | median ord/s | min | max | spread | p50 | p95 | p99 | vs Stage 1 |
|-----|---|-------------|-----|-----|--------|-----|-----|-----|-----------|
| 1 | 4 | 405.9 | 384.2 | 438.4 | 13.4% | 1.40ms | 8.75ms | 17.52ms | 3.0x |
| 5 | 4 | **2194.8** | 2163.1 | 2267.3 | 4.7% | 2.08ms | 3.14ms | 5.01ms | 12.2x |
| 10 | 4 | 2090.1 | 2016.2 | 2168.9 | 7.3% | 4.54ms | 6.62ms | 8.80ms | 11.6x |
| 25 | 4 | 2027.5 | 1974.9 | 2119.5 | 7.1% | 12.10ms | 16.66ms | 19.84ms | 11.0x |
| 50 | 4 | 2048.6 | 2031.3 | 2093.2 | 3.0% | 24.42ms | 31.38ms | 36.25ms | 11.9x |

Plateau pooled (VUs 5/10/25, n=12): **median 2126.8 ord/s**, min 1974.9, max 2267.3.

**In-memory ~2,127 ord/s vs the ~180.9 ord/s authoritative baseline = 11.8x speedup.** p95 at the plateau fell from 36.5ms (5 VUs) / 162.1ms (25 VUs) to a median of **6.62ms**. Match rate was 100.00% on every run. Run-to-run spread also tightened from Stage 1's 10-17% to 3-7% — with the lock manager gone, the timing is far more predictable.

Note: unlike Stage 1, round 1 was **not** anomalous here (it was marginally the fastest). Because every run restarts the server, each run is equally cold, so the warm-up effect that made Stage 1's first round 22-41% low does not apply. Round 1 was still discarded for protocol consistency.

**Lock contention: eliminated.** `pg_stat_activity` sampled 40 times during a 25-VU in-memory run (2136 ord/s, 42,743 orders, 100% match):

```
     40 active|RUNNING          <- the sampling psql session itself, nothing else
  lock-wait samples: 0
```

The exchange holds **zero** database connections while serving orders — the pool is closed after bootstrap. Against Stage 1's 306 `Lock|tuple` + 52 `Lock|transactionid` out of 660 samples, row-lock contention went from **54.2% to 0%**. It is gone by construction, not merely reduced.

**Still open:** Bug 5 (single-level match) — unchanged, deliberate scope cut, carried into the in-memory engine as-is.

**Next:** Stage 3 (WAL) — restore durability without reintroducing the Stage 1 wall. Human-driven, not autonomous.

---

## [2026-08-28] — Stage 3 Step 1: minimal WAL (append-before-execute, fsync-per-order, crash recovery)

**Change:** durability restored on top of the in-memory engine by a sequential append-only log (`src/wal.ts`, `src/recover.ts`) instead of a transactional database round-trip. Order path is now:

```
validate request shape  ->  append JSON line to WAL  ->  fsync  ->  apply to engine
```

The fsync is the durability point. If the process dies after the fsync and before the apply, replay re-applies the order; if it dies during the write, the record never lands and memory never saw it either. **Memory can never be ahead of the log.**

**What is logged: commands, not effects.** Each line is the submitted order, not the balance deltas it produced. Recovery is deterministic re-execution against a fresh engine. This is sound only because `processOrder()` is synchronous and deterministic — no clock, no randomness, no I/O, no concurrency. Cost of the choice: recovery is O(orders) rather than O(state), and the matching logic can never change in a way that alters replay of old records without a log version bump. Benefit: records are tiny and the log is readable with `cat`.

Rejected orders are logged too — they were genuinely submitted, and replay rejects them identically. Malformed HTTP requests are rejected *before* the log and never enter it.

**Deviation from the brief, flagged:** the brief asked for a Docker volume. This app is a host process (only Postgres is containerised), so a Docker volume does not apply to it. The log is a host file (`data/wal.log`, overridable via `WAL_PATH`), which delivers the property that mattered — survives process kill, container restart and reboot.

**Genesis split:** Postgres supplies the t=0 seeded state; the WAL is authoritative for everything after boot. That is sound only while the seed is fixed. A real system would pin this with a snapshot or log genesis as record 0. Called out rather than pretended away.

### Crash recovery — PROVED, twice, with a hard kill

The log is human-readable by design at this step:

```
{"seq":1,"ts":1788122931822,"userId":1,"symbol":"SOL_USDC","side":"buy","price":100,"quantity":5}
{"seq":2,"ts":1788122931870,"userId":5,"symbol":"SOL_USDC","side":"buy","price":100,"quantity":3}
{"seq":3,"ts":1788122931930,"userId":1,"symbol":"SOL_USDC","side":"buy","price":100,"quantity":4}
{"seq":4,"ts":1788122931985,"userId":3,"symbol":"SOL_USDC","side":"buy","price":95,"quantity":2}
{"seq":5,"ts":1788122932038,"userId":2,"symbol":"SOL_USDC","side":"sell","price":110,"quantity":6}
{"seq":6,"ts":1788122932100,"userId":4,"symbol":"SOL_USDC","side":"buy","price":50,"quantity":1}
```

`taskkill /F` — a hard kill, no graceful shutdown, no flush:

```
SUCCESS: The process with PID 19072 has been terminated.
listeners on 3000 after kill: 0
server responds? DEAD (expected)
```

Restart, rebuilding state purely from genesis + log:

```
  genesis:  10 balances, 3 resting orders (Postgres)
  RECOVERY: replayed 6 WAL records in 0.3ms (2 applied, 4 rejected)
  WAL:      data/wal.log (587 bytes), resuming at seq 7
```

A second cycle compared **full** snapshots — `/state` plus every order plus every trade:

```
=== FULL STATE DIFF (state + every order + every trade) ===
  IDENTICAL — byte-for-byte across state, orders and trades
  compared 1346 bytes
```

Recovered book after the second crash, rebuilt from nothing but the log:

```
  id=1 u=2 sell p=   90 qty=5 filled=5 filled
  id=2 u=3 sell p=   95 qty=3 filled=3 filled
  id=3 u=4 sell p=  110 qty=8 filled=7 partial   <- partial state survived
  id=4 u=1 buy  p=  100 qty=5 filled=5 filled
  id=5 u=5 buy  p=  100 qty=3 filled=3 filled
  id=6 u=2 buy  p=  110 qty=4 filled=4 filled
  id=7 u=5 buy  p=  115 qty=3 filled=3 filled
```

Recovery time: **0.3ms for 9 records**.

**Correctness:** `npm test` now covers four sections — Stage 0 (Postgres), Stage 2 (RAM), parity between them, and Stage 3 (WAL). All pass:

```
D. STAGE 3 STEP 1 — WAL-backed engine (append + fsync, then apply)
  (a) conservation
  PASS  two trades executed | alice={"ok":true,"qty":5,"price":90} eve={"ok":true,"qty":3,"price":95}
  PASS  total unchanged for USDC | before=50000  after=50000
  PASS  total unchanged for SOL  | before=250    after=250
  PASS  every order was fsync'd individually | appends=2 fsyncs=2
  (b) no negative balances
  PASS  insolvent maker is rejected | Maker (user 2) has insufficient SOL: have 1, need 5
  PASS  rejected order is STILL in the log
  PASS  no negative balances anywhere
  (c) genuine race — Promise.all, ONE limited resting order
  PASS  exactly one buyer filled
  PASS  bob sold exactly 5 SOL, not 10
  PASS  total unchanged for USDC/SOL across the race
  PASS  no negative balances after race
  (d) crash recovery — replay rebuilds identical state
  PASS  log holds every submitted order | records=6 submitted=6
  PASS  replayed state is IDENTICAL to live state | 1162 bytes of state matched

ALL INVARIANTS HOLD
```

### Throughput

Same protocol as Stages 1 and 2 — 25 runs, 15s, interleaved, round 1 discarded, fresh DB **and fresh WAL** per run (the WAL now persists across restarts, so it must be cleared or state carries between runs).

| VUs | n | median ord/s | min | max | spread | p50 | p95 | p99 | vs RAM | vs Postgres |
|-----|---|-------------|-----|-----|--------|-----|-----|-----|--------|------------|
| 1 | 4 | 260.3 | 242.5 | 275.8 | 12.8% | 2.49ms | 12.11ms | 22.15ms | 0.64x | 1.9x |
| 5 | 4 | 782.4 | 698.0 | 798.1 | 12.8% | 5.86ms | 9.77ms | 14.91ms | 0.36x | 4.3x |
| 10 | 4 | **805.2** | 774.3 | 809.0 | 4.3% | 11.93ms | 16.82ms | 21.85ms | 0.39x | 4.5x |
| 25 | 4 | 791.2 | 765.3 | 813.4 | 6.1% | 30.87ms | 39.88ms | 46.48ms | 0.39x | 4.3x |
| 50 | 4 | 796.0 | 647.7 | 810.0 | 20.4% | 62.39ms | 76.28ms | 84.77ms | 0.39x | 4.6x |

Plateau pooled (VUs 5/10/25, n=12): **median 796.7 ord/s**, min 698.0, max 813.4, p95 median **16.82ms**. Match rate 100.00% on every run.

### RUNNING COMPARISON

| Stage | throughput (ord/s) | p95 at plateau | durable? |
|-------|-------------------|----------------|----------|
| Stage 0: Postgres ACID | ~181 | 36.5ms @5VU / 162.1ms @25VU | yes (ACID) |
| Stage 2: in-memory, no durability | ~2127 | 6.62ms | **NO** |
| Step 1: WAL, fsync-per-order | **~797** | 16.82ms | yes (fsync per order) |

**What per-order fsync cost: 796.7 / 2126.8 = 37.5% of in-memory throughput. Durability gave back 62.5% of the Stage 2 speedup** — 2127 down to 797 ord/s. The plateau sits at ~800 fsyncs/sec, which is the disk synchronous-write rate, not a CPU or lock limit: throughput is flat from 5 to 50 VUs while latency scales linearly, the signature of a fixed-rate serialised resource.

Still **4.4x faster than the durable Postgres baseline** — the same durability guarantee at a sequential append cost instead of a transactional round-trip cost. That is the whole Stage 3 thesis, and it is now measured rather than asserted.

**This licenses Step 2 (group commit):** if one fsync per order costs 62.5% of throughput, batching N orders per fsync should recover most of it, trading a sliver of latency for throughput.

### Measurement bug caught (worth recording)

The first WAL sweep returned `match_rate = 0.00%` on every run. Cause: the `docker compose down -v` used for the crash test destroyed the 200 seeded load users, so `reset.sql` recreated no load book and every order was rejected for a missing balance. Had `match_rate` not been asserted in the harness, this would have been reported as fast "throughput" that was really rejection speed — the exact failure mode that made the original Stage 0 Test 4 pass for the wrong reason. Re-seeded and re-ran; the numbers above are from the corrected run.

**Not done (deliberate):** no group commit (Step 2), no CRC32 or length-prefixed binary format (Step 3). JSON lines cannot self-verify, so a torn trailing record currently fails replay loudly rather than being discarded — `Wal.replay` names this explicitly. That failure is what licenses Step 3.

**Next:** Step 2 — group commit, licensed by the 62.5% cost measured here. Human-driven, not autonomous.

---

## [2026-08-28] — Stage 3 Step 2: group commit (batched fsync)

**Change:** `GroupCommitWal` in `src/wal.ts` amortises one fsync across many orders. Step 1 measured a hard ceiling of ~800-1000 fsync/s, flat across concurrency — the disk's serialised synchronous-write rate. One fsync per order cannot beat it; sharing an fsync can.

**Order path — the whole correctness story is the ordering:**

```
1. write()  the record to the log     <- ordered, NOT yet durable
2. apply    the order to the engine
3. fsync    once per batch            <- THE durability point
4. ACK      the client
```

Step 1 precedes step 2, so this is never apply-then-log. Step 3 precedes step 4, so nothing is ever acknowledged before it is on disk. This is the model Postgres uses: a backend does its work and writes WAL records, then blocks at COMMIT until the WAL is flushed — several backends waiting on the same flush *is* group commit.

**Why "applied but not yet fsynced" is safe:** that state exists only in RAM. If the process dies there, memory dies with it and recovery replays a log that simply lacks the order — as if it never arrived. The client was never told otherwise, because the ack had not been sent. There is no acknowledged-but-lost window.

**Why there can be no hole in the log:** writes append in call order and a batch fsync durably commits a *prefix* of the file. If order Y is durable then every order written before it is durable too, so replay can never see Y without X.

Format unchanged — still JSON lines, still no self-verification. Torn-write protection is Step 3.

### Tuning

Measured at VUs=25, two runs per configuration:

| maxBatch | maxDelay | throughput | p50 | p95 | avgBatch |
|---------|---------|-----------|-----|-----|----------|
| 16 | 1ms | 3607 / 3500 | 6.6-6.8ms | ~10.0ms | 13.1 |
| 32 | 1ms | 3554 / 3476 | 6.3-6.5ms | ~10.6ms | 18.5 |
| 64 | 2ms | 3504 / 3379 | 6.2-6.4ms | ~11.0ms | 20.5 |
| 128 | 5ms | 1609 / 1603 | ~15.1ms | ~21.6ms | 24.8 |
| 256 | 5ms | 1611 / 1595 | ~15.1ms | ~22.1ms | 24.7 |
| 64 | 0 (setImmediate) | 3539 / 3430 | ~6.5ms | ~10.6ms | 18.5 |

A 5ms delay **halves** throughput: batches rarely fill, so nearly every flush pays the full timer. Batch size is bounded by in-flight requests, so a large `maxBatch` without matching concurrency just defers to the delay trigger.

### The Windows timer finding (this changed the default)

At **1 VU** the timer-based trigger collapsed to **69 ord/s, p50 15.3ms**. That 15.3ms is not a coincidence: Windows' default timer resolution is ~15.6ms, so `setTimeout(1)` does **not** fire in 1ms. With one order in flight the batch never fills, so every single order waited a full timer tick.

Switching the trigger to `setImmediate` (flush at the end of the current event-loop turn) instead of a timer:

| VUs | maxDelay=0 (setImmediate) | maxDelay=1ms (setTimeout) | gain |
|-----|--------------------------|--------------------------|------|
| 1 | **603.2** (p95 2.13ms) | 68.8 (p95 16.35ms) | **8.8x** |
| 5 | **1759.6** (p95 3.82ms) | 686.6 (p95 16.18ms) | **2.6x** |
| 10 | 2407.6 (p95 5.82ms) | 2206.3 (p95 8.37ms) | 1.09x |
| 25 | 3282.6 (p95 11.26ms) | 3214.2 (p95 11.44ms) | ~equal |
| 50 | 3322.1 (p95 20.06ms) | 3427.8 (p95 19.69ms) | ~equal |

**Chosen default: maxBatch=32, maxDelay=0 (setImmediate).** Equal at high concurrency, dramatically better at low. A timer-based group commit on Windows silently punishes the low-traffic case by an order of magnitude.

### Throughput (final sweep, batch=32 + setImmediate, 4 rounds, r1 discarded, n=3/level)

| VUs | n | median ord/s | min | max | p50 | p95 | p99 | avgBatch |
|-----|---|-------------|-----|-----|-----|-----|-----|----------|
| 1 | 3 | 543.9 | 537.7 | 547.7 | 1.62ms | 2.35ms | 3.15ms | 1.00 |
| 5 | 3 | 1675.3 | 1627.1 | 1683.4 | 2.65ms | 4.09ms | 5.50ms | 2.50 |
| 10 | 3 | 2332.3 | 2284.5 | 2377.7 | 3.87ms | 6.10ms | 7.71ms | 5.00 |
| 25 | 3 | **3216.2** | 3210.1 | 3227.6 | 7.06ms | 11.56ms | 14.82ms | 18.22 |
| 50 | 3 | 3232.6 | 3143.8 | 3281.1 | 14.65ms | 20.96ms | 27.60ms | 20.72 |

Match rate 100.00% on every run. Note the shape change: earlier stages plateaued from 5 VUs, group commit **keeps scaling to 25 VUs** — because batch size grows with in-flight requests, so more concurrency means a better fsync amortisation ratio. The plateau moved from 5-25 VUs to 25-50 VUs.

### The before/after that justifies group commit — measured in ONE session

Cross-session throughput comparisons on this host are unreliable (established when Stage 1's 135 vs 83 turned out to be warm-up, not code). So a `WAL_MODE` switch was added and all three strategies were measured **back-to-back, interleaved, 3 runs each**:

| VUs | mode | median ord/s | p50 | p95 |
|-----|------|-------------|-----|-----|
| 10 | none (no durability) | 3368.2 | 2.64ms | 4.67ms |
| 10 | fsync-per-order | 994.2 | 9.35ms | 13.29ms |
| 10 | group-commit | 2129.1 | 3.77ms | 9.46ms |
| 25 | none (no durability) | 3380.3 | 6.84ms | 10.72ms |
| 25 | fsync-per-order | 1015.8 | 23.63ms | 30.95ms |
| 25 | **group-commit** | **3292.4** | **6.84ms** | **11.17ms** |

**At 25 VUs: fsync-per-order 1016 -> group commit 3292 ord/s, a 3.24x improvement.**

Durability had cost 2365 ord/s (3380 down to 1016). **Group commit recovers 2277 of that — 96.3%.** The latency cost against no-durability is **+0.45ms p95** (10.72 -> 11.17ms). Against fsync-per-order, group commit is *both* 3.24x faster and 2.8x lower latency (30.95 -> 11.17ms p95).

At 10 VUs the recovery is only 47.8%, because avgBatch is ~5-7: with few requests in flight there is less to amortise. **The benefit of group commit scales with load** — which is the right shape, since that is when it is needed.

This also corrected a mistake I nearly shipped: the first group-commit runs measured ~3500 ord/s against Stage 2's recorded ~2127 for *no durability*, i.e. adding fsync appeared to make the system faster. That is impossible, and it was cross-session drift, not a real result. Same-session A/B is why the numbers above can be trusted.

### RUNNING COMPARISON

| Stage | throughput (ord/s) | p95 | durable? |
|-------|-------------------|-----|----------|
| Stage 0: Postgres ACID | ~181 | 36.5ms @5VU / 162.1ms @25VU | yes (ACID) |
| Stage 2: in-memory, no durability | ~2127 | 6.62ms | **no** |
| Step 1: WAL, fsync-per-order | ~797 | 16.8ms | yes |
| **Step 2: WAL, group commit** | **~3216** | **11.6ms** | **yes** |

Caveat on the first three rows: they were measured in earlier sessions. The same-session A/B above is the defensible comparison. Cross-session, group commit is **~18x** the Postgres ACID baseline and **~4x** fsync-per-order; same-session at 25 VUs it is **3.24x** fsync-per-order and **97.4%** of the no-durability ceiling.

### Correctness and recovery

`npm test` gained a group-commit section (E) covering conservation, no-negatives, the genuine race, batching, and replay parity. All sections pass:

```
E. STAGE 3 STEP 2 — group commit (write -> apply -> batch fsync -> ack)
  (a) conservation      PASS x3
  (b) no negatives      PASS x2   Maker (user 2) has insufficient SOL: have 1, need 5
  (c) genuine race      PASS x4   exactly one buyer filled; bob sold exactly 5, not 10
  (d) batching + durability of acks
      PASS  every acknowledged order is on disk | acked=200 onDisk=200
      PASS  fsyncs were amortised across orders | appends=200 fsyncs=4 avgBatch=50.0
      PASS  sequence numbers are gapless and ordered | first=1 last=200
  (e) crash recovery    PASS  replayed state IDENTICAL to live | 1162 bytes matched

ALL INVARIANTS HOLD
```

**Hard kill MID-LOAD** — the case batching specifically puts at risk. 25 VUs, `taskkill /F` at t=4s:

```
orders ACKNOWLEDGED as filled by k6 (HTTP 200): 13320
WAL records on disk: 13341

RECOVERY: replayed 13341 WAL records in 28.2ms (13341 applied, 0 rejected)
trades recovered from log: 13341

  acknowledged to clients : 13320
  recovered from the log  : 13341
  VERDICT: PASS - nothing acknowledged-but-lost
```

The log is a **superset** of what was acknowledged, never a subset. The 21 extra records are orders that were written and fsynced but whose HTTP response never left the process before it was killed — exactly the safe direction to err. Recovery replayed 13,341 records in **28.2ms** (~473k records/sec), rebuilding 15,344 orders, 1,735 resting orders and 13,341 trades with `negativeBalances: 0`.

**Not done (deliberate):** no CRC32, no length-prefixed binary format. JSON lines still cannot self-verify, so a torn trailing record fails replay loudly — `Wal.replay` names this. That failure licenses Step 3.

**Note:** `npx tsc --noEmit` reports 4 pre-existing strict-mode index-access errors in `engine.ts` (present since Stage 2). `tsx` transpiles without typechecking so runtime is unaffected, and `npm test` passes. Not fixed here — out of scope for this step, but worth clearing before the project is called finished.

**Next:** Step 3 — length-prefixed binary format + CRC32 torn-write protection. Human-driven, not autonomous.

---

## [2026-08-28] — Stage 3 Step 3: torn-write protection (length prefix + CRC32)

**This completes the WAL:** append-before-execute + group commit + torn-write protection + crash recovery.

### 1. The failure, reproduced first

Three valid orders were written to a Step-2 (JSON-lines) log, then a crash mid-write was simulated by appending a half-finished line:

```
=== valid WAL: 3 records, 294 bytes ===
{"seq":1,...,"quantity":5}
{"seq":2,...,"quantity":3}
{"seq":3,...,"quantity":4}

=== simulate a crash MID-WRITE: append a half-written record ===
":4}
{"seq":4,"ts":1788123456789,"userId":3,"symbol":"SOL_US

=== RECOVERY ATTEMPT with current (Step 2, JSON-lines) code ===
recovery failed: Error: WAL parse failure at line 4/4 (final line) — looks like a TORN WRITE.
    at Function.replay (src/wal.ts:151:15)
    at recover (src/recover.ts:51:36)
```

The process **refused to start**. One interrupted write made three perfectly good, already-acknowledged records unrecoverable. A durable log that cannot survive being interrupted is not durable — this is what licenses the change.

### 2. The fix: framed records

```
[4-byte length BE] [JSON payload bytes] [4-byte CRC32 BE]
```

The payload stays JSON so the log is still debuggable; only the frame around it is binary. On disk:

```
0000000 00 00 00 61 7b 22 73 65 71 22 3a 31 2c 22 74 73  >...a{"seq":1,"ts<
0000016 22 3a 31 37 38 38 31 32 38 32 36 36 31 38 37 2c  >":1788128266187,<
```

Two **independent** checks, and both are needed:

- **Length** tells the reader exactly how many bytes to expect, so a short tail is detected without parsing anything.
- **CRC32** catches a record that is the right length but whose bytes are damaged. Length alone cannot see that.

Append-before-execute and group commit are unchanged — only the bytes written per record changed.

Discarding a torn **trailing** record is correct rather than a compromise: it can only be a record whose fsync never completed, which means it was never acknowledged to any client. Nobody was told it succeeded. A checksum failure that is *not* at the tail is a different thing — real corruption, not an interrupted write — so replay reports it distinctly instead of pretending the log is merely short.

CRC32 uses `zlib.crc32` where available with a table-driven fallback, so the on-disk format does not depend on the Node version.

### 3. Proof

**(a) Torn tail — truncated mid-record.** Same scenario as the reproduction:

```
  RECOVERY: replayed 3 WAL records in 0.3ms (3 applied, 0 rejected)
  TORN TAIL: discarded 59 trailing bytes (short-payload) — never acknowledged, safe to drop
  VERDICT: PASS — identical to pre-torn state; all 3 records recovered
```

Recovered state was byte-identical to the state captured before the tail was appended. Where Step 2 lost everything, Step 3 loses only the unacknowledged tail.

**(b) CRC catches what length cannot.** A single bit flipped *inside* the last record's payload — file size unchanged, only content damaged:

```
  flipping byte at offset 303 : 0x74 -> 0x75
  file size unchanged: 315 bytes — only the CONTENT is damaged

  RECOVERY: replayed 2 WAL records in 0.2ms (2 applied, 0 rejected)
  TORN TAIL: discarded 105 trailing bytes (crc-mismatch)
  *** MID-FILE CORRUPTION (crc-mismatch) — not a torn tail.
      Records after the damage were NOT recovered. ***
```

The length field was still valid, so a length-only scheme would have accepted the damaged record and replayed corrupt state. The CRC rejected it and the failure was reported as corruption rather than truncation.

**(c) Legacy logs are detected, not silently misread.** Replay auto-detects a Step-1/2 JSON-lines log (first byte `{`) and reads it with the old parser rather than interpreting `{"se` as a 2-billion-byte length field:

```
  RECOVERY: replayed 1 WAL records in 0.2ms (1 applied, 0 rejected)
  WAL fmt:  framed (len + JSON + CRC32)
```

**(d) `npm test` — new section F, all green:**

```
F. STAGE 3 STEP 3 — torn-write protection (length + CRC32)
  (a) intact framed log round-trips
  PASS  all records read back | read=12
  PASS  nothing discarded | discarded=0
  PASS  replayed state IDENTICAL to live
  (b) torn tail — truncated mid-record
  PASS  torn tail did NOT abort recovery | read=12
  PASS  torn tail was discarded | discarded=36 reason=short-payload
  PASS  state after torn tail equals state before it
  (c) truncated length field (fewer than 4 bytes left)
  PASS  recovered every complete record | read=8
  PASS  stump discarded | reason=short-length discarded=2
  (d) CRC catches damage that the length field cannot
  PASS  damaged record rejected by CRC | read=9
  PASS  failure reported as crc-mismatch, not truncation
  PASS  content damage flagged as corruption, not a torn tail
  (e) CRC32 agrees with the reference implementation
  PASS  crc32('123456789') === 0xCBF43926 | got 0xCBF43926
  PASS  crc32 of empty input === 0

ALL INVARIANTS HOLD
```

The reference-vector check matters: `0xCBF43926` for `"123456789"` is the standard CRC-32 test vector, so this is a real CRC32 rather than a homemade checksum that is merely self-consistent.

**(e) Hard kill mid-load still recovers cleanly.** 25 VUs, `taskkill /F` at t=4s, framed format:

```
acknowledged (HTTP 200): 13447   WAL bytes: 1475620

  RECOVERY: replayed 13453 WAL records in 24.7ms (13453 applied, 0 rejected)
  WAL fmt:  framed (len + JSON + CRC32)

  acknowledged to clients : 13447
  recovered from the log  : 13453
  negative balances       : 0
  VERDICT: PASS - nothing acknowledged-but-lost
```

The log remains a **superset** of what was acknowledged, never a subset. (k6's match_rate reads 35.33% here because the server was killed mid-run and two thirds of requests hit a dead port — that is the crash, not rejections. This run is a durability test, not a throughput measurement.)

### 4. What CRC cost — measured in the SAME session

Cross-session throughput on this host drifts, so `WAL_FORMAT` was made switchable and both formats were measured **back-to-back, interleaved, 3 runs each**, `match_rate 100.00%` on every run:

| VUs | format | median ord/s | p50 | p95 | cost |
|-----|--------|-------------|-----|-----|------|
| 10 | jsonl | 2402.7 | 3.74ms | 5.86ms | |
| 10 | framed | 2353.5 | 3.89ms | 5.85ms | 2.0% |
| 25 | jsonl | 3293.9 | 6.85ms | 11.20ms | |
| 25 | **framed** | **3254.3** | 6.91ms | **11.43ms** | **1.2%** |
| 50 | jsonl | 3282.5 | 14.48ms | 20.82ms | |
| 50 | framed | 3290.6 | 14.49ms | 20.66ms | -0.2% |

Pooled across all levels (n=9 each): jsonl 3225.8 vs framed 3224.2 ord/s — **0.0%**.

**The CRC is effectively free.** At 25 VUs it costs 1.2% throughput and +0.23ms p95; at 50 VUs it measured slightly *faster*, which is noise. That is the expected shape: CRC32 over a ~100-byte payload is nanoseconds of arithmetic, while the actual bottleneck is the fsync. Buying crash-corruption safety for ~1% of throughput is not a real trade-off — it is close to free, and the honest way to report it is that the cost is below this harness's run-to-run noise floor.

### RUNNING COMPARISON

| Stage | throughput (ord/s) | p95 | durable? |
|-------|-------------------|-----|----------|
| Stage 0: Postgres ACID | ~181 | 36.5ms @5VU / 162.1ms @25VU | yes (ACID) |
| Stage 2: in-memory, no durability | ~2127 | 6.62ms | **no** |
| Step 1: WAL, fsync-per-order | ~797 | 16.8ms | yes |
| Step 2: WAL, group commit | ~3294 | 11.20ms | yes |
| **Step 3: + torn-write protection** | **~3254** | **11.43ms** | **yes, and crash-corruption safe** |

Step 2 and Step 3 rows are the same-session A/B at 25 VUs and are directly comparable. The first three rows come from earlier sessions and are indicative only.

### The WAL is now complete

- **append-before-execute** — the record is written before the order touches memory
- **group commit** — one fsync amortised across a batch; nothing acknowledged before its fsync
- **torn-write protection** — length prefix + CRC32; recovery discards an unacknowledged torn tail and reports genuine corruption distinctly
- **crash recovery** — deterministic replay; 13,453 records rebuilt in 24.7ms

**Still open:** Bug 5 (single-level match per incoming order) — unchanged deliberate scope cut. Also `npx tsc --noEmit` still reports pre-existing strict-mode index-access errors in `engine.ts` (present since Stage 2); `tsx` transpiles without typechecking so runtime and `npm test` are unaffected, but they are worth clearing before the project is called finished.

**Next:** Stage 4 (async projection to a queryable Postgres read-model). Human-driven, not autonomous. NOT started.

---

## [2026-08-28] — Stage 4 Step 4.1: projection worker tails the WAL into a Postgres read-model

**Change:** `src/projection/worker.ts`, a standalone process (`npm run projector`) that tails the WAL and derives a Postgres read-model from it. The WAL stays the source of truth; Postgres becomes a derived view.

```
order -> WAL (fsync) -> engine (RAM)
            |
            +--(tail, read-only)--> worker -> Postgres read-model
```

No Redis, no queue. The worker reads the log file directly, which is what makes Postgres a *provably* pure derived view — there is no second channel through which state could arrive.

### Decoupling is structural, not a convention

The engine has zero dependency on the worker. Verified mechanically:

```
=== does anything import the worker? ===
  nothing imports the worker — it is only an entry point
=== does the engine/hot path reference the projection? ===
  (only comments in wal.ts; no code)
```

And the hot path was not touched at all this step — `git diff --stat` over `engine.ts`, `server.ts`, `orderProcessor.ts`, `bootstrap.ts`, `recover.ts` reports **no changes**. The only edits are a read-only addition to `wal.ts` (`scanFrames` / `readFramedFrom`, so the worker reuses the exact framing rather than re-parsing) and the new `src/projection/`.

### Two decisions that were correctness-critical

**1. The read-model lives in its own schema.** The engine bootstraps its GENESIS state from `public.orders` and `public.balances`. Had the projection written into those tables, the next engine restart would have loaded a different genesis and replay would have rebuilt the wrong world — the derived view silently corrupting the source of truth. Everything projected therefore goes to a separate `readmodel` schema. `public.*` is read-only genesis; `readmodel.*` is derived and disposable.

**2. The cursor is updated in the SAME transaction as the rows it accounts for.**

```sql
BEGIN; upsert orders/trades/balances; UPDATE readmodel.cursor; COMMIT;
```

"Wrote the data but lost the offset" is not a window that idempotency has to paper over — it cannot happen. Either both land or neither does. Inserts also use `ON CONFLICT DO NOTHING / DO UPDATE` as a second line of defence.

The log holds COMMANDS, so the worker runs its own `MatchingEngine` replica and re-executes them — the same determinism argument crash recovery relies on. On restart it replays already-projected records through the replica **silently** to rebuild state, then projects only what is past the cursor.

**Bounded transactions.** The first implementation projected an entire backlog as one transaction: a 28k-record backlog became a single unbounded transaction, and the durable cursor was pointless because it only advanced once at the very end. Capped at 500 records per transaction (`PROJECTION_BATCH`), so a crash costs at most that much re-work.

### Proof (a) — the read-model faithfully matches the WAL

Engine and worker started as two independent processes, 8 orders placed (5 filled, 3 rejected):

```
=== POSTGRES read-model (derived) ===
 orders | trades | balances        byte_offset | records_projected
      8 |      5 |       10                840 |                 8

 id |  symbol  |    price     |  quantity  | buyer_order_id | seller_order_id
  1 | SOL_USDC | 90.00000000  | 5.00000000 |              4 |               1
  2 | SOL_USDC | 95.00000000  | 3.00000000 |              5 |               2
  3 | SOL_USDC | 110.00000000 | 4.00000000 |              6 |               3
  4 | SOL_USDC | 110.00000000 | 2.00000000 |              7 |               3
  5 | SOL_USDC | 110.00000000 | 2.00000000 |              8 |               3

=== engine trades, for comparison ===
  id=1 price=90  qty=5 buyer=4 seller=1
  id=2 price=95  qty=3 buyer=5 seller=2
  id=3 price=110 qty=4 buyer=6 seller=3
  id=4 price=110 qty=2 buyer=7 seller=3
  id=5 price=110 qty=2 buyer=8 seller=3
```

Cursor at byte 840 = exact WAL file size. All 8 submitted records projected, including the 3 the engine rejected — the log records what was *submitted*, and the projection is faithful to it.

### Proof (b) — killing the worker does not touch the engine

30s load at 25 VUs; the worker was hard-killed at t=10s and stayed dead for two thirds of the run:

```
>>> KILLING THE WORKER at t=10s (engine untouched) <<<
--- is the ENGINE still serving? ---
{"success":true,"trade":{"tradeId":25954,...}}

=== k6 result (engine performance with the worker DEAD for 2/3 of the run) ===
    match_rate.......: 100.00% 64400 out of 64400
    orders_filled....: 64400   2146.328695/s
    http_req_failed..: 0.00%   0 out of 64400
    http_req_duration: avg=11.51ms med=10.35ms p(95)=19.53ms p(99)=28.96ms
```

**Zero failures, 100% match rate, 2146 ord/s** — indistinguishable from a run with the worker alive. The read-model simply went stale:

```
  WAL size now:      7105972 bytes
  cursor at:         186165 bytes, 1710 records
  engine trades:     64401     <- read-model is BEHIND, engine unaffected
```

Restarting the worker: it resumed from its durable offset, replayed the already-projected prefix silently, and converged exactly.

```
  replica caught up silently over 1710 already-projected records
  resume: byte 186165, 1710 records already projected
  ...
 byte_offset | records_projected      rm_orders | rm_trades | rm_balances
     7105972 |             64401          66404 |     64401 |         410
  WAL bytes: 7105972
  engine: orders 66404  trades 64401
```

Conservation also holds *independently* in the derived read-model — computed from projected rows, not from the engine:

```
 asset |        total                     engine totals
 SOL   | 20000250.00000000                SOL  20000250
 USDC  | 2000050000.00000000              USDC 2000050000
 negative_in_readmodel: 0
```

### Proof (c) — durable offset survives a hard kill mid-projection

A backlog was built with the worker down, the worker started, then hard-killed partway through projecting it:

```
  projecting: cursor 10341175 -> 10396461 (target 12917367)
  >>> HARD KILL at offset 10506939 of 12917367 <<<
  cursor at kill:  10506939   cursor settled: 10506939
      (identical => the in-flight transaction rolled back cleanly)
```

Restarted, it resumed from `byte 10617444, 96176 records already projected` and ran to completion:

```
 byte_offset | records_projected        rm_orders | rm_trades
    12917367 |            116836           102011 |    100008

 dup_trade_ids | dup_order_ids
             0 |             0

 min_trade_id | max_trade_id |   n    | span_should_equal_n
            1 |       100008 | 100008 |              100008

 engine: orders 102011  trades 100008
```

Cursor equals the WAL size exactly. Trade ids form a **contiguous 1..100,008 with n = span = 100,008** — no duplicates and no gaps — and both tables match the engine exactly. Nothing was projected twice, nothing was skipped.

### Correctness harness

`npm test` unchanged and green (`ALL INVARIANTS HOLD`, exit 0). The engine and WAL were not modified, so nothing there needed re-proving.

### Honest limitations

**The projection is ~4x slower than the engine.** Measured catch-up rate: **~545 records/sec**, against the engine's ~2100 ord/s. Under *sustained* peak load the read-model would fall behind indefinitely; it only converges when the write rate drops. The cause is the naive per-row loop — each record issues up to seven individual `INSERT ... ON CONFLICT` round-trips inside the transaction. Batching them into multi-row statements is the obvious fix and belongs to Step 4.2. This does not affect correctness (the cursor guarantees eventual exactness), only freshness.

**Liquidity was exhausted during the (c) load run** — the 100,016 SOL seed book has been consumed across many sessions, so that run reported `match_rate 27.34%` and `421 ord/s`. Those are rejection figures, not throughput, and are not quoted as such. It does not weaken proof (c): rejected orders are still logged and still projected, so the cursor/duplicate/gap checks are unaffected. Re-seed before any future throughput measurement.

### Not done (deliberate)

No Redis or queue. No normalised schema, no indexes, no query endpoints — the schema is deliberately flat and there is no read API yet. Those are Step 4.2.

**Next:** Step 4.2 — normalised read-model schema + query endpoints. Human-driven, not autonomous.
