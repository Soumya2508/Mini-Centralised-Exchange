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
