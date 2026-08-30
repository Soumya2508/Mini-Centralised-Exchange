// ── Stage 3 Step 2 API — WAL with GROUP COMMIT ────────────────
//
// Order path per request:
//   1. validate the request shape
//   2. write() the record to the log        <- ordered, not yet durable
//   3. apply it to the in-memory engine
//   4. await the batch fsync                <- THE durability point
//   5. ONLY THEN acknowledge the client
//
// Step 2 precedes step 3, so this is never apply-then-log. Step 4
// precedes step 5, so nothing is ever acknowledged before it is on
// disk. An order that was applied but not yet fsynced exists only in
// RAM; if the process dies there, memory dies with it and recovery
// replays a log that simply lacks the order — and the client was never
// told it succeeded. There is no acknowledged-but-lost window.
//
// WAL_MODE selects the durability strategy, so all three can be
// measured back-to-back in ONE session (cross-session throughput
// comparisons on this host are unreliable — see DEVLOG):
//   group-commit    (default) batched fsync
//   fsync-per-order           Step 1 behaviour
//   none                      NO WAL AT ALL - Stage 2 behaviour.
//                             MEASUREMENT ONLY. Not durable. Never a
//                             deployment setting; it exists so the cost
//                             of durability can be priced honestly.
// WAL_BATCH_SIZE / WAL_BATCH_MS tune the batch triggers.

import express from "express";
import { MatchingEngine } from "./engine.js";
import { Wal, GroupCommitWal, DEFAULT_WAL_PATH, WalFormat } from "./wal.js";
import { recover } from "./recover.js";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

const WAL_MODE = process.env.WAL_MODE ?? "group-commit";
// Tuned defaults (measured, see DEVLOG): batch 32, maxDelay 0.
//
// maxDelay 0 means "flush at the end of this event-loop turn"
// (setImmediate) rather than arming a timer. That matters a lot: on
// Windows the default timer resolution is ~15.6ms, so setTimeout(1) does
// NOT fire in 1ms. At 1 VU the timer path measured 69 ord/s (p50 15.3ms)
// against 603 ord/s (p50 1.4ms) for setImmediate — 8.8x. At 25+ VUs the
// two are equal because the size threshold fires first either way.
//
// Batch size is bounded by in-flight requests, so a large maxBatch
// without matching concurrency just defers to the delay trigger.
const BATCH_SIZE = Number(process.env.WAL_BATCH_SIZE ?? 32);
const BATCH_MS = Number(process.env.WAL_BATCH_MS ?? 0);
// "framed" = Step 3 (length prefix + CRC32). "jsonl" = Step 1/2 format,
// kept only so both can be measured in ONE session.
const WAL_FORMAT = (process.env.WAL_FORMAT ?? "framed") as WalFormat;

let engine: MatchingEngine;
let gcWal: GroupCommitWal | null = null;
let perOrderWal: Wal | null = null;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    engine: engine ? "in-memory" : "not ready",
    durable: WAL_MODE !== "none",
    mode: WAL_MODE,
    format: WAL_FORMAT,
    batchSize: WAL_MODE === "group-commit" ? BATCH_SIZE : 1,
    batchMs: WAL_MODE === "group-commit" ? BATCH_MS : 0,
    walBytes: Wal.sizeBytes(DEFAULT_WAL_PATH),
    appends: gcWal?.appendCount ?? perOrderWal?.appendCount ?? 0,
    fsyncs: gcWal?.fsyncCount ?? perOrderWal?.fsyncCount ?? 0,
    avgBatch: gcWal ? Number(gcWal.averageBatchSize.toFixed(2)) : 1,
  });
});

