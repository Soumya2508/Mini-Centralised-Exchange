// ═══════════════════════════════════════════════════════════════
// Stage 4 — PROJECTION WORKER
//   Step 4.1: tail the WAL, derive a Postgres read-model, decoupled
//   Step 4.2: normalised schema + BATCHED writes (fixes the lag)
// ═══════════════════════════════════════════════════════════════
//
//   npm run projector
//
// The WAL is the source of truth. Postgres is a DERIVED read-model of
// it. This worker is the only thing that writes that read-model.
//
// ── DECOUPLING IS THE POINT ────────────────────────────────────
//
// A SEPARATE PROCESS with its own entry point. The engine has zero
// dependency on it: the hot path never calls it, never awaits it, and
// does not know it exists. Nothing imports this file. Data flows one
// way only:
//
//     order -> WAL (fsync) -> engine (RAM)
//                 |
//                 +--(tail, read-only)--> worker -> readmodel.*
//                                                        |
//                                             read API (own process)
//
// The worker only READS the log. It never writes to the WAL and never
// feeds anything back into the engine. Kill it and the exchange keeps
// trading at full speed; the read-model goes stale and catches up.
//
// No Redis, no message queue. Tailing the log file directly is what
// makes Postgres a *provably* pure derived view — there is no second
// channel through which state could arrive.
//
// ── WHY THE READ-MODEL LIVES IN ITS OWN SCHEMA ─────────────────
//
// The engine bootstraps GENESIS from public.orders / public.balances.
// If the projection wrote there, the next engine restart would load a
// different genesis and replay would rebuild the wrong world — the
// derived view silently corrupting the source of truth. Everything
// projected goes to readmodel.*, which is disposable and rebuildable.
//
// ── EXACTLY-ONCE, WITHOUT IDEMPOTENCY GYMNASTICS ───────────────
//
//     BEGIN; insert orders; insert trades; upsert balances;
//            UPDATE cursor; COMMIT;
//
// The cursor moves in the SAME transaction as the rows it accounts
// for, so "wrote the data but lost the offset" is not a window that
// has to be papered over — it cannot happen.
//
// ── STEP 4.2: WHY WRITES ARE BATCHED ───────────────────────────
//
// Step 4.1 measured 545 records/sec against an engine doing ~2100
// ord/s, so the read-model fell behind indefinitely under sustained
// load. The cause was a per-row loop: up to seven individual
// INSERT ... ON CONFLICT round-trips per record, each a full
// client/server exchange inside the transaction.
//
// Two changes fix it:
//   1. DEDUPE within the batch. A resting order hit by 40 takers in
//      one batch produced 40 UPDATEs of the same row; now it produces
//      one, carrying the final state. Same for balances. This is only
//      valid because the read-model stores current state, not a
//      history of mutations.
//   2. ONE statement per table via UNNEST(array, array, ...), so the
//      parameter count is fixed at the number of COLUMNS rather than
//      growing with the number of rows.
//
// Dedupe is also required for correctness, not just speed: Postgres
// rejects an ON CONFLICT DO UPDATE that touches the same row twice in
// one statement ("cannot affect row a second time").

import fs from "node:fs";
import { pool } from "../db.js";
import { MatchingEngine, Order } from "../engine.js";
import { bootstrapFromDatabase } from "../bootstrap.js";
import { scanFrames, encodeRecord, WalRecord, DEFAULT_WAL_PATH } from "../wal.js";
import { DDL, SCHEMA_VERSION } from "./schema.js";

const WAL_PATH = process.env.WAL_PATH ?? DEFAULT_WAL_PATH;
const POLL_MS = Number(process.env.PROJECTION_POLL_MS ?? 100);
const CURSOR_ID = 1;
// Bounds one projection transaction. Without a cap a large backlog
// becomes a single unbounded transaction and the durable cursor is
// pointless — it would advance only once, at the very end.
const MAX_BATCH_RECORDS = Number(process.env.PROJECTION_BATCH ?? 2000);

interface Cursor { byteOffset: number; recordsProjected: number }

/** Rows a batch will write. Keyed maps give last-write-wins dedupe. */
interface Pending {
  orders: Map<number, Order & { walSeq: number; ts: number }>;
  trades: Array<{
    id: number; symbol: string; price: number; quantity: number;
    buyerOrderId: number; sellerOrderId: number;
    buyerUserId: number; sellerUserId: number; walSeq: number; ts: number;
  }>;
  balances: Map<string, { userId: number; asset: string; available: number }>;
}

const emptyPending = (): Pending => ({ orders: new Map(), trades: [], balances: new Map() });

