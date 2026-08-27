// ── Stage 0 correctness-invariant harness ────────────────────
//
// Run with:  npm test        (requires `docker compose up -d`)
//
// This calls processOrder() DIRECTLY rather than over HTTP. That is
// deliberate: driving the API means a stale server process can silently
// serve old code and make a broken build look green — which is exactly
// how a fake "concurrency test" passed here before. Importing the module
// guarantees the code under test is the code on disk.
//
// Invariants asserted:
//   (a) conservation — SUM(available) per asset is unchanged by trading
//   (b) no negative balances — ever, under any path
//   (c) a GENUINE concurrent race — two buyers dispatched together via
//       Promise.all against ONE limited resting order; exactly one fills
//
// NUMERIC sums are compared as exact strings, never as JS floats.

import { pool } from "../db.js";
import { processOrder } from "../orderProcessor.js";

const SYMBOL = "SOL_USDC";

const ALICE = 1;
const BOB = 2;
const CAROL = 3;
const DAVE = 4;
const EVE = 5;

let failures = 0;

function assert(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

/** Restore a known book: Bob 5@90, Carol 3@95, Dave 8@110; everyone 10000 USDC / 50 SOL. */
async function resetFixture(): Promise<void> {
  await pool.query("DELETE FROM trades");
  await pool.query("DELETE FROM orders");
  await pool.query("UPDATE balances SET available = 10000 WHERE asset = 'USDC'");
  await pool.query("UPDATE balances SET available = 50 WHERE asset = 'SOL'");
  await pool.query(
    `INSERT INTO orders (user_id, symbol, side, price, quantity) VALUES
       ($1, $4, 'sell', 90, 5),
       ($2, $4, 'sell', 95, 3),
       ($3, $4, 'sell', 110, 8)`,
    [BOB, CAROL, DAVE, SYMBOL]
  );
}

/** Exact per-asset totals as strings — no float rounding in the comparison. */
async function totals(): Promise<Record<string, string>> {
  const r = await pool.query(
    "SELECT asset, SUM(available)::text AS total FROM balances GROUP BY asset ORDER BY asset"
  );
  return Object.fromEntries(r.rows.map((x) => [x.asset, x.total]));
}

async function negativeBalances(): Promise<number> {
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM balances WHERE available < 0 OR locked < 0"
  );
  return r.rows[0].n;
}

async function balanceOf(userId: number, asset: string): Promise<string> {
  const r = await pool.query(
    "SELECT available::text AS a FROM balances WHERE user_id = $1 AND asset = $2",
    [userId, asset]
  );
  return r.rows[0]?.a ?? "missing";
}

type Outcome = { ok: true; qty: number } | { ok: false; error: string };

async function place(
  userId: number,
  side: "buy" | "sell",
  price: number,
  quantity: number
): Promise<Outcome> {
  try {
    const t = await processOrder({ userId, symbol: SYMBOL, side, price, quantity });
    return { ok: true, qty: t.quantity };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── (a) Conservation across a sequence of trades ─────────────
async function testConservation(): Promise<void> {
  console.log("\n(a) conservation — SUM(available) per asset unchanged by trading");
  await resetFixture();
  const before = await totals();

  const t1 = await place(ALICE, "buy", 100, 5); // fills Bob @90
  const t2 = await place(EVE, "buy", 100, 3);   // fills Carol @95
  const after = await totals();

  assert("two trades executed", t1.ok && t2.ok, `alice=${JSON.stringify(t1)} eve=${JSON.stringify(t2)}`);
  for (const asset of Object.keys(before)) {
    assert(
      `SUM(available) unchanged for ${asset}`,
      before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`
    );
  }
}

// ── (b) No negative balances, incl. an insolvent maker ───────
async function testNoNegativeBalances(): Promise<void> {
  console.log("\n(b) no negative balances — including an insolvent resting-order owner");
  await resetFixture();

  // Bob rests a 5 SOL sell but is drained to 1 SOL. Filling it would
  // historically drive him to -4 while SUM() stayed constant.
  await pool.query("UPDATE balances SET available = 1 WHERE user_id = $1 AND asset = 'SOL'", [BOB]);

  const r = await place(ALICE, "buy", 100, 5);
  assert("insolvent maker is rejected", !r.ok, r.ok ? `unexpectedly filled ${r.qty}` : r.error);
  assert("bob's SOL untouched", (await balanceOf(BOB, "SOL")) === "1.00000000", `bob SOL=${await balanceOf(BOB, "SOL")}`);
  assert("no negative balances anywhere", (await negativeBalances()) === 0);

  // Also assert it across the whole suite's normal trading paths.
  await resetFixture();
  await place(ALICE, "buy", 100, 5);
  await place(EVE, "buy", 100, 3);
  assert("no negative balances after normal trades", (await negativeBalances()) === 0);
}

// ── (c) Genuine concurrent race for ONE limited resting order ─
async function testConcurrentRace(): Promise<void> {
  console.log("\n(c) genuine race — two buyers, Promise.all, ONE limited resting order");
  await resetFixture();

  // Both bid 90, so ONLY Bob's 5@90 is eligible (Carol@95 and Dave@110 are
  // above the limit). Both want the full 5 — they must contend for one row.
  const before = await totals();
  const [a, e] = await Promise.all([
    place(ALICE, "buy", 90, 5),
    place(EVE, "buy", 90, 5),
  ]);

  const filled = [a, e].filter((r) => r.ok).length;
  const rejected = [a, e].filter((r) => !r.ok).length;

  assert(
    "exactly one buyer filled",
    filled === 1 && rejected === 1,
    `alice=${JSON.stringify(a)}  eve=${JSON.stringify(e)}`
  );
  assert(
    "bob sold exactly 5 SOL, not 10",
    (await balanceOf(BOB, "SOL")) === "45.00000000",
    `bob SOL=${await balanceOf(BOB, "SOL")}`
  );

  const after = await totals();
  for (const asset of Object.keys(before)) {
    assert(
      `SUM(available) unchanged for ${asset} across the race`,
      before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`
    );
  }
  assert("no negative balances after race", (await negativeBalances()) === 0);

  const tradeCount = await pool.query("SELECT count(*)::int AS n FROM trades");
  assert("exactly one trade written", tradeCount.rows[0].n === 1, `trades=${tradeCount.rows[0].n}`);
}

// ── main ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Stage 0 invariant harness");
  console.log("=========================");
  try {
    await testConservation();
    await testNoNegativeBalances();
    await testConcurrentRace();
  } finally {
    await resetFixture();
    await pool.end();
  }

  console.log("\n=========================");
  if (failures === 0) {
    console.log("ALL INVARIANTS HOLD");
  } else {
    console.log(`${failures} INVARIANT FAILURE(S)`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
