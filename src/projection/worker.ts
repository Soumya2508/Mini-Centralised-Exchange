// ═══════════════════════════════════════════════════════════════
// Stage 4, Step 4.1 — PROJECTION WORKER
// ═══════════════════════════════════════════════════════════════
//
//   npm run projector      (start AFTER the engine; order does not
//                           actually matter — see "decoupling" below)
//
// The WAL is the source of truth. Postgres becomes a DERIVED read-model
// of it. This worker is the only thing that writes that read-model.
//
// ── DECOUPLING IS THE POINT ────────────────────────────────────
//
// This is a SEPARATE PROCESS with its own entry point. The engine has
// zero dependency on it: the hot path never calls it, never awaits it,
// and does not know it exists. Nothing here is imported by server.ts.
// Data flows strictly one way:
//
//     order -> WAL (fsync) -> engine (RAM)
//                 |
//                 +--(tail, read-only)--> worker -> Postgres read-model
//
// The worker only ever READS the log. It never writes to the WAL and
// never feeds anything back into the engine. Kill the worker and the
// exchange keeps trading at full speed; the read-model simply goes
// stale and catches up when the worker returns.
//
// No Redis, no message queue. The worker tails the log file directly,
// which is what makes Postgres a *provably* pure derived view: there is
// no second channel through which state could arrive.
//
// ── WHY THE READ-MODEL LIVES IN ITS OWN SCHEMA ─────────────────
//
// The engine bootstraps its GENESIS state from the public `orders` and
// `balances` tables. If the projection wrote into those, the next
// engine restart would load a different genesis and replay would
// rebuild the wrong world — the read-model would silently corrupt the
// source of truth. So everything projected goes into a separate
// `readmodel` schema. public.* is read-only genesis; readmodel.* is
// derived and disposable, rebuildable from the log at any time.
//
// ── EXACTLY-ONCE, WITHOUT IDEMPOTENCY GYMNASTICS ───────────────
//
// The cursor (how far the log has been projected) lives in Postgres and
// is updated in the SAME TRANSACTION as the rows it accounts for:
//
//     BEGIN; upsert orders/trades/balances; UPDATE cursor; COMMIT;
//
// So "wrote the data but lost the offset" is not a window that has to
// be papered over with idempotency — it cannot happen. Either both land
// or neither does. Inserts additionally use ON CONFLICT DO NOTHING /
// DO UPDATE as a second line of defence.
//
// ── HOW STATE IS DERIVED ───────────────────────────────────────
//
// The log holds COMMANDS (submitted orders), not effects, so the worker
// runs its own MatchingEngine replica and re-executes them — the same
// determinism argument crash recovery relies on. Same genesis + same
// command sequence => same state, so the replica always agrees with the
// live engine for every record it has consumed.
//
// STEP 4.1 SCOPE: prove tailing, projection and decoupling. The schema
// is deliberately simple and there are no query endpoints yet — proper
// normalisation and read APIs are Step 4.2.

import fs from "node:fs";
import { pool } from "../db.js";
import { MatchingEngine, Order } from "../engine.js";
import { bootstrapFromDatabase } from "../bootstrap.js";
import { scanFrames, encodeRecord, WalRecord, DEFAULT_WAL_PATH } from "../wal.js";

const WAL_PATH = process.env.WAL_PATH ?? DEFAULT_WAL_PATH;
const POLL_MS = Number(process.env.PROJECTION_POLL_MS ?? 200);
const CURSOR_ID = 1;
// Cap how many records go into one projection transaction. Without this
// a large backlog is projected as a single unbounded transaction, which
// holds locks and memory for as long as it takes and makes the durable
// cursor pointless (it would only ever advance once, at the very end).
// Bounding it means a crash costs at most this much re-work.
const MAX_BATCH_RECORDS = Number(process.env.PROJECTION_BATCH ?? 500);

const DDL = `
CREATE SCHEMA IF NOT EXISTS readmodel;

CREATE TABLE IF NOT EXISTS readmodel.orders (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  symbol      VARCHAR(20) NOT NULL,
  side        VARCHAR(4)  NOT NULL,
  price       NUMERIC(20,8) NOT NULL,
  quantity    NUMERIC(20,8) NOT NULL,
  filled      NUMERIC(20,8) NOT NULL,
  status      VARCHAR(10) NOT NULL
);

CREATE TABLE IF NOT EXISTS readmodel.trades (
  id              INTEGER PRIMARY KEY,
  symbol          VARCHAR(20) NOT NULL,
  price           NUMERIC(20,8) NOT NULL,
  quantity        NUMERIC(20,8) NOT NULL,
  buyer_order_id  INTEGER NOT NULL,
  seller_order_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readmodel.balances (
  user_id   INTEGER NOT NULL,
  asset     VARCHAR(10) NOT NULL,
  available NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (user_id, asset)
);

-- How far into the WAL this read-model reflects. Updated in the same
-- transaction as the rows above, so the two can never disagree.
CREATE TABLE IF NOT EXISTS readmodel.cursor (
  id                INTEGER PRIMARY KEY,
  byte_offset       BIGINT NOT NULL,
  records_projected BIGINT NOT NULL,
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
`;

