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
// This is the Stage 0 "honest baseline" — every order runs inside
// a single Postgres transaction with row-level locking (FOR UPDATE).
//
// The seven writes, one atomic unit:
//   1. Lock & read the incoming user's balance   (SELECT … FOR UPDATE)
//   2. Lock & read the best matching resting order (SELECT … FOR UPDATE)
//   3. Debit buyer's USDC
//   4. Credit buyer's SOL
//   5. Debit seller's SOL
//   6. Credit seller's USDC
//   7. Update resting order status + insert trade record
//
// Atomicity guarantee: if ANY step fails or the process crashes,
// Postgres rolls back ALL changes — no half-executed orders, no
// destroyed money.

export async function processOrder(input: OrderInput): Promise<TradeResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ── Step 1: Lock the incoming user's relevant balance ─────
    // FOR UPDATE = row-level lock; any concurrent transaction
    // touching the same row must wait until we COMMIT or ROLLBACK.
    const incomingAsset = input.side === "buy" ? "USDC" : input.symbol.split("_")[0]; // e.g. "SOL"
    const balRes = await client.query(
      `SELECT id, available FROM balances
       WHERE user_id = $1 AND asset = $2
       FOR UPDATE`,
      [input.userId, incomingAsset]
    );

    if (balRes.rows.length === 0) {
      throw new Error(`No ${incomingAsset} balance found for user ${input.userId}`);
    }

    const availableBalance = Number(balRes.rows[0].available);
    const requiredAmount = input.side === "buy"
      ? input.price * input.quantity   // buyer needs price × qty in quote asset (USDC)
      : input.quantity;                // seller needs qty in base asset (SOL)

    if (availableBalance < requiredAmount) {
      throw new Error(
        `Insufficient ${incomingAsset}: have ${availableBalance}, need ${requiredAmount}`
      );
    }

    // ── Step 2: Find & lock the best matching resting order ──
    // Price-time priority: best price first, then oldest order.
    // A buy matches sells at or below the buy price.
    // A sell matches buys at or above the sell price.
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
      // No match — in a real exchange we'd insert a resting order.
      // For Stage 0 baseline we keep it simple: reject if no match.
      throw new Error("No matching resting order found");
    }

    const resting = matchRes.rows[0];
    const restingRemaining = Number(resting.quantity) - Number(resting.filled);
    const fillQty = Math.min(input.quantity, restingRemaining);
    const fillPrice = Number(resting.price); // trade executes at resting order's price
    const totalCost = fillQty * fillPrice;

    // Determine buyer and seller user IDs
    const buyerId  = input.side === "buy" ? input.userId : resting.user_id;
    const sellerId = input.side === "sell" ? input.userId : resting.user_id;

    // We need to lock the OTHER party's balances too
    await client.query(
      `SELECT id FROM balances
       WHERE user_id = $1 AND asset IN ('USDC', $2)
       FOR UPDATE`,
      [input.side === "buy" ? resting.user_id : input.userId,
       input.symbol.split("_")[0]]
    );

    // ── Steps 3-6: Move money ────────────────────────────────
    const baseAsset = input.symbol.split("_")[0];  // "SOL"
    const quoteAsset = input.symbol.split("_")[1]; // "USDC"

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

    // ── Step 7b: Insert the incoming order (already filled) ──
    const incomingOrderRes = await client.query(
      `INSERT INTO orders (user_id, symbol, side, price, quantity, filled, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.userId, input.symbol, input.side, input.price, fillQty, fillQty, "filled"]
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

    // ── COMMIT — all 7+ writes become permanent atomically ───
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
