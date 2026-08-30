// ═══════════════════════════════════════════════════════════════
// Stage 3 — WRITE-AHEAD LOG
//   Step 1: append-before-execute + fsync + crash recovery
//   Step 2: group commit (batched fsync)
//   Step 3: torn-write protection (length prefix + CRC32)
// ═══════════════════════════════════════════════════════════════
//
// Stage 2 deleted durability to escape the Stage 1 lock-contention
// wall. This rebuilds it by another route: instead of a transactional
// database round-trip per order, a sequential append to a log file.
//
// ── THE RULE: append-before-execute ────────────────────────────
//
// The record is written to the log BEFORE the order touches the
// in-memory engine, and fsync'd BEFORE anything is acknowledged to the
// client. If the process dies at any point, either:
//   - the record is on disk  -> replay re-applies it, or
//   - it is not              -> the order was never acknowledged, and
//                               memory died with the process anyway.
// Memory can never be ahead of the log. The log is the source of
// truth; memory is a projection of it.
//
// ── WHAT IS LOGGED: commands, not effects ──────────────────────
//
// Each record is the SUBMITTED ORDER, not the balance deltas it
// produced (logical/command logging, not physical logging). Recovery is
// deterministic re-execution of every command against a fresh engine.
//
// Sound only because engine.processOrder() is synchronous and
// deterministic: no clock, no randomness, no I/O, no concurrency.
// Same genesis + same command sequence => same final state, always.
//
//   Advantage: records are tiny; the payload is still readable JSON.
//   Cost:      recovery is O(orders), not O(state), and the matching
//              logic may never change in a way that alters replay of
//              old records without a log version bump.
//
// Orders the engine REJECTS are logged too. Replay re-applies them and
// they are rejected identically, so the log stays a faithful record of
// what was submitted. Malformed HTTP requests are rejected before
// logging and never enter the log.
//
// ── STEP 3: RECORD FRAMING ─────────────────────────────────────
//
//   [4-byte length BE] [JSON payload bytes] [4-byte CRC32 BE]
//
// Step 1 used bare JSON lines, which cannot self-verify. A crash
// midway through a write left a truncated final line, and recovery
// died on it — REPRODUCED before this fix: three valid records were
// unrecoverable because of one torn tail, and the process refused to
// start at all. A single interrupted write meant total data loss.
//
// The frame fixes that with two independent checks:
//   - the LENGTH tells the reader exactly how many bytes to expect, so
//     a short tail is detected without parsing anything;
//   - the CRC32 detects a record that is the right LENGTH but whose
//     bytes are damaged — length alone cannot catch that.
//
// The payload stays JSON so the log remains debuggable; only the frame
// around it is binary.
//
// Discarding a torn TRAILING record is correct, not a compromise: it
// can only be a record whose fsync never completed, which means it was
// never acknowledged to any client. Nobody was told it succeeded.
//
// A checksum failure that is NOT at the tail is different — that is
// real corruption, not an interrupted write — so replay reports it
// distinctly rather than pretending the log is merely short.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface WalRecord {
  seq: number;
  ts: number;
  userId: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
}

/** "framed" = Step 3 (length + CRC32). "jsonl" = Step 1/2, kept so both
 *  can be measured back-to-back in ONE session; cross-session throughput
 *  on this host drifts (see DEVLOG). Not a deployment option. */
export type WalFormat = "framed" | "jsonl";

export const DEFAULT_WAL_PATH =
  process.env.WAL_PATH ?? path.join(process.cwd(), "data", "wal.log");

const LEN_BYTES = 4;
const CRC_BYTES = 4;
/** Sanity cap: a length field larger than this is garbage, not a record. */
const MAX_RECORD_BYTES = 1 << 20;

// zlib.crc32 exists on Node >= 22.2 / 20.15. Fall back to a table so the
// log format does not depend on the runtime version.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Fallback(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const nativeCrc32 = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
export const crc32 = (buf: Buffer): number =>
  nativeCrc32 ? nativeCrc32(buf) >>> 0 : crc32Fallback(buf);

/** Serialise one record in the configured format. */
export function encodeRecord(rec: WalRecord, format: WalFormat): Buffer {
  const payload = Buffer.from(JSON.stringify(rec), "utf8");
  if (format === "jsonl") return Buffer.concat([payload, Buffer.from("\n", "utf8")]);

  const frame = Buffer.allocUnsafe(LEN_BYTES + payload.length + CRC_BYTES);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, LEN_BYTES);
  frame.writeUInt32BE(crc32(payload), LEN_BYTES + payload.length);
  return frame;
}