interface Cursor { byteOffset: number; recordsProjected: number }

async function loadCursor(): Promise<Cursor | null> {
  const r = await pool.query(
    "SELECT byte_offset::bigint AS b, records_projected::bigint AS n FROM readmodel.cursor WHERE id = $1",
    [CURSOR_ID]
  );
  if (r.rows.length === 0) return null;
  return { byteOffset: Number(r.rows[0].b), recordsProjected: Number(r.rows[0].n) };
}

/** Rows touched by one applied record — at most 2 orders, 1 trade, 4 balances. */
interface Delta {
  orders: Order[];
  trade: { id: number; symbol: string; price: number; quantity: number; buyerOrderId: number; sellerOrderId: number } | null;
  balances: Array<{ userId: number; asset: string; available: number }>;
}

function applyAndDiff(engine: MatchingEngine, index: Map<number, Order>, rec: WalRecord): Delta {
  const before = engine.getOrders().length;
  let trade: Delta["trade"] = null;
  try {
    const t = engine.processOrder(rec);
    trade = { id: t.tradeId, symbol: t.symbol, price: t.price, quantity: t.quantity,
              buyerOrderId: t.buyerOrderId, sellerOrderId: t.sellerOrderId };
  } catch {
    // Rejected — deterministic, and the engine records nothing for it.
    return { orders: [], trade: null, balances: [] };
  }

  const all = engine.getOrders();
  // Anything appended by this record, plus the resting order it matched.
  const orders: Order[] = [];
  for (let i = before; i < all.length; i++) orders.push(all[i]!);
  for (const id of [trade.buyerOrderId, trade.sellerOrderId]) {
    let o = index.get(id);
    if (!o) { o = all.find((x) => x.id === id); if (o) index.set(id, o); }
    if (o && !orders.includes(o)) orders.push(o);
  }
  for (const o of orders) index.set(o.id, o);

  const [base, quote] = rec.symbol.split("_") as [string, string];
  const buyer = index.get(trade.buyerOrderId)?.userId;
  const seller = index.get(trade.sellerOrderId)?.userId;
  const balances: Delta["balances"] = [];
  for (const uid of [buyer, seller]) {
    if (uid === undefined) continue;
    for (const asset of [base, quote]) {
      const v = engine.getBalance(uid, asset);
      if (v !== undefined) balances.push({ userId: uid, asset, available: v });
    }
  }
  return { orders, trade, balances };
}

