// ═══════════════════════════════════════════════════════════════
// Stage 3, Step 1 — MINIMAL WRITE-AHEAD LOG
// ═══════════════════════════════════════════════════════════════
//
// Stage 2 deleted durability to escape the Stage 1 lock-contention
// wall. This rebuilds it by another route: instead of a transactional
// database round-trip per order, a sequential append to a log file.
//
// ── THE RULE: append-before-execute ────────────────────────────
//
// The record is written AND fsync'd to disk BEFORE the order touches
// the in-memory engine. If the process dies at any point, either:
//   - the record is on disk  -> replay re-applies it, or
//   - it is not              -> the order never affected memory either.
// There is no window where memory has advanced past the log. The log
// is the source of truth; memory is a projection of it.
//
// ── WHAT IS LOGGED: commands, not effects ──────────────────────
//
// Each line is the SUBMITTED ORDER, not the balance deltas it produced
// (logical/command logging, not physical logging). Recovery is a
// deterministic re-execution of every command against a fresh engine.
//
// This is only sound because engine.processOrder() is synchronous and
// deterministic: no clock, no randomness, no I/O, no concurrency. Same
// genesis state + same command sequence => same final state, always.
//
//   Advantage: records are tiny and the log is trivially readable.
//   Cost:      recovery is O(orders), not O(state), and the engine's
//              matching logic may never change in a way that alters
//              replay of old records without a log version bump.
//
// Orders that the engine REJECTS are logged too. Replay re-applies them
// and they are rejected identically, so the log stays a faithful record
// of what was submitted. Malformed HTTP requests are rejected before
// logging and never enter the log.
//
// ── FORMAT: JSON lines ─────────────────────────────────────────
//
// One JSON object per line, human-readable on purpose so the log can be
// inspected with `cat` while the mechanism is being established.
//
// ⚠️  KNOWN GAP (Step 3 fixes this): there is NO torn-write protection.
// A crash midway through a write can leave a truncated final line, and
// replay will fail to parse it. JSON lines cannot self-verify. Step 3
// replaces this with a length-prefixed binary format plus CRC32 so a
// partial trailing record is detected and discarded rather than
// corrupting recovery. Do not paper over that here — the failure is
// what licenses the change.
//
// ⚠️  Step 1 fsyncs EVERY order individually. That is the naive,
// deliberately unoptimised baseline; its measured cost is what licenses
// group commit in Step 2.
//
// ── Storage location ───────────────────────────────────────────
//
// The brief asked for a Docker volume. This app is a HOST process, not
// a container (only Postgres is containerised), so a Docker volume does
// not apply to it. The log is written to a host file instead, which
// provides the same property that mattered: it survives process kill,
// container restart and reboot. Path is overridable via WAL_PATH.

import fs from "node:fs";
import path from "node:path";

export interface WalRecord {
  seq: number;
  ts: number;
  userId: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
}

export const DEFAULT_WAL_PATH =
  process.env.WAL_PATH ?? path.join(process.cwd(), "data", "wal.log");

export class Wal {
  private fd: number;
  private nextSeq: number;
  public appendCount = 0;
  public fsyncCount = 0;

  constructor(private filePath: string = DEFAULT_WAL_PATH, startSeq = 1) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 'a' = append mode; every write goes to the current end of file.
    this.fd = fs.openSync(filePath, "a");
    this.nextSeq = startSeq;
  }

  /**
   * Append one order and force it to disk. SYNCHRONOUS on purpose:
   * the caller must not be able to interleave another order between
   * the append and the engine apply, or the write-ahead ordering
   * guarantee is lost.
   */
  append(o: {
    userId: number;
    symbol: string;
    side: "buy" | "sell";
    price: number;
    quantity: number;
  }): WalRecord {
    const rec: WalRecord = {
      seq: this.nextSeq++,
      ts: Date.now(),
      userId: o.userId,
      symbol: o.symbol,
      side: o.side,
      price: o.price,
      quantity: o.quantity,
    };
    fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    this.appendCount++;
    // fsync: without this the bytes sit in the OS page cache and a
    // power loss loses them even though write() returned successfully.
    // write() makes data visible to other processes; fsync makes it
    // survive the machine dying. Durability requires the second.
    fs.fsyncSync(this.fd);
    this.fsyncCount++;
    return rec;
  }

  close(): void {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }

  get sequence(): number { return this.nextSeq; }

  /**
   * Read every record from the log, oldest first.
   *
   * Parsing is STRICT. A truncated trailing line throws rather than
   * being silently skipped — see the torn-write note above. Step 3
   * makes partial records detectable; until then, failing loudly is
   * more honest than guessing which bytes are trustworthy.
   */
  static replay(filePath: string = DEFAULT_WAL_PATH): WalRecord[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.length === 0) return [];

    const lines = raw.split("\n").filter((l) => l.length > 0);
    const out: WalRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        out.push(JSON.parse(lines[i]) as WalRecord);
      } catch {
        const isLast = i === lines.length - 1;
        throw new Error(
          `WAL parse failure at line ${i + 1}/${lines.length}` +
            (isLast
              ? " (final line) — looks like a TORN WRITE. Step 1 has no torn-write protection by design; Step 3's length-prefixed + CRC32 format is what fixes this."
              : " (mid-file) — the log is corrupt, not merely truncated.")
        );
      }
    }
    return out;
  }

  static sizeBytes(filePath: string = DEFAULT_WAL_PATH): number {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }
}

