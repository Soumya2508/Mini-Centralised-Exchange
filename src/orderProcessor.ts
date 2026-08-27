import { pool } from "./db.js";

// ── Types ────────────────────────────────────────────────────
export interface OrderInput {
  userId: number;        // who is placing this order
  symbol: string;        // e.g. "SOL_USDC"
  side: "buy" | "sell";
  price: number;         // limit price
  quantity: number;      // how many units of the base asset
}

export interface TradeResult {
  tradeId: number;
  symbol: string;
  price: number;
  quantity: number;
  buyerOrderId: number;
  sellerOrderId: number;
}

// ── Core transactional order processor ───────────────────────
// Stage 0 "honest baseline" — every order runs inside ONE Postgres
// transaction with row-level locking (FOR UPDATE).
//
// LOCK DISCIPLINE (load-bearing — do not reorder):
//   1. Lock the matching resting order row.
//   2. Lock EVERY balance row the trade touches in a SINGLE query,
//      ordered by (user_id, asset).
// Postgres locks rows in the order the plan returns them, so both
// sides of any concurrent pair acquire the same rows in the same
// global order and queue instead of forming a cycle.
//
// The previous version locked "my own row first, then the other
// party's rows". Two users trading into each other therefore grabbed
// the same two rows in opposite order — a guaranteed deadlock cycle.
//
// Atomicity: if any step throws, Postgres rolls back everything.