/** Write one batch of deltas AND the cursor in a single transaction. */
async function projectBatch(deltas: Delta[], nextOffset: number, recordsProjected: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const d of deltas) {
      for (const o of d.orders) {
        await client.query(
          `INSERT INTO readmodel.orders (id,user_id,symbol,side,price,quantity,filled,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET filled = EXCLUDED.filled, status = EXCLUDED.status`,
          [o.id, o.userId, o.symbol, o.side, o.price, o.quantity, o.filled, o.status]
        );
      }
      if (d.trade) {
        await client.query(
          `INSERT INTO readmodel.trades (id,symbol,price,quantity,buyer_order_id,seller_order_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [d.trade.id, d.trade.symbol, d.trade.price, d.trade.quantity,
           d.trade.buyerOrderId, d.trade.sellerOrderId]
        );
      }
      for (const b of d.balances) {
        await client.query(
          `INSERT INTO readmodel.balances (user_id,asset,available) VALUES ($1,$2,$3)
           ON CONFLICT (user_id,asset) DO UPDATE SET available = EXCLUDED.available`,
          [b.userId, b.asset, b.available]
        );
      }
    }

    // Same transaction: the cursor can never run ahead of, or behind,
    // the rows it accounts for.
    await client.query(
      `INSERT INTO readmodel.cursor (id, byte_offset, records_projected, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE
         SET byte_offset = EXCLUDED.byte_offset,
             records_projected = EXCLUDED.records_projected,
             updated_at = NOW()`,
      [CURSOR_ID, nextOffset, recordsProjected]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Seed the read-model with the genesis world (first run only). */
async function projectGenesis(engine: MatchingEngine): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const o of engine.getOrders()) {
      await client.query(
        `INSERT INTO readmodel.orders (id,user_id,symbol,side,price,quantity,filled,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [o.id, o.userId, o.symbol, o.side, o.price, o.quantity, o.filled, o.status]
      );
    }
    const bal = await client.query("SELECT user_id, asset FROM balances");
    for (const row of bal.rows) {
      const v = engine.getBalance(Number(row.user_id), row.asset);
      if (v === undefined) continue;
      await client.query(
        `INSERT INTO readmodel.balances (user_id,asset,available) VALUES ($1,$2,$3)
         ON CONFLICT (user_id,asset) DO UPDATE SET available = EXCLUDED.available`,
        [Number(row.user_id), row.asset, v]
      );
    }
    await client.query(
      `INSERT INTO readmodel.cursor (id, byte_offset, records_projected)
       VALUES ($1,0,0) ON CONFLICT (id) DO NOTHING`,
      [CURSOR_ID]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = true;

async function main(): Promise<void> {
  await pool.query(DDL);

  // The worker keeps its OWN engine replica. It reads genesis from the
  // same seed the live engine used, then re-executes the log.
  const { engine } = await bootstrapFromDatabase();
  const index = new Map<number, Order>();
  for (const o of engine.getOrders()) index.set(o.id, o);

  let cursor = await loadCursor();
  if (cursor === null) {
    await projectGenesis(engine);
    cursor = { byteOffset: 0, recordsProjected: 0 };
    console.log(`  genesis projected: ${engine.getOrders().length} orders`);
  }

  // Catch the replica up to the cursor WITHOUT projecting: those records
  // are already in the read-model. This is what makes a restart resume
  // exactly, with no double-writes and nothing skipped.
  if (cursor.byteOffset > 0) {
    const buf = fs.existsSync(WAL_PATH) ? fs.readFileSync(WAL_PATH) : Buffer.alloc(0);
    const past = scanFrames(buf.subarray(0, cursor.byteOffset), 0);
    for (const r of past.records) { try { engine.processOrder(r); } catch { /* deterministic */ } }
    for (const o of engine.getOrders()) index.set(o.id, o);
    console.log(`  replica caught up silently over ${past.records.length} already-projected records`);
  }

  console.log(`Projection worker running`);
  console.log(`  WAL:    ${WAL_PATH}`);
  console.log(`  resume: byte ${cursor.byteOffset}, ${cursor.recordsProjected} records already projected`);
  console.log(`  poll:   ${POLL_MS}ms   target: readmodel.* (public.* is read-only genesis)`);

  let idleLogged = false;
  while (running) {
    let buf: Buffer;
    try {
      buf = fs.existsSync(WAL_PATH) ? fs.readFileSync(WAL_PATH) : Buffer.alloc(0);
    } catch {
      await sleep(POLL_MS);
      continue;
    }

    if (buf.length <= cursor.byteOffset) {
      if (!idleLogged) { idleLogged = true; }
      await sleep(POLL_MS);
      continue;
    }

    // Stop at the last COMPLETE record. A partial trailing record is a
    // write still in flight, not corruption — pick it up next poll.
    const scan = scanFrames(buf, cursor.byteOffset);
    if (scan.records.length === 0) { await sleep(POLL_MS); continue; }

    // Take at most MAX_BATCH_RECORDS this round. The cursor must land on
    // a record boundary, so recompute the offset by re-encoding the
    // frames actually consumed rather than guessing.
    let batch = scan.records;
    let batchEnd = scan.nextOffset;
    if (batch.length > MAX_BATCH_RECORDS) {
      batch = scan.records.slice(0, MAX_BATCH_RECORDS);
      batchEnd = cursor.byteOffset;
      for (const r of batch) batchEnd += encodeRecord(r, "framed").length;
    }

    if (scan.midFileCorruption) {
      console.error(`  *** WAL corruption at byte ${scan.nextOffset} (${scan.stoppedBecause}) — ` +
                    `projecting up to it and stopping ***`);
    }

    const deltas = batch.map((r) => applyAndDiff(engine, index, r));
    const projected = cursor.recordsProjected + batch.length;
    await projectBatch(deltas, batchEnd, projected);
    cursor = { byteOffset: batchEnd, recordsProjected: projected };
    idleLogged = false;

    if (scan.midFileCorruption && batchEnd === scan.nextOffset) break;
  }

  await pool.end();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { running = false; });
}

main().catch((e) => {
  console.error("projection worker failed:", e);
  process.exit(1);
});
