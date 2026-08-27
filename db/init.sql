-- ============================================================
-- Mini Centralised Exchange — Stage 0 Database Initialisation
-- Runs ONCE on first container start (empty volume).
-- To re-run: docker compose down -v && docker compose up -d
-- ============================================================

-- 1. Schema ---------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset     VARCHAR(10) NOT NULL,
    available NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (available >= 0),
    locked    NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (locked    >= 0),
    UNIQUE(user_id, asset)
);

CREATE TABLE IF NOT EXISTS orders (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     VARCHAR(20) NOT NULL,
    side       VARCHAR(4)  NOT NULL CHECK (side IN ('buy','sell')),
    price      NUMERIC(20,8) NOT NULL,
    quantity   NUMERIC(20,8) NOT NULL,
    filled     NUMERIC(20,8) NOT NULL DEFAULT 0,
    status     VARCHAR(10) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','partial','filled','cancelled')),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL,
    price           NUMERIC(20,8) NOT NULL,
    quantity         NUMERIC(20,8) NOT NULL,
    buyer_order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    seller_order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- 2. Seed data ------------------------------------------------

-- Five test users
INSERT INTO users (username) VALUES
    ('alice'),    -- id = 1
    ('bob'),      -- id = 2
    ('carol'),    -- id = 3
    ('dave'),     -- id = 4
    ('eve');      -- id = 5

-- Everyone starts with 10,000 USDC and 50 SOL
INSERT INTO balances (user_id, asset, available) VALUES
    (1, 'USDC', 10000), (1, 'SOL', 50),
    (2, 'USDC', 10000), (2, 'SOL', 50),
    (3, 'USDC', 10000), (3, 'SOL', 50),
    (4, 'USDC', 10000), (4, 'SOL', 50),
    (5, 'USDC', 10000), (5, 'SOL', 50);

-- Resting SELL orders at different prices (the order book)
-- This creates a realistic book with price levels:
--   Bob   sells 5 SOL @ 90   (cheapest — matched first)
--   Carol sells 3 SOL @ 95   (second cheapest)
--   Dave  sells 8 SOL @ 110  (above 100 — won't match a buy at 100)
INSERT INTO orders (user_id, symbol, side, price, quantity) VALUES
    (2, 'SOL_USDC', 'sell', 90,  5),   -- order id = 1
    (3, 'SOL_USDC', 'sell', 95,  3),   -- order id = 2
    (4, 'SOL_USDC', 'sell', 110, 8);   -- order id = 3
