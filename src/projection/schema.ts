// ── Stage 4.2 — normalised read-model schema (readmodel.*) ────
//
// This schema is a DERIVED VIEW of the WAL. It is disposable: drop it
// and the projection worker rebuilds it from the log. Nothing here ever
// feeds the engine — the engine reads its genesis from public.*, which
// this schema never writes to.
//
// Because it is rebuildable, a schema change does not need a migration:
// bump SCHEMA_VERSION and the worker drops and re-projects. That is one
// of the real payoffs of CQRS, and it is why the version check below is
// a feature rather than a shortcut.

export const SCHEMA_VERSION = 2;

export const DDL = `
CREATE SCHEMA IF NOT EXISTS readmodel;

CREATE TABLE IF NOT EXISTS readmodel.meta (
  id      INTEGER PRIMARY KEY,
  version INTEGER NOT NULL
);

-- Users, projected from genesis. Exists so the rest of the read-model
-- can carry real foreign keys instead of bare integers.
CREATE TABLE IF NOT EXISTS readmodel.users (
  id       INTEGER PRIMARY KEY,
  username VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS readmodel.orders (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES readmodel.users(id),
  symbol     VARCHAR(20) NOT NULL,
  side       VARCHAR(4)  NOT NULL CHECK (side IN ('buy','sell')),
  price      NUMERIC(20,8) NOT NULL,
  quantity   NUMERIC(20,8) NOT NULL,
  filled     NUMERIC(20,8) NOT NULL,
  status     VARCHAR(10) NOT NULL CHECK (status IN ('open','partial','filled')),
  -- Provenance: the WAL record this row came from. Makes any row in the
  -- read-model traceable back to the source of truth.
  wal_seq    BIGINT,
  created_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS readmodel.trades (
  id              INTEGER PRIMARY KEY,
  symbol          VARCHAR(20) NOT NULL,
  price           NUMERIC(20,8) NOT NULL,
  quantity        NUMERIC(20,8) NOT NULL,
  buyer_order_id  INTEGER NOT NULL REFERENCES readmodel.orders(id),
  seller_order_id INTEGER NOT NULL REFERENCES readmodel.orders(id),
  -- ── DELIBERATE READ-MODEL DENORMALISATION ──────────────────────
  -- buyer_user_id / seller_user_id duplicate what could be reached by
  -- joining orders twice. They are stored here on purpose: "show me my
  -- trade history" is the single most common read, and without these
  -- every such query needs two joins to orders just to find out whose
  -- trade it was. This is the one place normalisation is traded for
  -- read speed, and it is safe precisely BECAUSE this is a derived
  -- view: the duplication cannot drift, since both copies are written
  -- from the same projection of the same log record. In the write
  -- model that duplication would be a bug; here it is a cache.
  buyer_user_id   INTEGER NOT NULL REFERENCES readmodel.users(id),
  seller_user_id  INTEGER NOT NULL REFERENCES readmodel.users(id),
  wal_seq         BIGINT,
  executed_at     TIMESTAMP
);

CREATE TABLE IF NOT EXISTS readmodel.balances (
  user_id   INTEGER NOT NULL REFERENCES readmodel.users(id),
  asset     VARCHAR(10) NOT NULL,
  available NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (user_id, asset)
);

-- How far into the WAL this read-model reflects. Updated in the SAME
-- transaction as the rows it accounts for, so the two can never
-- disagree and "wrote data but lost the offset" cannot happen.
CREATE TABLE IF NOT EXISTS readmodel.cursor (
  id                INTEGER PRIMARY KEY,
  byte_offset       BIGINT NOT NULL,
  records_projected BIGINT NOT NULL,
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ── Indexes: one per query the read API actually serves ──────────
-- GET /history?userId=  — a user's trades, newest first. Two indexes
-- because a user can be on either side of a trade.
CREATE INDEX IF NOT EXISTS idx_trades_buyer  ON readmodel.trades (buyer_user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_seller ON readmodel.trades (seller_user_id, executed_at DESC);
-- Market tape: recent trades for a symbol.
CREATE INDEX IF NOT EXISTS idx_trades_market ON readmodel.trades (symbol, executed_at DESC);
-- GET /openorders?userId= — partial index: only resting orders are ever
-- queried this way, and they are a small minority of a growing table.
CREATE INDEX IF NOT EXISTS idx_orders_user_open ON readmodel.orders (user_id, id DESC)
  WHERE status IN ('open','partial');
-- Order-book reconstruction for a symbol.
CREATE INDEX IF NOT EXISTS idx_orders_book ON readmodel.orders (symbol, side, price)
  WHERE status IN ('open','partial');
-- A user's full order history, newest first.
CREATE INDEX IF NOT EXISTS idx_orders_user ON readmodel.orders (user_id, id DESC);
`;