export interface ReplayResult {
  records: WalRecord[];
  /** Trailing bytes that could not be trusted and were discarded. */
  discardedBytes: number;
  /** Why the read stopped early, if it did. */
  stoppedBecause: null | "short-length" | "short-payload" | "bad-length" | "crc-mismatch" | "bad-json";
  /** True when the damage was NOT at the end of the file — real corruption. */
  midFileCorruption: boolean;
  format: WalFormat;
}

function replayFramed(buf: Buffer): ReplayResult {
  const records: WalRecord[] = [];
  let off = 0;
  let stoppedBecause: ReplayResult["stoppedBecause"] = null;

  while (off < buf.length) {
    // Not even a complete length field left -> the write was cut short.
    if (buf.length - off < LEN_BYTES) { stoppedBecause = "short-length"; break; }

    const len = buf.readUInt32BE(off);
    if (len === 0 || len > MAX_RECORD_BYTES) { stoppedBecause = "bad-length"; break; }

    // The frame needs len payload bytes plus a CRC. If the file ends
    // before that, the record was never fully written.
    if (buf.length - off - LEN_BYTES < len + CRC_BYTES) { stoppedBecause = "short-payload"; break; }

    const payload = buf.subarray(off + LEN_BYTES, off + LEN_BYTES + len);
    const stored = buf.readUInt32BE(off + LEN_BYTES + len);
    if (crc32(payload) !== stored) { stoppedBecause = "crc-mismatch"; break; }

    try {
      records.push(JSON.parse(payload.toString("utf8")) as WalRecord);
    } catch {
      // CRC passed but the bytes are not valid JSON — should be
      // impossible; surface it rather than silently dropping data.
      stoppedBecause = "bad-json";
      break;
    }
    off += LEN_BYTES + len + CRC_BYTES;
  }

  const discardedBytes = buf.length - off;
  // A torn TAIL is a partial record at EOF. Anything that leaves a lot
  // of unread bytes behind is corruption in the middle of the log.
  const midFileCorruption =
    stoppedBecause === "crc-mismatch" || stoppedBecause === "bad-length" ||
    stoppedBecause === "bad-json";

  return { records, discardedBytes, stoppedBecause, midFileCorruption, format: "framed" };
}

function replayJsonl(raw: string): ReplayResult {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const records: WalRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as WalRecord);
    } catch {
      const isLast = i === lines.length - 1;
      throw new Error(
        `WAL parse failure at line ${i + 1}/${lines.length}` +
          (isLast
            ? " (final line) — TORN WRITE. The jsonl format cannot self-verify; use the framed format."
            : " (mid-file) — the log is corrupt, not merely truncated.")
      );
    }
  }
  return { records, discardedBytes: 0, stoppedBecause: null, midFileCorruption: false, format: "jsonl" };
}

// ── Shared read path ──────────────────────────────────────────

export function replayDetailed(filePath: string = DEFAULT_WAL_PATH): ReplayResult {
  const empty: ReplayResult = {
    records: [], discardedBytes: 0, stoppedBecause: null,
    midFileCorruption: false, format: "framed",
  };
  if (!fs.existsSync(filePath)) return empty;
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) return empty;

  // Auto-detect: a legacy jsonl log starts with '{'. A framed log starts
  // with a big-endian length, whose first byte is 0 for any sane record.
  if (buf[0] === 0x7b /* '{' */) return replayJsonl(buf.toString("utf8"));
  return replayFramed(buf);
}

// ── Step 1: one fsync per order ───────────────────────────────

export class Wal {
  private fd: number;
  private nextSeq: number;
  public appendCount = 0;
  public fsyncCount = 0;

  constructor(
    private filePath: string = DEFAULT_WAL_PATH,
    startSeq = 1,
    private format: WalFormat = "framed"
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "a");
    this.nextSeq = startSeq;
  }

  /**
   * Append one order and force it to disk. SYNCHRONOUS on purpose: the
   * caller must not be able to interleave another order between the
   * append and the engine apply, or write-ahead ordering is lost.
   */
  append(o: { userId: number; symbol: string; side: "buy" | "sell"; price: number; quantity: number }): WalRecord {
    const rec: WalRecord = { seq: this.nextSeq++, ts: Date.now(), ...o };
    fs.writeSync(this.fd, encodeRecord(rec, this.format));
    this.appendCount++;
    // write() makes the bytes visible to other processes; fsync makes
    // them survive the machine dying. Durability needs the second.
    fs.fsyncSync(this.fd);
    this.fsyncCount++;
    return rec;
  }

  close(): void { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
  get sequence(): number { return this.nextSeq; }

  static replay(filePath: string = DEFAULT_WAL_PATH): WalRecord[] {
    return replayDetailed(filePath).records;
  }

  static sizeBytes(filePath: string = DEFAULT_WAL_PATH): number {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }
}