async function ensureSchema(): Promise<void> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS readmodel");
  const v = await pool.query(
    "SELECT version FROM readmodel.meta WHERE id = 1"
  ).catch(() => ({ rows: [] as Array<{ version: number }> }));

  const current = v.rows[0]?.version;
  if (current !== undefined && current !== SCHEMA_VERSION) {
    // The read-model is derived and disposable, so a schema change needs
    // no migration: drop it and re-project from the log.
    console.log(`  read-model schema v${current} != v${SCHEMA_VERSION} — dropping and rebuilding from the log`);
    await pool.query("DROP SCHEMA readmodel CASCADE");
  }
  await pool.query(DDL);
  await pool.query(
    "INSERT INTO readmodel.meta (id, version) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version",
    [SCHEMA_VERSION]
  );
}

async function loadCursor(): Promise<Cursor | null> {
  const r = await pool.query(
    "SELECT byte_offset::bigint AS b, records_projected::bigint AS n FROM readmodel.cursor WHERE id=$1",
    [CURSOR_ID]
  );
  if (r.rows.length === 0) return null;
  return { byteOffset: Number(r.rows[0].b), recordsProjected: Number(r.rows[0].n) };
}

/** Apply one record to the replica and accumulate the rows it touched. */
function applyInto(
  engine: MatchingEngine, index: Map<number, Order>, rec: WalRecord, out: Pending
): void {
  const before = engine.getOrders().length;
  let t;
  try {
    t = engine.processOrder(rec);
  } catch {
    return; // deterministic rejection; the engine records nothing
  }

  const all = engine.getOrders();
  const touched: Order[] = [];
  for (let i = before; i < all.length; i++) touched.push(all[i]!);
  for (const id of [t.buyerOrderId, t.sellerOrderId]) {
    let o = index.get(id);
    if (!o) { o = all.find((x) => x.id === id); if (o) index.set(id, o); }
    if (o && !touched.includes(o)) touched.push(o);
  }
  // Last write wins: a resting order hit many times in one batch is
  // written once, with its final filled/status.
  for (const o of touched) {
    index.set(o.id, o);
    out.orders.set(o.id, { ...o, walSeq: rec.seq, ts: rec.ts });
  }

  const buyerUserId = index.get(t.buyerOrderId)?.userId;
  const sellerUserId = index.get(t.sellerOrderId)?.userId;
  if (buyerUserId === undefined || sellerUserId === undefined) return;

  out.trades.push({
    id: t.tradeId, symbol: t.symbol, price: t.price, quantity: t.quantity,
    buyerOrderId: t.buyerOrderId, sellerOrderId: t.sellerOrderId,
    buyerUserId, sellerUserId, walSeq: rec.seq, ts: rec.ts,
  });

  const [base, quote] = rec.symbol.split("_") as [string, string];
  for (const uid of [buyerUserId, sellerUserId]) {
    for (const asset of [base, quote]) {
      const v = engine.getBalance(uid, asset);
      if (v !== undefined) out.balances.set(`${uid}:${asset}`, { userId: uid, asset, available: v });
    }
  }
}