export async function processOrder(input: OrderInput): Promise<TradeResult> {
  const client = await pool.connect();

  const baseAsset = input.symbol.split("_")[0];  // "SOL"
  const quoteAsset = input.symbol.split("_")[1]; // "USDC"

  try {
    await client.query("BEGIN");

    // ── Step 1: Find & lock the best matching resting order ──
    // Price-time priority: best price first, then oldest order.
    // A buy matches sells at or below its limit; a sell matches buys
    // at or above its limit.
    const oppositeSide = input.side === "buy" ? "sell" : "buy";
    const priceCondition = input.side === "buy" ? "<=" : ">=";
    const priceSort = input.side === "buy" ? "ASC" : "DESC"; // best price for the taker

    const matchRes = await client.query(
      `SELECT id, user_id, price, quantity, filled
       FROM orders
       WHERE symbol = $1
         AND side = $2
         AND status IN ('open', 'partial')
         AND price ${priceCondition} $3
       ORDER BY price ${priceSort}, id ASC
       LIMIT 1
       FOR UPDATE`,
      [input.symbol, oppositeSide, input.price]
    );

    if (matchRes.rows.length === 0) {
      // OPEN — Bug 5 (single-level match), pending a human scope decision:
      // only ONE price level is ever consulted. A taker larger than the
      // best level is not walked down the book; the remainder is dropped
      // rather than resting. Left as-is deliberately.
      throw new Error("No matching resting order found");
    }

    const resting = matchRes.rows[0];
    const restingRemaining = Number(resting.quantity) - Number(resting.filled);
    const fillQty = Math.min(input.quantity, restingRemaining);
    const fillPrice = Number(resting.price); // trade executes at resting order's price
    const totalCost = fillQty * fillPrice;

    const makerId  = Number(resting.user_id);
    const buyerId  = input.side === "buy" ? input.userId : makerId;
    const sellerId = input.side === "sell" ? input.userId : makerId;

    // ── Step 2: Lock EVERY balance row this trade touches, at once ──
    // Both parties, both assets, one query, ORDER BY user_id, asset.
    const balRes = await client.query(
      `SELECT user_id, asset, available FROM balances
       WHERE user_id IN ($1, $2)
         AND asset   IN ($3, $4)
       ORDER BY user_id, asset
       FOR UPDATE`,
      [input.userId, makerId, baseAsset, quoteAsset]
    );

    const findBalance = (userId: number, asset: string) =>
      balRes.rows.find((r) => Number(r.user_id) === userId && r.asset === asset);

    // ── Step 2a: Validate the TAKER ──────────────────────────
    const takerAsset = input.side === "buy" ? quoteAsset : baseAsset;
    const takerNeeds = input.side === "buy"
      ? input.price * input.quantity   // conservative: the full order as submitted
      : input.quantity;
    const takerRow = findBalance(input.userId, takerAsset);

    if (!takerRow) {
      throw new Error(`No ${takerAsset} balance found for user ${input.userId}`);
    }
    const takerHas = Number(takerRow.available);
    if (takerHas < takerNeeds) {
      throw new Error(`Insufficient ${takerAsset}: have ${takerHas}, need ${takerNeeds}`);
    }

    // ── Step 2b: Validate the MAKER ──────────────────────────
    // The resting order's owner must still hold what their order promises.
    // Without this the fill drives their balance negative and the exchange
    // invents assets out of nothing.
    const makerAsset = input.side === "buy" ? baseAsset : quoteAsset;
    const makerNeeds = input.side === "buy" ? fillQty : totalCost;
    const makerRow = findBalance(makerId, makerAsset);
    const makerHas = makerRow ? Number(makerRow.available) : 0;

    if (makerHas < makerNeeds) {
      throw new Error(
        `Maker (user ${makerId}) has insufficient ${makerAsset}: have ${makerHas}, need ${makerNeeds}`
      );
    }

    // ── Steps 3-6: Move money ────────────────────────────────

    // 3. Debit quote asset (USDC) from buyer
    await client.query(
      `UPDATE balances SET available = available - $1
       WHERE user_id = $2 AND asset = $3`,
      [totalCost, buyerId, quoteAsset]
    );

    // 4. Credit base asset (SOL) to buyer
    await client.query(
      `UPDATE balances SET available = available + $1
       WHERE user_id = $2 AND asset = $3`,
      [fillQty, buyerId, baseAsset]
    );

    // 5. Debit base asset (SOL) from seller
    await client.query(
      `UPDATE balances SET available = available - $1
       WHERE user_id = $2 AND asset = $3`,
      [fillQty, sellerId, baseAsset]
    );

    // 6. Credit quote asset (USDC) to seller
    await client.query(
      `UPDATE balances SET available = available + $1
       WHERE user_id = $2 AND asset = $3`,
      [totalCost, sellerId, quoteAsset]
    );

    // ── Step 7a: Update the resting order ────────────────────
    const newFilled = Number(resting.filled) + fillQty;
    const newStatus = newFilled >= Number(resting.quantity) ? "filled" : "partial";

    await client.query(
      `UPDATE orders SET filled = $1, status = $2 WHERE id = $3`,
      [newFilled, newStatus, resting.id]
    );

    // ── Step 7b: Insert the incoming order ───────────────────
    // `quantity` records what the taker ACTUALLY asked for; `filled` records
    // how much of it executed. The previous version stored fillQty as the
    // quantity, which destroyed the real request and made every partial fill
    // look like a complete one.
    const incomingStatus = fillQty >= input.quantity ? "filled" : "partial";
    const incomingOrderRes = await client.query(
      `INSERT INTO orders (user_id, symbol, side, price, quantity, filled, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.userId, input.symbol, input.side, input.price,
       input.quantity, fillQty, incomingStatus]
    );
    const incomingOrderId = incomingOrderRes.rows[0].id;

    // ── Step 7c: Insert the trade record ─────────────────────
    const buyerOrderId  = input.side === "buy" ? incomingOrderId : resting.id;
    const sellerOrderId = input.side === "sell" ? incomingOrderId : resting.id;

    const tradeRes = await client.query(
      `INSERT INTO trades (symbol, price, quantity, buyer_order_id, seller_order_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.symbol, fillPrice, fillQty, buyerOrderId, sellerOrderId]
    );

    // ── COMMIT — all writes become permanent atomically ──────
    await client.query("COMMIT");

    return {
      tradeId: tradeRes.rows[0].id,
      symbol: input.symbol,
      price: fillPrice,
      quantity: fillQty,
      buyerOrderId,
      sellerOrderId,
    };
  } catch (err) {
    // ROLLBACK — undo everything; the world is as if this order never happened.
    await client.query("ROLLBACK");
    throw err;
  } finally {
    // Return the connection to the pool (does NOT close it).
    client.release();
  }
}
