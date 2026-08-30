// ── Stage 3, Step 1 — crash recovery ──────────────────────────
//
// Startup sequence, before a single request is served:
//
//   1. GENESIS   — load the seeded starting state from Postgres.
//                  This is the fixed t=0 world (users, funded balances,
//                  the initial resting book) that db/init.sql and
//                  db/seed-load.sql define.
//   2. REPLAY    — re-apply every WAL record, in sequence, to that
//                  fresh engine. Because processOrder() is synchronous
//                  and deterministic, this reproduces the exact state
//                  the process had when it died.
//   3. RESUME    — reopen the log in append mode, continuing the
//                  sequence numbering.
//
// Note on the genesis split: the WAL is authoritative for everything
// that happened AFTER boot, but the starting state comes from the seed.
// That is sound only while the seed is fixed — changing db/init.sql and
// then replaying an old log would rebuild a different world. A real
// system pins this with a snapshot or by logging genesis as record 0;
// here the seed is a constant and this is called out rather than
// pretended away.
//
// Orders that were rejected when first submitted are rejected again on
// replay (same engine, same state, same input), so the counts below
// should match what the live process saw.

import { MatchingEngine } from "./engine.js";
import { bootstrapFromDatabase } from "./bootstrap.js";
import { Wal, WalRecord, DEFAULT_WAL_PATH } from "./wal.js";

export interface RecoveryResult {
  engine: MatchingEngine;
  /** Sequence number the next appended record should carry. */
  startSeq: number;
  genesisBalances: number;
  genesisOrders: number;
  recordsReplayed: number;
  appliedOnReplay: number;
  rejectedOnReplay: number;
  recoveryMs: number;
}

export async function recover(
  walPath: string = DEFAULT_WAL_PATH
): Promise<RecoveryResult> {
  // 1. Genesis
  const { engine, balanceRows, restingOrders } = await bootstrapFromDatabase();

  // 2. Replay
  const records: WalRecord[] = Wal.replay(walPath);
  const t0 = performance.now();
  let applied = 0;
  let rejected = 0;
  for (const r of records) {
    try {
      engine.processOrder(r);
      applied++;
    } catch {
      // Deterministic rejection — the same order was rejected when it
      // was originally submitted. Nothing to repair.
      rejected++;
    }
  }
  const recoveryMs = performance.now() - t0;

  // 3. Hand back the sequence to resume from. The caller opens the log
  //    for appending, choosing fsync-per-order (Wal) or batched fsync
  //    (GroupCommitWal) — recovery is identical either way, because the
  //    on-disk format is the same.
  const startSeq = records.length > 0 ? records[records.length - 1].seq + 1 : 1;

  return {
    engine,
    startSeq,
    genesisBalances: balanceRows,
    genesisOrders: restingOrders,
    recordsReplayed: records.length,
    appliedOnReplay: applied,
    rejectedOnReplay: rejected,
    recoveryMs,
  };
}
