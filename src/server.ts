import express from "express";
import { processOrder } from "./orderProcessor.js";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(500).json({ status: "error", db: "disconnected" });
  }
});

// ── Place an order ───────────────────────────────────────────
// POST /order
// Body: { userId, symbol, side, price, quantity }
app.post("/order", async (req, res) => {
  const { userId, symbol, side, price, quantity } = req.body;

  // Basic input validation
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
    const trade = await processOrder({ userId, symbol, side, price, quantity });
    res.json({ success: true, trade });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Order failed: ${message}`);
    res.status(400).json({ success: false, error: message });
  }
});

// ── View balances (debug / verification) ─────────────────────
app.get("/balances", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.username, b.asset, b.available, b.locked
       FROM users u JOIN balances b ON u.id = b.user_id
       ORDER BY u.id, b.asset`
    );
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── View orders (debug / verification) ───────────────────────
app.get("/orders", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, symbol, side, price, quantity, filled, status, created_at
       FROM orders ORDER BY id`
    );
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── View trades (debug / verification) ───────────────────────
app.get("/trades", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, symbol, price, quantity, buyer_order_id, seller_order_id, created_at
       FROM trades ORDER BY id`
    );
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Exchange API listening on http://localhost:${PORT}`);
  console.log(`  POST /order         — place an order`);
  console.log(`  GET  /balances      — view all balances`);
  console.log(`  GET  /orders        — view all orders`);
  console.log(`  GET  /trades        — view all trades`);
  console.log(`  GET  /health        — health check`);
});
