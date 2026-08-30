// ═══════════════════════════════════════════════════════════════
// Stage 2 — IN-MEMORY SINGLE-WRITER MATCHING ENGINE
// ═══════════════════════════════════════════════════════════════
//
// ⚠️  DURABILITY IS DELIBERATELY GONE. READ THIS BEFORE USING.
//
// Stage 0 processed every order inside a Postgres transaction, so a
// crash rolled back cleanly and committed trades survived. This engine
// holds the order book and every balance in RAM and writes NOTHING to
// disk on the order path.
//
//   A crash — process kill, power loss, unhandled throw that takes the
//   process down — loses ALL state: every balance, every resting order,
//   every trade executed since boot. There is no log, no snapshot, no
//   recovery. Money that "moved" is simply gone.
//
// This is not an oversight and must not be patched here. Stage 1
// profiling showed row-lock contention was 54.2% of backend time
// against 0.15% for fsync, so the licensed move was to delete the lock
// manager from the hot path — which means deleting the transaction, and
// with it durability. Stage 3 rebuilds durability by another route (a
// write-ahead log with group commit and crash recovery). Adding any
// persistence here would pre-empt Stage 3 and make its measurement
// meaningless.
//
// ── Why this is race-free without a single lock ────────────────
//
// processOrder() is SYNCHRONOUS. It contains no await, no I/O, no
// callback. Node's event loop cannot interleave two invocations: once
// one starts it runs to completion before any other JavaScript runs.
// The read-modify-write sequence is therefore atomic by construction.
//
// Stage 0 needed SELECT ... FOR UPDATE because many Postgres backends
// touched the same rows concurrently. Here there is exactly one writer,
// so there is nothing to serialise. "Single-writer" replaces "locking"
// — the same guarantee, obtained structurally instead of at runtime.
//
// ── Matching semantics: a PORT, not a redesign ─────────────────
//
// Every rule below is carried over unchanged from Stage 0's
// orderProcessor.ts and is re-verified by src/test/invariants.ts:
//   - price-time priority: best price first, ties broken by age (id)
//   - a buy matches sells at or BELOW its limit; a sell matches buys
//     at or ABOVE its limit
//   - the trade executes at the RESTING order's price (taker gets
//     price improvement)
//   - ONE price level per incoming order (the Stage 0 `LIMIT 1` scope
//     cut — a large taker is NOT walked down the book)
//   - a partially-filled taker keeps its ORIGINAL quantity, records
//     `filled` separately, gets status 'partial', and RESTS on the book
//   - the taker's funds are checked conservatively against
//     price x full requested quantity
//   - the maker must still hold what its resting order promises
//
// The negative-balance guard below replaces Stage 0's
// CHECK (available >= 0) constraint, which does not exist in RAM.

export interface OrderInput {
  userId: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
}

export interface TradeResult {
  tradeId: number;
  symbol: string;
  price: number;
  quantity: number;
  buyerOrderId: number;
  sellerOrderId: number;
}

export interface Order {
  id: number;
  userId: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  filled: number;
  status: "open" | "partial" | "filled";
}

export interface Trade {
  id: number;
  symbol: string;
  price: number;
  quantity: number;
  buyerOrderId: number;
  sellerOrderId: number;
}

// NUMERIC(20,8) in Stage 0 rounded every stored value to 8 decimals.
// Rounding the same way keeps the in-memory arithmetic comparable
// rather than letting raw float drift diverge from the DB baseline.
const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

/**
 * One side of one symbol's book: price level -> FIFO queue of resting
 * orders. Insertion order within a level preserves time priority, so
 * the head of a level is always the oldest order at that price.
 */
class BookSide {
  private levels = new Map<number, Order[]>();
  private prices: number[] = []; // kept sorted ascending

  add(order: Order): void {
    let level = this.levels.get(order.price);
    if (!level) {
      level = [];
      this.levels.set(order.price, level);
      // insert price into the sorted array
      let i = 0;
      while (i < this.prices.length && this.prices[i] < order.price) i++;
      this.prices.splice(i, 0, order.price);
    }
    level.push(order); // FIFO => time priority
  }

