// ── Stage 2 API — serves the IN-MEMORY engine ─────────────────
//
// ⚠️  NO DURABILITY. State lives only in this process's heap. Killing
// the server discards every balance, resting order and trade produced
// since boot. Restarting reloads the seeded starting state from
// Postgres and everything that happened in between is gone.
// Stage 3 (WAL) restores durability. See engine.ts.

import express from "express";
import { MatchingEngine } from "./engine.js";
import { bootstrapFromDatabase } from "./bootstrap.js";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

let engine: MatchingEngine;

// ── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", engine: engine ? "in-memory" : "not ready", durable: false });
});

// ── Place an order (hot path: RAM only, no DB, no locks) ──────
app.post("/order", (req, res) => {
  const { userId, symbol, side, price, quantity } = req.body;

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

  try {
    // Synchronous: runs to completion with no interleaving.
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

// ── Start: bootstrap RAM from Postgres once, then serve ───────
const PORT = process.env.PORT ?? 3000;

bootstrapFromDatabase()
  .then(({ engine: e, balanceRows, restingOrders }) => {
    engine = e;
    // The bootstrap read is the only DB access; release the pool so it
    // is unmistakable that the hot path never touches Postgres.
    return pool.end().then(() => ({ balanceRows, restingOrders }));
  })
  .then(({ balanceRows, restingOrders }) => {
    app.listen(PORT, () => {
      console.log(`Exchange API (Stage 2, IN-MEMORY) on http://localhost:${PORT}`);
      console.log(`  bootstrapped ${balanceRows} balances, ${restingOrders} resting orders from Postgres`);
      console.log(`  DB pool closed — order path is RAM only`);
      console.log(`  *** NO DURABILITY: a crash loses all state (Stage 3 restores it) ***`);
    });
  })
  .catch((err) => {
    console.error("bootstrap failed:", err);
    process.exit(1);
  });
