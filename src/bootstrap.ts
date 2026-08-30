// ── Stage 2 bootstrap: load initial state into RAM, once ──────
//
// Postgres is read EXACTLY ONCE, at process start, to populate the
// in-memory engine with the seeded users, balances and resting book.
// After this returns, the database is never touched again by the order
// path — nothing is written back, ever.
//
// This is a convenience so the Stage 0 seed (`db/init.sql`,
// `db/seed-load.sql`) still defines the starting state and the Stage 1
// and Stage 2 measurements compare like with like. It is NOT
// persistence: every order processed after boot exists only in RAM and
// is lost on crash. See the header of engine.ts.

import { pool } from "./db.js";
import { MatchingEngine } from "./engine.js";

export async function bootstrapFromDatabase(): Promise<{
  engine: MatchingEngine;
  balanceRows: number;
  restingOrders: number;
}> {
  const engine = new MatchingEngine();

  const bal = await pool.query("SELECT user_id, asset, available FROM balances");
  for (const r of bal.rows) {
    engine.setBalance(Number(r.user_id), r.asset, Number(r.available));
  }

  const ord = await pool.query(
    `SELECT id, user_id, symbol, side, price, quantity, filled
     FROM orders
     WHERE status IN ('open','partial')
     ORDER BY id`
  );
  for (const r of ord.rows) {
    engine.addRestingOrder({
      id: Number(r.id),
      userId: Number(r.user_id),
      symbol: r.symbol,
      side: r.side,
      price: Number(r.price),
      quantity: Number(r.quantity),
      filled: Number(r.filled),
    });
  }

  return { engine, balanceRows: bal.rows.length, restingOrders: ord.rows.length };
}
