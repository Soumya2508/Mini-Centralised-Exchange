// ── Correctness-invariant harness (Stage 0 DB + Stage 2 in-memory) ──
//
//   npm test        (requires `docker compose up -d`)
//
// Runs the SAME invariants against both engines and then compares them
// directly, so the claim "Stage 2 is a port, not a redesign" is proved
// rather than asserted:
//
//   A. Stage 0  — transactional Postgres engine (orderProcessor.ts)
//   B. Stage 2  — in-memory single-writer engine (engine.ts)
//   C. Parity   — identical scenarios, identical observable outcomes
//
// Invariants in A and B:
//   (a) conservation — per-asset totals unchanged by trading
//   (b) no negative balances, including an insolvent resting-order owner
//   (c) a genuine concurrent race — two buyers dispatched together via
//       Promise.all against ONE limited resting order; exactly one fills
//
// Both engines are called DIRECTLY, never over HTTP: a stale server
// process can silently serve old code and make a broken build look
// green. Importing guarantees the code under test is the code on disk.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool } from "../db.js";
import { processOrder as dbProcessOrder } from "../orderProcessor.js";
import { MatchingEngine } from "../engine.js";
import { Wal, GroupCommitWal, replayDetailed, crc32 } from "../wal.js";

const SYMBOL = "SOL_USDC";
const ALICE = 1, BOB = 2, CAROL = 3, DAVE = 4, EVE = 5;

let failures = 0;

