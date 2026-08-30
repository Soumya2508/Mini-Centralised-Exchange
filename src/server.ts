// ── Stage 3 Step 1 API — WAL-backed in-memory engine ──────────
//
// Order path per request:
//   1. validate the request shape
//   2. append the order to the WAL and fsync it to disk
//   3. ONLY THEN apply it to the in-memory engine
//
// Step 2 of the write is the durability point. If the process dies
// after (2) and before (3), replay re-applies the order. If it dies
// during (2), the record never lands and memory never saw it either.
// Memory can never be ahead of the log.
//
// Step 1 fsyncs every order individually — the deliberately naive
// baseline whose cost licenses group commit in Step 2.

import express from "express";
import { MatchingEngine } from "./engine.js";
import { Wal, DEFAULT_WAL_PATH } from "./wal.js";
import { recover } from "./recover.js";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

let engine: MatchingEngine;
let wal: Wal;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    engine: engine ? "in-memory" : "not ready",
    durable: true,
    mode: "wal-fsync-per-order",
    walPath: DEFAULT_WAL_PATH,
    walBytes: Wal.sizeBytes(DEFAULT_WAL_PATH),
    appends: wal ? wal.appendCount : 0,
    fsyncs: wal ? wal.fsyncCount : 0,
  });
});

// ── Place an order: WAL append + fsync, THEN apply ────────────
app.post("/order", (req, res) => {
  const { userId, symbol, side, price, quantity } = req.body;

  // Shape validation happens BEFORE the log: a malformed HTTP request
  // is not an order and must never enter the WAL.
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

  // ── WRITE-AHEAD: durable on disk before it exists in memory ──
  wal.append({ userId, symbol, side, price, quantity });

  // ── Then apply. A business rejection here (no match, insufficient
  // funds) is a legitimate outcome, not a durability failure: the
  // order was genuinely submitted and replay will reject it too.
  try {
    const trade = engine.processOrder({ userId, symbol, side, price, quantity });
    res.json({ success: true, trade });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ success: false, error: message });
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
    walBytes: Wal.sizeBytes(DEFAULT_WAL_PATH),
    walSequence: wal.sequence,
  });
});

// ── Start: genesis -> replay -> resume ───────────────────────
const PORT = process.env.PORT ?? 3000;

recover(DEFAULT_WAL_PATH)
  .then(async (r) => {
    engine = r.engine;
    wal = r.wal;
    // The genesis read is the only DB access; close the pool so it is
    // unmistakable that the order path never touches Postgres.
    await pool.end();
    app.listen(PORT, () => {
      console.log(`Exchange API (Stage 3 Step 1, WAL + in-memory) on http://localhost:${PORT}`);
      console.log(`  genesis:  ${r.genesisBalances} balances, ${r.genesisOrders} resting orders (Postgres)`);
      console.log(`  RECOVERY: replayed ${r.recordsReplayed} WAL records in ${r.recoveryMs.toFixed(1)}ms ` +
                  `(${r.appliedOnReplay} applied, ${r.rejectedOnReplay} rejected)`);
      console.log(`  WAL:      ${DEFAULT_WAL_PATH} (${Wal.sizeBytes(DEFAULT_WAL_PATH)} bytes), resuming at seq ${wal.sequence}`);
      console.log(`  DURABLE:  append + fsync BEFORE apply, one fsync per order`);
    });
  })
  .catch((err) => {
    console.error("recovery failed:", err);
    process.exit(1);
  });