/** One transaction: 3 statements for the data, 1 for the cursor. */
async function writeBatch(p: Pending, nextOffset: number, recordsProjected: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orders = [...p.orders.values()];
    if (orders.length > 0) {
      await client.query(
        `INSERT INTO readmodel.orders (id,user_id,symbol,side,price,quantity,filled,status,wal_seq,created_at)
         SELECT * FROM UNNEST(
           $1::int[], $2::int[], $3::varchar[], $4::varchar[], $5::numeric[],
           $6::numeric[], $7::numeric[], $8::varchar[], $9::bigint[], $10::timestamp[])
         ON CONFLICT (id) DO UPDATE SET filled = EXCLUDED.filled, status = EXCLUDED.status`,
        [
          orders.map((o) => o.id), orders.map((o) => o.userId), orders.map((o) => o.symbol),
          orders.map((o) => o.side), orders.map((o) => o.price), orders.map((o) => o.quantity),
          orders.map((o) => o.filled), orders.map((o) => o.status), orders.map((o) => o.walSeq),
          orders.map((o) => new Date(o.ts)),
        ]
      );
    }

    if (p.trades.length > 0) {
      await client.query(
        `INSERT INTO readmodel.trades (id,symbol,price,quantity,buyer_order_id,seller_order_id,
                                       buyer_user_id,seller_user_id,wal_seq,executed_at)
         SELECT * FROM UNNEST(
           $1::int[], $2::varchar[], $3::numeric[], $4::numeric[], $5::int[],
           $6::int[], $7::int[], $8::int[], $9::bigint[], $10::timestamp[])
         ON CONFLICT (id) DO NOTHING`,
        [
          p.trades.map((t) => t.id), p.trades.map((t) => t.symbol), p.trades.map((t) => t.price),
          p.trades.map((t) => t.quantity), p.trades.map((t) => t.buyerOrderId),
          p.trades.map((t) => t.sellerOrderId), p.trades.map((t) => t.buyerUserId),
          p.trades.map((t) => t.sellerUserId), p.trades.map((t) => t.walSeq),
          p.trades.map((t) => new Date(t.ts)),
        ]
      );
    }

    const bals = [...p.balances.values()];
    if (bals.length > 0) {
      await client.query(
        `INSERT INTO readmodel.balances (user_id,asset,available)
         SELECT * FROM UNNEST($1::int[], $2::varchar[], $3::numeric[])
         ON CONFLICT (user_id,asset) DO UPDATE SET available = EXCLUDED.available`,
        [bals.map((b) => b.userId), bals.map((b) => b.asset), bals.map((b) => b.available)]
      );
    }

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
    const users = await client.query("SELECT id, username FROM users ORDER BY id");
    await client.query(
      `INSERT INTO readmodel.users (id, username)
       SELECT * FROM UNNEST($1::int[], $2::varchar[]) ON CONFLICT (id) DO NOTHING`,
      [users.rows.map((u) => Number(u.id)), users.rows.map((u) => u.username)]
    );

    const os = engine.getOrders();
    if (os.length > 0) {
      await client.query(
        `INSERT INTO readmodel.orders (id,user_id,symbol,side,price,quantity,filled,status,wal_seq,created_at)
         SELECT * FROM UNNEST($1::int[], $2::int[], $3::varchar[], $4::varchar[], $5::numeric[],
                              $6::numeric[], $7::numeric[], $8::varchar[], $9::bigint[], $10::timestamp[])
         ON CONFLICT (id) DO NOTHING`,
        [os.map((o) => o.id), os.map((o) => o.userId), os.map((o) => o.symbol), os.map((o) => o.side),
         os.map((o) => o.price), os.map((o) => o.quantity), os.map((o) => o.filled), os.map((o) => o.status),
         os.map(() => 0), os.map(() => new Date(0))]
      );
    }

    const bal = await client.query("SELECT user_id, asset FROM balances");
    const rows = bal.rows
      .map((r) => ({ uid: Number(r.user_id), asset: r.asset as string, v: engine.getBalance(Number(r.user_id), r.asset) }))
      .filter((r) => r.v !== undefined);
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO readmodel.balances (user_id,asset,available)
         SELECT * FROM UNNEST($1::int[], $2::varchar[], $3::numeric[])
         ON CONFLICT (user_id,asset) DO UPDATE SET available = EXCLUDED.available`,
        [rows.map((r) => r.uid), rows.map((r) => r.asset), rows.map((r) => r.v as number)]
      );
    }

    await client.query(
      `INSERT INTO readmodel.cursor (id, byte_offset, records_projected) VALUES ($1,0,0)
       ON CONFLICT (id) DO NOTHING`, [CURSOR_ID]
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
  await ensureSchema();

  const { engine } = await bootstrapFromDatabase();
  const index = new Map<number, Order>();
  for (const o of engine.getOrders()) index.set(o.id, o);

  let cursor = await loadCursor();
  if (cursor === null) {
    await projectGenesis(engine);
    cursor = { byteOffset: 0, recordsProjected: 0 };
    console.log(`  genesis projected: ${engine.getOrders().length} orders`);
  }

  // Catch the replica up to the cursor WITHOUT projecting — those
  // records are already in the read-model. This is what makes a restart
  // resume exactly: no double-writes, nothing skipped.
  if (cursor.byteOffset > 0) {
    const buf = fs.existsSync(WAL_PATH) ? fs.readFileSync(WAL_PATH) : Buffer.alloc(0);
    const past = scanFrames(buf.subarray(0, cursor.byteOffset), 0);
    for (const r of past.records) { try { engine.processOrder(r); } catch { /* deterministic */ } }
    for (const o of engine.getOrders()) index.set(o.id, o);
    console.log(`  replica caught up silently over ${past.records.length} already-projected records`);
  }

  console.log(`Projection worker running (schema v${SCHEMA_VERSION}, batched)`);
  console.log(`  WAL:    ${WAL_PATH}`);
  console.log(`  resume: byte ${cursor.byteOffset}, ${cursor.recordsProjected} records already projected`);
  console.log(`  batch:  up to ${MAX_BATCH_RECORDS} records/txn   poll: ${POLL_MS}ms`);
  console.log(`  target: readmodel.*  (public.* is read-only genesis)`);

  while (running) {
    let buf: Buffer;
    try {
      buf = fs.existsSync(WAL_PATH) ? fs.readFileSync(WAL_PATH) : Buffer.alloc(0);
    } catch { await sleep(POLL_MS); continue; }

    if (buf.length <= cursor.byteOffset) { await sleep(POLL_MS); continue; }

    // Stop at the last COMPLETE record; a partial tail is a write still
    // in flight, not corruption — pick it up next poll.
    const scan = scanFrames(buf, cursor.byteOffset);
    if (scan.records.length === 0) { await sleep(POLL_MS); continue; }

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

    const pending = emptyPending();
    for (const r of batch) applyInto(engine, index, r, pending);
    // Explicit annotation breaks a circular inference: `cursor` is later
    // reassigned from an object containing this value.
    const projected: number = cursor.recordsProjected + batch.length;
    await writeBatch(pending, batchEnd, projected);
    cursor = { byteOffset: batchEnd, recordsProjected: projected };

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