  /** Cheapest resting order at or below `limit` (for an incoming buy). */
  bestAtOrBelow(limit: number): Order | null {
    for (const p of this.prices) {
      if (p > limit) break; // ascending: nothing cheaper remains
      const level = this.levels.get(p);
      if (level && level.length > 0) return level[0];
    }
    return null;
  }

  /** Most expensive resting order at or above `limit` (for an incoming sell). */
  bestAtOrAbove(limit: number): Order | null {
    for (let i = this.prices.length - 1; i >= 0; i--) {
      const p = this.prices[i];
      if (p < limit) break; // descending: nothing dearer remains
      const level = this.levels.get(p);
      if (level && level.length > 0) return level[0];
    }
    return null;
  }

  /** Remove a fully-filled order from the head of its level. */
  remove(order: Order): void {
    const level = this.levels.get(order.price);
    if (!level) return;
    const i = level.indexOf(order);
    if (i !== -1) level.splice(i, 1);
  }
}

export class MatchingEngine {
  private balances = new Map<string, number>(); // `${userId}:${asset}` -> amount
  private books = new Map<string, { buy: BookSide; sell: BookSide }>();
  private orders: Order[] = [];
  private trades: Trade[] = [];
  private nextOrderId = 1;
  private nextTradeId = 1;

  // ── State setup (bootstrap only — never on the hot path) ──────

  setBalance(userId: number, asset: string, amount: number): void {
    this.balances.set(`${userId}:${asset}`, round8(amount));
  }

  getBalance(userId: number, asset: string): number | undefined {
    return this.balances.get(`${userId}:${asset}`);
  }

  /** Seed a resting order directly (bootstrap / test fixture). */
  addRestingOrder(o: {
    id?: number;
    userId: number;
    symbol: string;
    side: "buy" | "sell";
    price: number;
    quantity: number;
    filled?: number;
  }): Order {
    const order: Order = {
      id: o.id ?? this.nextOrderId++,
      userId: o.userId,
      symbol: o.symbol,
      side: o.side,
      price: o.price,
      quantity: o.quantity,
      filled: o.filled ?? 0,
      status: (o.filled ?? 0) > 0 ? "partial" : "open",
    };
    if (o.id !== undefined && o.id >= this.nextOrderId) this.nextOrderId = o.id + 1;
    this.orders.push(order);
    this.book(order.symbol)[order.side].add(order);
    return order;
  }

  private book(symbol: string) {
    let b = this.books.get(symbol);
    if (!b) {
      b = { buy: new BookSide(), sell: new BookSide() };
      this.books.set(symbol, b);
    }
    return b;
  }

  // ── Introspection (tests / debug endpoints) ───────────────────

  getOrders(): Order[] { return this.orders; }
  getTrades(): Trade[] { return this.trades; }

  /** Per-asset totals, for the conservation invariant. */
  totals(): Map<string, number> {
    const t = new Map<string, number>();
    for (const [key, amt] of this.balances) {
      const asset = key.split(":")[1];
      t.set(asset, round8((t.get(asset) ?? 0) + amt));
    }
    return t;
  }

  negativeBalanceCount(): number {
    let n = 0;
    for (const amt of this.balances.values()) if (amt < 0) n++;
    return n;
  }

  private credit(userId: number, asset: string, amount: number): void {
    const key = `${userId}:${asset}`;
    const next = round8((this.balances.get(key) ?? 0) + amount);
    // Structural guard replacing Stage 0's CHECK (available >= 0).
    // Should be unreachable: both parties are validated before any
    // funds move. If it ever fires, the validation above is wrong.
    if (next < 0) {
      throw new Error(
        `INVARIANT VIOLATION: balance for user ${userId} ${asset} would go negative (${next})`
      );
    }
    this.balances.set(key, next);
  }

  // ── THE HOT PATH ──────────────────────────────────────────────
  //
  // SYNCHRONOUS ON PURPOSE. Do not make this async and do not add an
  // await inside it: the moment it yields, two orders can interleave
  // and the single-writer guarantee — the entire reason this stage
  // exists — is silently lost.

