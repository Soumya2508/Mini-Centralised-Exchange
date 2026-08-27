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