// ═══════════════════════════════════════════════════════════════
// Stage 3, Step 2 — GROUP COMMIT
// ═══════════════════════════════════════════════════════════════
//
// Step 1 measured a hard ceiling: ~800 fsync/s, flat from 5 to 50
// concurrent clients while latency scaled linearly. That is the disk's
// serialised synchronous-write rate. One fsync per order cannot beat
// it, no matter how many clients push.
//
// Group commit breaks the ceiling by amortising: many orders share one
// fsync. Throughput stops being (fsync rate) and becomes
// (fsync rate x batch size).
//
// ── Ordering of operations (this is the whole correctness story) ──
//
//   1. write()  the record to the file   <- ordered, NOT yet durable
//   2. apply    the order to the engine
//   3. fsync    once per batch           <- the durability point
//   4. ACK      the client
//
// This is the model Postgres uses: a backend does its work and writes
// WAL records, then blocks at COMMIT until the WAL is flushed; several
// backends waiting on the same flush is exactly group commit.
//
// Why it is still append-before-execute: the record is written to the
// log BEFORE the order touches memory (step 1 precedes step 2), so this
// is never apply-then-log. And nothing is ever ACKNOWLEDGED before its
// fsync (step 3 precedes step 4).
//
// Why "applied but not yet fsynced" is safe: that state exists only in
// RAM. If the process dies there, memory dies with it, and recovery
// replays a log that simply lacks the order — as if it never arrived.
// The client was never told otherwise, because the ack had not been
// sent. There is no acknowledged-but-lost window.
//
// Why there can be no HOLE in the log: writes append in call order and
// a batch fsync durably commits a PREFIX of the file. If order Y is
// durable then every order written before it is durable too, so replay
// can never see Y without X.
//
// ── The tradeoff being made ────────────────────────────────────
//
// Latency is traded for throughput. An order that arrives just after a
// flush waits up to maxDelayMs before its batch goes out. That wait is
// the cost; the payoff is that the fsync is shared. Under load the wait
// is usually far shorter than maxDelayMs because the size threshold
// fires first.
//
// FORMAT IS UNCHANGED from Step 1 — still JSON lines, still no
// self-verification. Torn-write protection is Step 3.

export interface GroupCommitOptions {
  /** Flush once this many records are buffered. */
  maxBatch?: number;
  /** Flush at most this long after the first record in a batch.
   *  0 means "flush at the end of the current event-loop turn". */
  maxDelayMs?: number;
}

export class GroupCommitWal {
  private fd: number;
  private nextSeq: number;
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;

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
    this.maxBatch = opts.maxBatch ?? 64;
    this.maxDelayMs = opts.maxDelayMs ?? 2;
  }

  /**
   * Write the record to the log (ordered, not yet durable) and return a
   * promise that resolves once it has been fsynced. The caller applies
   * the order to the engine immediately, but must await `durable`
   * before acknowledging anything to the client.
   */
  appendAndAwaitDurable(o: {
    userId: number;
    symbol: string;
    side: "buy" | "sell";
    price: number;
    quantity: number;
  }): { record: WalRecord; durable: Promise<void> } {
    const record: WalRecord = {
      seq: this.nextSeq++,
      ts: Date.now(),
      userId: o.userId,
      symbol: o.symbol,
      side: o.side,
      price: o.price,
      quantity: o.quantity,
    };

    // Step 1 — ordered write. Reaches the OS page cache, not the platter.
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    this.appendCount++;

    const durable = new Promise<void>((resolve) => this.waiters.push(resolve));

    if (this.waiters.length >= this.maxBatch) {
      this.flush(); // size threshold
    } else if (!this.timer && !this.immediate) {
      // time threshold — armed by the FIRST record of a batch
      if (this.maxDelayMs === 0) {
        this.immediate = setImmediate(() => this.flush());
      } else {
        this.timer = setTimeout(() => this.flush(), this.maxDelayMs);
      }
    }

    return { record, durable };
  }

  /** fsync once, then release everyone waiting on that flush. */
  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.immediate) { clearImmediate(this.immediate); this.immediate = null; }
    if (this.waiters.length === 0) return;

    // Capture before the fsync. Nothing can be added during it: fsyncSync
    // is blocking and this process is single-threaded.
    const releasing = this.waiters;
    this.waiters = [];

    fs.fsyncSync(this.fd); // <- THE durability point for this whole batch
    this.fsyncCount++;
    this.batchSizes.push(releasing.length);

    for (const resolve of releasing) resolve();
  }

  /** Flush anything outstanding (used on graceful shutdown / tests). */
  flushNow(): void { this.flush(); }

  close(): void {
    this.flush();
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }

  get sequence(): number { return this.nextSeq; }

  get averageBatchSize(): number {
    if (this.batchSizes.length === 0) return 0;
    return this.batchSizes.reduce((a, b) => a + b, 0) / this.batchSizes.length;
  }
}