  processOrder(input: OrderInput): TradeResult {
    const [baseAsset, quoteAsset] = input.symbol.split("_");
    const book = this.book(input.symbol);

    // Step 1: best matching resting order (price-time priority, ONE level).
    const resting =
      input.side === "buy"
        ? book.sell.bestAtOrBelow(input.price)
        : book.buy.bestAtOrAbove(input.price);

    if (!resting) {
      // Same Stage 0 scope cut: no match => reject outright, the taker
      // does not rest. (Bug 5, single-level match, still open.)
      throw new Error("No matching resting order found");
    }

    const restingRemaining = round8(resting.quantity - resting.filled);
    const fillQty = Math.min(input.quantity, restingRemaining);
    const fillPrice = resting.price; // trade at the RESTING order's price
    const totalCost = round8(fillQty * fillPrice);

    const makerId = resting.userId;
    const buyerId = input.side === "buy" ? input.userId : makerId;
    const sellerId = input.side === "sell" ? input.userId : makerId;

    // Step 2a: validate the TAKER (conservative — full requested size).
    const takerAsset = input.side === "buy" ? quoteAsset : baseAsset;
    const takerNeeds =
      input.side === "buy" ? round8(input.price * input.quantity) : input.quantity;
    const takerHas = this.balances.get(`${input.userId}:${takerAsset}`);

    if (takerHas === undefined) {
      throw new Error(`No ${takerAsset} balance found for user ${input.userId}`);
    }
    if (takerHas < takerNeeds) {
      throw new Error(`Insufficient ${takerAsset}: have ${takerHas}, need ${takerNeeds}`);
    }

    // Step 2b: validate the MAKER still holds what its order promises.
    const makerAsset = input.side === "buy" ? baseAsset : quoteAsset;
    const makerNeeds = input.side === "buy" ? fillQty : totalCost;
    const makerHas = this.balances.get(`${makerId}:${makerAsset}`) ?? 0;

    if (makerHas < makerNeeds) {
      throw new Error(
        `Maker (user ${makerId}) has insufficient ${makerAsset}: have ${makerHas}, need ${makerNeeds}`
      );
    }

    // Steps 3-6: move funds. No transaction — every check above has
    // already passed, and nothing can interleave, so this cannot be
    // observed half-applied.
    this.credit(buyerId, quoteAsset, -totalCost);
    this.credit(buyerId, baseAsset, fillQty);
    this.credit(sellerId, baseAsset, -fillQty);
    this.credit(sellerId, quoteAsset, totalCost);

    // Step 7a: update the resting order; drop it from the book if done.
    resting.filled = round8(resting.filled + fillQty);
    if (resting.filled >= resting.quantity) {
      resting.status = "filled";
      book[resting.side].remove(resting);
    } else {
      resting.status = "partial";
    }

    // Step 7b: record the incoming order with its ORIGINAL quantity.
    // A partial taker rests on the book (Stage 0 Decision 1).
    const incoming: Order = {
      id: this.nextOrderId++,
      userId: input.userId,
      symbol: input.symbol,
      side: input.side,
      price: input.price,
      quantity: input.quantity,
      filled: fillQty,
      status: fillQty >= input.quantity ? "filled" : "partial",
    };
    this.orders.push(incoming);
    if (incoming.status === "partial") book[incoming.side].add(incoming);

    // Step 7c: record the trade.
    const trade: Trade = {
      id: this.nextTradeId++,
      symbol: input.symbol,
      price: fillPrice,
      quantity: fillQty,
      buyerOrderId: input.side === "buy" ? incoming.id : resting.id,
      sellerOrderId: input.side === "sell" ? incoming.id : resting.id,
    };
    this.trades.push(trade);

    return {
      tradeId: trade.id,
      symbol: trade.symbol,
      price: trade.price,
      quantity: trade.quantity,
      buyerOrderId: trade.buyerOrderId,
      sellerOrderId: trade.sellerOrderId,
    };
  }
}