function assert(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

type Outcome = { ok: true; qty: number; price: number } | { ok: false; error: string };

// ═══════════ Stage 0 — Postgres engine ═══════════

async function dbReset(): Promise<void> {
  await pool.query("DELETE FROM trades");
  await pool.query("DELETE FROM orders");
  await pool.query("UPDATE balances SET available = 10000 WHERE asset = 'USDC'");
  await pool.query("UPDATE balances SET available = 50 WHERE asset = 'SOL'");
  await pool.query(
    `INSERT INTO orders (user_id, symbol, side, price, quantity) VALUES
       ($1, $4, 'sell', 90, 5), ($2, $4, 'sell', 95, 3), ($3, $4, 'sell', 110, 8)`,
    [BOB, CAROL, DAVE, SYMBOL]
  );
}

async function dbTotals(): Promise<Record<string, string>> {
  const r = await pool.query(
    "SELECT asset, SUM(available)::text AS total FROM balances GROUP BY asset ORDER BY asset"
  );
  return Object.fromEntries(r.rows.map((x) => [x.asset, x.total]));
}

async function dbNegatives(): Promise<number> {
  const r = await pool.query("SELECT count(*)::int AS n FROM balances WHERE available < 0");
  return r.rows[0].n;
}

async function dbBalance(userId: number, asset: string): Promise<string> {
  const r = await pool.query(
    "SELECT available::text AS a FROM balances WHERE user_id = $1 AND asset = $2",
    [userId, asset]
  );
  return r.rows[0]?.a ?? "missing";
}

async function dbPlace(
  userId: number, side: "buy" | "sell", price: number, quantity: number
): Promise<Outcome> {
  try {
    const t = await dbProcessOrder({ userId, symbol: SYMBOL, side, price, quantity });
    return { ok: true, qty: t.quantity, price: t.price };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ═══════════ Stage 2 — in-memory engine ═══════════

/** Same starting state as db/init.sql: 5 users, 10000 USDC / 50 SOL, 3 resting sells. */
function makeEngine(): MatchingEngine {
  const e = new MatchingEngine();
  for (const u of [ALICE, BOB, CAROL, DAVE, EVE]) {
    e.setBalance(u, "USDC", 10000);
    e.setBalance(u, "SOL", 50);
  }
  e.addRestingOrder({ userId: BOB, symbol: SYMBOL, side: "sell", price: 90, quantity: 5 });
  e.addRestingOrder({ userId: CAROL, symbol: SYMBOL, side: "sell", price: 95, quantity: 3 });
  e.addRestingOrder({ userId: DAVE, symbol: SYMBOL, side: "sell", price: 110, quantity: 8 });
  return e;
}

/** Async wrapper so the race test can dispatch via Promise.all like the DB one. */
async function memPlace(
  e: MatchingEngine, userId: number, side: "buy" | "sell", price: number, quantity: number
): Promise<Outcome> {
  try {
    const t = e.processOrder({ userId, symbol: SYMBOL, side, price, quantity });
    return { ok: true, qty: t.quantity, price: t.price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const memTotals = (e: MatchingEngine): Record<string, number> =>
  Object.fromEntries(e.totals());

// ═══════════ A. Stage 0 (Postgres) ═══════════

async function testDatabaseEngine(): Promise<void> {
  console.log("\nA. STAGE 0 — transactional Postgres engine");

  console.log("\n  (a) conservation");
  await dbReset();
  const before = await dbTotals();
  const t1 = await dbPlace(ALICE, "buy", 100, 5);
  const t2 = await dbPlace(EVE, "buy", 100, 3);
  const after = await dbTotals();
  assert("two trades executed", t1.ok && t2.ok, `alice=${JSON.stringify(t1)} eve=${JSON.stringify(t2)}`);
  for (const asset of Object.keys(before)) {
    assert(`SUM(available) unchanged for ${asset}`, before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`);
  }

  console.log("\n  (b) no negative balances");
  await dbReset();
  await pool.query("UPDATE balances SET available = 1 WHERE user_id = $1 AND asset = 'SOL'", [BOB]);
  const r = await dbPlace(ALICE, "buy", 100, 5);
  assert("insolvent maker is rejected", !r.ok, r.ok ? `unexpectedly filled ${r.qty}` : r.error);
  assert("bob's SOL untouched", (await dbBalance(BOB, "SOL")) === "1.00000000");
  assert("no negative balances anywhere", (await dbNegatives()) === 0);

  console.log("\n  (c) genuine race — Promise.all, ONE limited resting order");
  await dbReset();
  const beforeRace = await dbTotals();
  const [a, e] = await Promise.all([dbPlace(ALICE, "buy", 90, 5), dbPlace(EVE, "buy", 90, 5)]);
  const filled = [a, e].filter((x) => x.ok).length;
  assert("exactly one buyer filled", filled === 1,
    `alice=${JSON.stringify(a)}  eve=${JSON.stringify(e)}`);
  assert("bob sold exactly 5 SOL, not 10", (await dbBalance(BOB, "SOL")) === "45.00000000");
  const afterRace = await dbTotals();
  for (const asset of Object.keys(beforeRace)) {
    assert(`SUM(available) unchanged for ${asset} across the race`,
      beforeRace[asset] === afterRace[asset]);
  }
  assert("no negative balances after race", (await dbNegatives()) === 0);
  const tc = await pool.query("SELECT count(*)::int AS n FROM trades");
  assert("exactly one trade written", tc.rows[0].n === 1, `trades=${tc.rows[0].n}`);
}

// ═══════════ B. Stage 2 (in-memory) ═══════════

async function testMemoryEngine(): Promise<void> {
  console.log("\nB. STAGE 2 — in-memory single-writer engine");

  console.log("\n  (a) conservation");
  let e = makeEngine();
  const before = memTotals(e);
  const t1 = await memPlace(e, ALICE, "buy", 100, 5);
  const t2 = await memPlace(e, EVE, "buy", 100, 3);
  const after = memTotals(e);
  assert("two trades executed", t1.ok && t2.ok, `alice=${JSON.stringify(t1)} eve=${JSON.stringify(t2)}`);
  for (const asset of Object.keys(before)) {
    assert(`total unchanged for ${asset}`, before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`);
  }

  console.log("\n  (b) no negative balances");
  e = makeEngine();
  e.setBalance(BOB, "SOL", 1);
  const r = await memPlace(e, ALICE, "buy", 100, 5);
  assert("insolvent maker is rejected", !r.ok, r.ok ? `unexpectedly filled ${r.qty}` : r.error);
  assert("bob's SOL untouched", e.getBalance(BOB, "SOL") === 1, `bob SOL=${e.getBalance(BOB, "SOL")}`);
  assert("no negative balances anywhere", e.negativeBalanceCount() === 0);

  console.log("\n  (c) genuine race — Promise.all, ONE limited resting order");
  e = makeEngine();
  const beforeRace = memTotals(e);
  const [a, ev] = await Promise.all([
    memPlace(e, ALICE, "buy", 90, 5),
    memPlace(e, EVE, "buy", 90, 5),
  ]);
  const filled = [a, ev].filter((x) => x.ok).length;
  assert("exactly one buyer filled", filled === 1,
    `alice=${JSON.stringify(a)}  eve=${JSON.stringify(ev)}`);
  assert("bob sold exactly 5 SOL, not 10", e.getBalance(BOB, "SOL") === 45,
    `bob SOL=${e.getBalance(BOB, "SOL")}`);
  const afterRace = memTotals(e);
  for (const asset of Object.keys(beforeRace)) {
    assert(`total unchanged for ${asset} across the race`, beforeRace[asset] === afterRace[asset]);
  }
  assert("no negative balances after race", e.negativeBalanceCount() === 0);
  assert("exactly one trade recorded", e.getTrades().length === 1, `trades=${e.getTrades().length}`);
}

// ═══════════ C. Parity — same scenarios, same outcomes ═══════════

async function testParity(): Promise<void> {
  console.log("\nC. PARITY — Stage 0 (DB) vs Stage 2 (RAM), identical scenarios");

  const scenarios: Array<{
    name: string;
    steps: Array<[number, "buy" | "sell", number, number]>;
  }> = [
    { name: "price improvement (alice bids 100, bob rests @90)", steps: [[ALICE, "buy", 100, 5]] },
    { name: "price-time priority (then eve bids 100 for 3 -> carol @95)",
      steps: [[ALICE, "buy", 100, 5], [EVE, "buy", 100, 3]] },
    { name: "no match above limit (only dave @110 left)",
      steps: [[ALICE, "buy", 100, 5], [EVE, "buy", 100, 3], [ALICE, "buy", 100, 5]] },
    { name: "partial fill rests remainder (alice bids 90 for 10, bob has 5)",
      steps: [[ALICE, "buy", 90, 10]] },
    { name: "rested remainder filled by later seller",
      steps: [[ALICE, "buy", 90, 10], [BOB, "sell", 90, 5]] },
  ];

  for (const sc of scenarios) {
    await dbReset();
    const mem = makeEngine();
    const dbOut: string[] = [];
    const memOut: string[] = [];

    for (const [u, side, price, qty] of sc.steps) {
      const d = await dbPlace(u, side, price, qty);
      const m = await memPlace(mem, u, side, price, qty);
      dbOut.push(d.ok ? `FILL ${d.qty}@${d.price}` : `REJECT ${d.error}`);
      memOut.push(m.ok ? `FILL ${m.qty}@${m.price}` : `REJECT ${m.error}`);
    }

    const dbBal = [
      await dbBalance(ALICE, "SOL"), await dbBalance(ALICE, "USDC"),
      await dbBalance(BOB, "SOL"), await dbBalance(BOB, "USDC"),
    ].map((x) => Number(x).toString());
    const memBal = [
      mem.getBalance(ALICE, "SOL"), mem.getBalance(ALICE, "USDC"),
      mem.getBalance(BOB, "SOL"), mem.getBalance(BOB, "USDC"),
    ].map((x) => String(x));

    const sameOutcome = dbOut.join(" | ") === memOut.join(" | ");
    const sameBalances = dbBal.join(",") === memBal.join(",");

    assert(`same outcomes: ${sc.name}`, sameOutcome,
      sameOutcome ? dbOut.join(" | ") : `DB : ${dbOut.join(" | ")}\n         RAM: ${memOut.join(" | ")}`);
    assert(`same balances: ${sc.name}`, sameBalances,
      sameBalances ? `alice/bob SOL,USDC = ${dbBal.join(",")}`
                   : `DB : ${dbBal.join(",")}\n         RAM: ${memBal.join(",")}`);
  }
}

// ═══════════ D. Stage 3 Step 1 — WAL-backed engine ═══════════
//
// Same invariants again, but every order goes through the real
// write-ahead path: append + fsync to disk BEFORE touching memory.
// Then the log is replayed into a fresh engine and the rebuilt state
// is compared against the live one — durability proved, not assumed.

/** The server's order path: durable first, then apply. */
async function walPlace(
  e: MatchingEngine, w: Wal, userId: number,
  side: "buy" | "sell", price: number, quantity: number
): Promise<Outcome> {
  w.append({ userId, symbol: SYMBOL, side, price, quantity }); // fsync'd
  try {
    const t = e.processOrder({ userId, symbol: SYMBOL, side, price, quantity });
    return { ok: true, qty: t.quantity, price: t.price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Rebuild an engine from genesis + log, exactly as recover.ts does. */
function replayInto(walPath: string): MatchingEngine {
  const e = makeEngine();
  for (const r of Wal.replay(walPath)) {
    try { e.processOrder(r); } catch { /* deterministic rejection */ }
  }
  return e;
}

/** Stable fingerprint of everything the engine holds. */
const fingerprint = (e: MatchingEngine): string =>
  JSON.stringify({
    totals: Object.fromEntries(e.totals()),
    orders: e.getOrders(),
    trades: e.getTrades(),
  });

async function testWalEngine(): Promise<void> {
  console.log("\nD. STAGE 3 STEP 1 — WAL-backed engine (append + fsync, then apply)");
  const tmp = (n: string) => path.join(os.tmpdir(), `inv-wal-${process.pid}-${n}.log`);

  console.log("\n  (a) conservation");
  let p = tmp("a"); fs.rmSync(p, { force: true });
  let e = makeEngine(); let w = new Wal(p, 1);
  const before = memTotals(e);
  const t1 = await walPlace(e, w, ALICE, "buy", 100, 5);
  const t2 = await walPlace(e, w, EVE, "buy", 100, 3);
  const after = memTotals(e);
  assert("two trades executed", t1.ok && t2.ok, `alice=${JSON.stringify(t1)} eve=${JSON.stringify(t2)}`);
  for (const asset of Object.keys(before)) {
    assert(`total unchanged for ${asset}`, before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`);
  }
  assert("every order was fsync'd individually", w.fsyncCount === w.appendCount && w.fsyncCount === 2,
    `appends=${w.appendCount} fsyncs=${w.fsyncCount}`);
  w.close();

  console.log("\n  (b) no negative balances");
  p = tmp("b"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new Wal(p, 1);
  e.setBalance(BOB, "SOL", 1);
  const r = await walPlace(e, w, ALICE, "buy", 100, 5);
  assert("insolvent maker is rejected", !r.ok, r.ok ? `unexpectedly filled ${r.qty}` : r.error);
  assert("rejected order is STILL in the log", Wal.replay(p).length === 1,
    "a submitted order is logged whether or not it fills");
  assert("no negative balances anywhere", e.negativeBalanceCount() === 0);
  w.close();

  console.log("\n  (c) genuine race — Promise.all, ONE limited resting order");
  p = tmp("c"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new Wal(p, 1);
  const beforeRace = memTotals(e);
  const [a, ev] = await Promise.all([
    walPlace(e, w, ALICE, "buy", 90, 5),
    walPlace(e, w, EVE, "buy", 90, 5),
  ]);
  assert("exactly one buyer filled", [a, ev].filter((x) => x.ok).length === 1,
    `alice=${JSON.stringify(a)}  eve=${JSON.stringify(ev)}`);
  assert("bob sold exactly 5 SOL, not 10", e.getBalance(BOB, "SOL") === 45);
  const afterRace = memTotals(e);
  for (const asset of Object.keys(beforeRace)) {
    assert(`total unchanged for ${asset} across the race`, beforeRace[asset] === afterRace[asset]);
  }
  assert("no negative balances after race", e.negativeBalanceCount() === 0);
  w.close();

  console.log("\n  (d) crash recovery — replay rebuilds identical state");
  p = tmp("d"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new Wal(p, 1);
  const script: Array<[number, "buy" | "sell", number, number]> = [
    [ALICE, "buy", 100, 5],   // fills bob @90
    [EVE, "buy", 100, 3],     // fills carol @95
    [ALICE, "buy", 90, 10],   // no match at 90 -> rejected
    [BOB, "buy", 110, 4],     // fills dave @110
    [CAROL, "sell", 200, 1],  // no buy that high -> rejected
    [DAVE, "buy", 110, 6],    // partial against dave's own remainder
  ];
  for (const [u, side, price, qty] of script) await walPlace(e, w, u, side, price, qty);
  w.close();

  const live = fingerprint(e);
  const rebuilt = fingerprint(replayInto(p));
  assert("log holds every submitted order", Wal.replay(p).length === script.length,
    `records=${Wal.replay(p).length} submitted=${script.length}`);
  assert("replayed state is IDENTICAL to live state", live === rebuilt,
    live === rebuilt
      ? `${live.length} bytes of state matched (balances + orders + trades)`
      : `live    : ${live.slice(0, 200)}\n         rebuilt: ${rebuilt.slice(0, 200)}`);
  fs.rmSync(p, { force: true });
}

// ═══════════ E. Stage 3 Step 2 — group commit ═══════════
//
// Same invariants under batched fsync, plus the property that batching
// specifically puts at risk: anything ACKNOWLEDGED must be on disk.

/** Server order path under group commit: write -> apply -> await fsync -> ack. */
async function gcPlace(
  e: MatchingEngine, w: GroupCommitWal, userId: number,
  side: "buy" | "sell", price: number, quantity: number
): Promise<Outcome> {
  const { durable } = w.appendAndAwaitDurable({ userId, symbol: SYMBOL, side, price, quantity });
  let out: Outcome;
  try {
    const t = e.processOrder({ userId, symbol: SYMBOL, side, price, quantity });
    out = { ok: true, qty: t.quantity, price: t.price };
  } catch (err) {
    out = { ok: false, error: (err as Error).message };
  }
  await durable;  // the acknowledgement point
  return out;
}

async function testGroupCommit(): Promise<void> {
  console.log("\nE. STAGE 3 STEP 2 — group commit (write -> apply -> batch fsync -> ack)");
  const tmp = (n: string) => path.join(os.tmpdir(), `inv-gc-${process.pid}-${n}.log`);

  console.log("\n  (a) conservation");
  let p = tmp("a"); fs.rmSync(p, { force: true });
  let e = makeEngine();
  let w = new GroupCommitWal(p, 1, { maxBatch: 64, maxDelayMs: 2 });
  const before = memTotals(e);
  const [t1, t2] = await Promise.all([
    gcPlace(e, w, ALICE, "buy", 100, 5),
    gcPlace(e, w, EVE, "buy", 100, 3),
  ]);
  const after = memTotals(e);
  assert("two trades executed", t1.ok && t2.ok, `alice=${JSON.stringify(t1)} eve=${JSON.stringify(t2)}`);
  for (const asset of Object.keys(before)) {
    assert(`total unchanged for ${asset}`, before[asset] === after[asset],
      `before=${before[asset]}  after=${after[asset]}`);
  }
  w.close();

  console.log("\n  (b) no negative balances");
  p = tmp("b"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new GroupCommitWal(p, 1, { maxBatch: 64, maxDelayMs: 2 });
  e.setBalance(BOB, "SOL", 1);
  const r = await gcPlace(e, w, ALICE, "buy", 100, 5);
  assert("insolvent maker is rejected", !r.ok, r.ok ? `unexpectedly filled ${r.qty}` : r.error);
  assert("no negative balances anywhere", e.negativeBalanceCount() === 0);
  w.close();

  console.log("\n  (c) genuine race — Promise.all, ONE limited resting order");
  p = tmp("c"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new GroupCommitWal(p, 1, { maxBatch: 64, maxDelayMs: 2 });
  const beforeRace = memTotals(e);
  const [a, ev] = await Promise.all([
    gcPlace(e, w, ALICE, "buy", 90, 5),
    gcPlace(e, w, EVE, "buy", 90, 5),
  ]);
  assert("exactly one buyer filled", [a, ev].filter((x) => x.ok).length === 1,
    `alice=${JSON.stringify(a)}  eve=${JSON.stringify(ev)}`);
  assert("bob sold exactly 5 SOL, not 10", e.getBalance(BOB, "SOL") === 45);
  const afterRace = memTotals(e);
  for (const asset of Object.keys(beforeRace)) {
    assert(`total unchanged for ${asset} across the race`, beforeRace[asset] === afterRace[asset]);
  }
  w.close();

  console.log("\n  (d) batching actually happened, and nothing acked is missing from the log");
  p = tmp("d"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new GroupCommitWal(p, 1, { maxBatch: 64, maxDelayMs: 5 });
  const N = 200;
  const jobs: Array<Promise<Outcome>> = [];
  for (let i = 0; i < N; i++) {
    jobs.push(gcPlace(e, w, (i % 5) + 1, "buy", 110, 1));
  }
  await Promise.all(jobs);           // every one of these is ACKNOWLEDGED
  const recs = Wal.replay(p);        // read back what is actually on disk

  assert("every acknowledged order is on disk", recs.length === N,
    `acked=${N} onDisk=${recs.length}`);
  assert("fsyncs were amortised across orders", w.fsyncCount < w.appendCount,
    `appends=${w.appendCount} fsyncs=${w.fsyncCount} avgBatch=${w.averageBatchSize.toFixed(1)}`);
  assert("sequence numbers are gapless and ordered",
    recs.every((rec, i) => rec.seq === i + 1),
    `first=${recs[0]?.seq} last=${recs[recs.length - 1]?.seq}`);
  w.close();

  console.log("\n  (e) crash recovery — replay rebuilds identical state");
  p = tmp("e"); fs.rmSync(p, { force: true });
  e = makeEngine(); w = new GroupCommitWal(p, 1, { maxBatch: 8, maxDelayMs: 2 });
  const script: Array<[number, "buy" | "sell", number, number]> = [
    [ALICE, "buy", 100, 5], [EVE, "buy", 100, 3], [ALICE, "buy", 90, 10],
    [BOB, "buy", 110, 4], [CAROL, "sell", 200, 1], [DAVE, "buy", 110, 6],
  ];
  await Promise.all(script.map(([u, side, price, qty]) => gcPlace(e, w, u, side, price, qty)));
  w.close();

  const live = fingerprint(e);
  const rebuilt = fingerprint(replayInto(p));
  assert("replayed state is IDENTICAL to live state", live === rebuilt,
    live === rebuilt
      ? `${live.length} bytes of state matched (balances + orders + trades)`
      : `live    : ${live.slice(0, 200)}\n         rebuilt: ${rebuilt.slice(0, 200)}`);
  fs.rmSync(p, { force: true });
}

// ═══════════ F. Stage 3 Step 3 — torn-write protection ═══════════
//
// Frame: [4-byte length BE][JSON payload][4-byte CRC32 BE].
// A crash mid-write must cost only the unacknowledged tail, never the
// whole log — which is exactly what the bare jsonl format did.

async function testTornWriteProtection(): Promise<void> {
  console.log("\nF. STAGE 3 STEP 3 — torn-write protection (length + CRC32)");
  const tmp = (n: string) => path.join(os.tmpdir(), `inv-torn-${process.pid}-${n}.log`);

  /** Write N valid framed records and return the path + expected state. */
  const buildLog = async (p: string, n: number) => {
    fs.rmSync(p, { force: true });
    const e = makeEngine();
    const w = new GroupCommitWal(p, 1, { maxBatch: 4, maxDelayMs: 0, format: "framed" });
    for (let i = 0; i < n; i++) await gcPlace(e, w, (i % 5) + 1, "buy", 110, 1);
    w.close();
    return e;
  };

  console.log("\n  (a) intact framed log round-trips");
  let p = tmp("a");
  let live = await buildLog(p, 12);
  let res = replayDetailed(p);
  assert("all records read back", res.records.length === 12, `read=${res.records.length}`);
  assert("nothing discarded", res.discardedBytes === 0, `discarded=${res.discardedBytes}`);
  assert("replayed state IDENTICAL to live", fingerprint(replayInto(p)) === fingerprint(live));

  console.log("\n  (b) torn tail — truncated mid-record");
  p = tmp("b");
  live = await buildLog(p, 12);
  const goodPrefix = fingerprint(replayInto(p));
  // Simulate a crash partway through writing record 13.
  fs.appendFileSync(p, Buffer.concat([
    Buffer.from([0, 0, 0, 0x60]),                      // claims 96 payload bytes
    Buffer.from('{"seq":13,"ts":1,"userId":3,"sym', "utf8"), // only 32 arrive
  ]));
  res = replayDetailed(p);
  assert("torn tail did NOT abort recovery", res.records.length === 12, `read=${res.records.length}`);
  assert("torn tail was discarded", res.discardedBytes === 36 && res.stoppedBecause === "short-payload",
    `discarded=${res.discardedBytes} reason=${res.stoppedBecause}`);
  assert("state after torn tail equals state before it", fingerprint(replayInto(p)) === goodPrefix);

  console.log("\n  (c) truncated length field (fewer than 4 bytes left)");
  p = tmp("c");
  await buildLog(p, 8);
  fs.appendFileSync(p, Buffer.from([0, 0]));   // half a length header
  res = replayDetailed(p);
  assert("recovered every complete record", res.records.length === 8, `read=${res.records.length}`);
  assert("stump discarded", res.stoppedBecause === "short-length" && res.discardedBytes === 2,
    `reason=${res.stoppedBecause} discarded=${res.discardedBytes}`);

  console.log("\n  (d) CRC catches damage that the length field cannot");
  p = tmp("d");
  await buildLog(p, 10);
  const buf = fs.readFileSync(p);
  buf[buf.length - 12] ^= 0x01;               // flip a bit INSIDE the last payload
  fs.writeFileSync(p, buf);                   // same length, damaged content
  res = replayDetailed(p);
  assert("damaged record rejected by CRC", res.records.length === 9, `read=${res.records.length}`);
  assert("failure reported as crc-mismatch, not truncation", res.stoppedBecause === "crc-mismatch",
    `reason=${res.stoppedBecause}`);
  assert("content damage flagged as corruption, not a torn tail", res.midFileCorruption === true);

  console.log("\n  (e) CRC32 agrees with the reference implementation");
  assert("crc32('123456789') === 0xCBF43926",
    crc32(Buffer.from("123456789", "utf8")) === 0xcbf43926,
    `got 0x${crc32(Buffer.from("123456789", "utf8")).toString(16).toUpperCase()}`);
  assert("crc32 of empty input === 0", crc32(Buffer.alloc(0)) === 0);

  for (const n of ["a", "b", "c", "d"]) fs.rmSync(tmp(n), { force: true });
}

// ═══════════ main ═══════════

async function main(): Promise<void> {
  console.log("Invariant harness — Stage 0 (Postgres) + Stage 2 (RAM) + Stage 3 Step 1 (WAL)");
  console.log("============================================================");
  console.log("NOTE: Stage 3 Step 1 restores durability via append+fsync-before-apply.");
  console.log("      Step 2 adds group commit; Step 3 adds length+CRC32 framing.");
  try {
    await testDatabaseEngine();
    await testMemoryEngine();
    await testParity();
    await testWalEngine();
    await testGroupCommit();
    await testTornWriteProtection();
  } finally {
    await dbReset();
    await pool.end();
  }

  console.log("\n============================================================");
  console.log(failures === 0 ? "ALL INVARIANTS HOLD (both engines agree)" : `${failures} INVARIANT FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
