// ═══════════════════════════════════════════════════════════════
// Stage 4.2 — READ API (the query side of CQRS)
// ═══════════════════════════════════════════════════════════════
//
//   npm run readapi          (default port 3001)
//
// This is the whole point of Stage 4: users can run real queries —
// trade history, open orders, order book — without any of it touching
// the matching engine.
//
// ── WHAT THIS PROCESS CAN AND CANNOT REACH ─────────────────────
//
// It imports exactly one thing from the rest of the system: the
// Postgres pool. It does NOT import engine.ts, wal.ts, recover.ts,
// bootstrap.ts or orderProcessor.ts, and it never reads the log file.
// Every handler below is a SELECT against readmodel.* and nothing else.
//
// So a slow or expensive query cannot touch the hot path even in
// principle: it runs in a different process, against a different
// schema, on a different port. The engine cannot be slowed by reads
// because there is no shared resource to contend for — the engine
// closes its DB pool after bootstrap and serves entirely from RAM.
//
//     writes: order -> WAL -> engine (RAM)        :3000
//     reads:  readmodel.* <- worker <- WAL        :3001  (this file)
//
// Data here is eventually consistent by construction: it is as fresh
// as the projection worker's cursor. GET /stats exposes that lag
// honestly rather than pretending the read side is synchronous.

import express from "express";
import { pool } from "../db.js";

const app = express();
const PORT = process.env.READ_API_PORT ?? 3001;

const asInt = (v: unknown, dflt: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
};

/** A user's trade history, newest first.
 *  Uses the denormalised buyer_user_id / seller_user_id columns, so this
 *  serves from an index with no join to orders. */
app.get("/history", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) { res.status(400).json({ error: "userId required" }); return; }
  const limit = asInt(req.query.limit, 50, 500);
  try {
    const r = await pool.query(
      `SELECT id, symbol, price::text, quantity::text, executed_at, wal_seq,
              CASE WHEN buyer_user_id = $1 THEN 'buy' ELSE 'sell' END AS side,
              buyer_order_id, seller_order_id
       FROM readmodel.trades
       WHERE buyer_user_id = $1 OR seller_user_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [userId, limit]
    );
    res.json({ userId, count: r.rows.length, trades: r.rows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** A user's resting (open or partially filled) orders. */
app.get("/openorders", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) { res.status(400).json({ error: "userId required" }); return; }
  try {
    const r = await pool.query(
      `SELECT id, symbol, side, price::text, quantity::text, filled::text,
              (quantity - filled)::text AS remaining, status, created_at
       FROM readmodel.orders
       WHERE user_id = $1 AND status IN ('open','partial')
       ORDER BY id DESC`,
      [userId]
    );
    res.json({ userId, count: r.rows.length, orders: r.rows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** A user's balances, joined to the username — a real relational read. */
app.get("/balances", async (req, res) => {
  const userId = Number(req.query.userId);
  try {
    const r = Number.isInteger(userId)
      ? await pool.query(
          `SELECT u.id AS user_id, u.username, b.asset, b.available::text
           FROM readmodel.balances b JOIN readmodel.users u ON u.id = b.user_id
           WHERE b.user_id = $1 ORDER BY b.asset`, [userId])
      : await pool.query(
          `SELECT asset, SUM(available)::text AS total, count(*)::int AS holders
           FROM readmodel.balances GROUP BY asset ORDER BY asset`);
    res.json(Number.isInteger(userId) ? { userId, balances: r.rows } : { totals: r.rows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Aggregated order book for a symbol — a GROUP BY over resting orders. */
app.get("/orderbook", async (req, res) => {
  const symbol = String(req.query.symbol ?? "SOL_USDC");
  const depth = asInt(req.query.depth, 10, 100);
  try {
    const [bids, asks] = await Promise.all([
      pool.query(
        `SELECT price::text, SUM(quantity - filled)::text AS quantity, count(*)::int AS orders
         FROM readmodel.orders
         WHERE symbol = $1 AND side = 'buy' AND status IN ('open','partial')
         GROUP BY price ORDER BY price DESC LIMIT $2`, [symbol, depth]),
      pool.query(
        `SELECT price::text, SUM(quantity - filled)::text AS quantity, count(*)::int AS orders
         FROM readmodel.orders
         WHERE symbol = $1 AND side = 'sell' AND status IN ('open','partial')
         GROUP BY price ORDER BY price ASC LIMIT $2`, [symbol, depth]),
    ]);
    res.json({ symbol, bids: bids.rows, asks: asks.rows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Recent market tape for a symbol. */
app.get("/market", async (req, res) => {
  const symbol = String(req.query.symbol ?? "SOL_USDC");
  const limit = asInt(req.query.limit, 25, 500);
  try {
    const r = await pool.query(
      `SELECT id, price::text, quantity::text, executed_at
       FROM readmodel.trades WHERE symbol = $1 ORDER BY id DESC LIMIT $2`,
      [symbol, limit]
    );
    res.json({ symbol, count: r.rows.length, trades: r.rows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Read-model freshness. Exposes the projection lag rather than hiding it. */
app.get("/stats", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT (SELECT byte_offset FROM readmodel.cursor WHERE id=1)       AS byte_offset,
              (SELECT records_projected FROM readmodel.cursor WHERE id=1) AS records_projected,
              (SELECT updated_at FROM readmodel.cursor WHERE id=1)        AS updated_at,
              (SELECT count(*) FROM readmodel.orders)                     AS orders,
              (SELECT count(*) FROM readmodel.trades)                     AS trades,
              (SELECT count(*) FROM readmodel.balances)                   AS balances`
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", side: "read", source: "readmodel.*" }));

app.listen(PORT, () => {
  console.log(`Read API (CQRS query side) on http://localhost:${PORT}`);
  console.log(`  GET /history?userId=      a user's trades (denormalised, index-served)`);
  console.log(`  GET /openorders?userId=   resting orders`);
  console.log(`  GET /balances[?userId=]   balances, or per-asset totals`);
  console.log(`  GET /orderbook?symbol=    aggregated book`);
  console.log(`  GET /market?symbol=       recent tape`);
  console.log(`  GET /stats                read-model freshness / projection lag`);
  console.log(`  reads readmodel.* ONLY — never the engine, never the log`);
});