// ── Step 2: group commit ──────────────────────────────────────
//
// Step 1 measured a hard ceiling of ~1000 fsync/s, flat across
// concurrency — the disk's serialised synchronous-write rate. One fsync
// per order cannot beat it; sharing an fsync can. Throughput stops
// being (fsync rate) and becomes (fsync rate x batch size).
//
// Ordering of operations — the whole correctness story:
//   1. write()  the record            <- ordered, NOT yet durable
//   2. apply    the order to memory
//   3. fsync    once per batch        <- the durability point
//   4. ACK      the client
//
// Step 1 precedes step 2, so this is never apply-then-log. Step 3
// precedes step 4, so nothing is ever acknowledged before it is on
// disk. This is the model Postgres uses: backends do their work, write
// WAL records, then block at COMMIT until the WAL is flushed; several
// backends waiting on one flush is exactly group commit.
//
// "Applied but not yet fsynced" is safe because that state exists only
// in RAM: if the process dies there, memory dies with it and recovery
// replays a log that simply lacks the order. The client was never told
// otherwise. There is no acknowledged-but-lost window.
//
// There can be no HOLE in the log: writes append in call order and a
// batch fsync durably commits a PREFIX of the file, so if order Y is
// durable then everything written before it is durable too.

export interface GroupCommitOptions {
  maxBatch?: number;
  /** 0 means "flush at the end of the current event-loop turn". */
  maxDelayMs?: number;
  format?: WalFormat;
}

export class GroupCommitWal {
  private fd: number;
  private nextSeq: number;
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private format: WalFormat;

  public appendCount = 0;
  public fsyncCount = 0;
  public batchSizes: number[] = [];

  readonly maxBatch: number;
  readonly maxDelayMs: number;

  constructor(
    private filePath: string = DEFAULT_WAL_PATH,
    startSeq = 1,
    opts: GroupCommitOptions = {}
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "a");
    this.nextSeq = startSeq;
    this.maxBatch = opts.maxBatch ?? 32;
    this.maxDelayMs = opts.maxDelayMs ?? 0;
    this.format = opts.format ?? "framed";
  }

  /**
   * Write the record (ordered, not yet durable) and return a promise
   * that resolves once it has been fsync'd. The caller applies the order
   * immediately but must await `durable` before acknowledging anything.
   */
  appendAndAwaitDurable(o: {
    userId: number; symbol: string; side: "buy" | "sell"; price: number; quantity: number;
  }): { record: WalRecord; durable: Promise<void> } {
    const record: WalRecord = { seq: this.nextSeq++, ts: Date.now(), ...o };

    fs.writeSync(this.fd, encodeRecord(record, this.format));
    this.appendCount++;

    const durable = new Promise<void>((resolve) => this.waiters.push(resolve));

    if (this.waiters.length >= this.maxBatch) {
      this.flush();                                   // size threshold
    } else if (!this.timer && !this.immediate) {
      // Time threshold, armed by the FIRST record of a batch.
      // NOTE: on Windows the default timer resolution is ~15.6ms, so
      // setTimeout(1) does NOT fire in 1ms. setImmediate (maxDelayMs 0)
      // measured 8.8x better at 1 VU. See DEVLOG.
      if (this.maxDelayMs === 0) this.immediate = setImmediate(() => this.flush());
      else this.timer = setTimeout(() => this.flush(), this.maxDelayMs);
    }

    return { record, durable };
  }

  /** fsync once, then release everyone waiting on that flush. */
  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.immediate) { clearImmediate(this.immediate); this.immediate = null; }
    if (this.waiters.length === 0) return;

    // Capture before the fsync. Nothing can be added during it:
    // fsyncSync blocks and this process is single-threaded.
    const releasing = this.waiters;
    this.waiters = [];

    fs.fsyncSync(this.fd);   // <- THE durability point for this batch
    this.fsyncCount++;
    this.batchSizes.push(releasing.length);

    for (const resolve of releasing) resolve();
  }

  flushNow(): void { this.flush(); }
  close(): void { this.flush(); try { fs.closeSync(this.fd); } catch { /* already closed */ } }
  get sequence(): number { return this.nextSeq; }
  get averageBatchSize(): number {
    if (this.batchSizes.length === 0) return 0;
    return this.batchSizes.reduce((a, b) => a + b, 0) / this.batchSizes.length;
  }
}