app.post("/order", async (req, res) => {
  const { userId, symbol, side, price, quantity } = req.body;

  // Shape validation BEFORE the log: a malformed HTTP request is not an
  // order and must never enter the WAL.
  if (!userId || !symbol || !side || !price || !quantity) {
    res.status(400).json({ success: false, error: "Missing required fields: userId, symbol, side, price, quantity" });
    return;
  }
  if (side !== "buy" && side !== "sell") {
    res.status(400).json({ success: false, error: "side must be 'buy' or 'sell'" });
    return;
  }
  if (price <= 0 || quantity <= 0) {
    res.status(400).json({ success: false, error: "price and quantity must be positive" });
    return;
  }

  const input = { userId, symbol, side, price, quantity } as const;

  if (WAL_MODE === "none") {
    // Measurement baseline: no logging, no durability (Stage 2).
    try {
      res.json({ success: true, trade: engine.processOrder(input) });
    } catch (err: unknown) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
    }
    return;
  }

  if (gcWal) {
    // ── GROUP COMMIT ──
    // write -> apply -> await batch fsync -> ack
    const { durable } = gcWal.appendAndAwaitDurable(input);

    let trade: unknown = null;
    let error: string | null = null;
    try {
      trade = engine.processOrder(input);
    } catch (err) {
      error = err instanceof Error ? err.message : "Unknown error";
    }

    // Do not answer until this order's batch is on disk.
    await durable;

    if (error) res.status(400).json({ success: false, error });
    else res.json({ success: true, trade });
    return;
  }

  // ── Step 1 behaviour: one fsync per order ──
  perOrderWal!.append(input);
  try {
    const trade = engine.processOrder(input);
    res.json({ success: true, trade });
  } catch (err: unknown) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// ── Read endpoints (served from RAM) ─────────────────────────
app.get("/balances", (_req, res) => {
  const out: Array<{ asset: string; total: number }> = [];
  for (const [asset, total] of engine.totals()) out.push({ asset, total });
  res.json({ totals: out, negativeBalances: engine.negativeBalanceCount() });
});

app.get("/orders", (_req, res) => res.json(engine.getOrders()));
app.get("/trades", (_req, res) => res.json(engine.getTrades()));

/** Compact fingerprint of engine state — used by the crash-recovery proof. */
app.get("/state", (_req, res) => {
  const totals: Record<string, number> = {};
  for (const [asset, t] of engine.totals()) totals[asset] = t;
  const orders = engine.getOrders();
  res.json({
    totals,
    negativeBalances: engine.negativeBalanceCount(),
    orderCount: orders.length,
    restingOrders: orders.filter((o) => o.status === "open" || o.status === "partial").length,
    tradeCount: engine.getTrades().length,
    lastTrade: engine.getTrades().slice(-1)[0] ?? null,
  });
});

// ── Start: genesis -> replay -> resume ───────────────────────
const PORT = process.env.PORT ?? 3000;

recover(DEFAULT_WAL_PATH)
  .then(async (r) => {
    engine = r.engine;
    if (WAL_MODE === "none") {
      // no log opened
    } else if (WAL_MODE === "group-commit") {
      gcWal = new GroupCommitWal(DEFAULT_WAL_PATH, r.startSeq, {
        maxBatch: BATCH_SIZE,
        maxDelayMs: BATCH_MS,
        format: WAL_FORMAT,
      });
    } else {
      perOrderWal = new Wal(DEFAULT_WAL_PATH, r.startSeq, WAL_FORMAT);
    }
    if (WAL_MODE === "none") {
      console.warn("  *** WAL_MODE=none — NO DURABILITY. Measurement only. ***");
    }
    await pool.end();
    app.listen(PORT, () => {
      console.log(`Exchange API (Stage 3 Step 2, WAL + in-memory) on http://localhost:${PORT}`);
      console.log(`  genesis:  ${r.genesisBalances} balances, ${r.genesisOrders} resting orders (Postgres)`);
      console.log(`  RECOVERY: replayed ${r.recordsReplayed} WAL records in ${r.recoveryMs.toFixed(1)}ms ` +
                  `(${r.appliedOnReplay} applied, ${r.rejectedOnReplay} rejected)`);
      if (r.discardedBytes > 0) {
        console.log(`  TORN TAIL: discarded ${r.discardedBytes} trailing bytes (${r.tornReason}) — ` +
                    `never acknowledged, safe to drop`);
      }
      if (r.midFileCorruption) {
        console.warn(`  *** MID-FILE CORRUPTION (${r.tornReason}) — not a torn tail. ` +
                     `Records after the damage were NOT recovered. ***`);
      }
      console.log(`  WAL fmt:  ${WAL_FORMAT}` + (WAL_FORMAT === "framed" ? " (len + JSON + CRC32)" : " (no torn-write protection)"));
      console.log(`  WAL mode: ${WAL_MODE}` +
                  (WAL_MODE === "group-commit" ? ` (batch=${BATCH_SIZE}, maxDelay=${BATCH_MS}ms)` : ""));
      console.log(`  DURABLE:  write -> apply -> fsync -> ack; nothing acked before its fsync`);
    });
  })
  .catch((err) => {
    console.error("recovery failed:", err);
    process.exit(1);
  });
