-- ============================================================
-- Stage 0.5 — load-test seed data
--
-- Generated, not hand-written. Idempotent: safe to re-run.
-- Intended flow:
--     docker compose down -v && docker compose up -d      (init.sql runs)
--     npm run seed:load                                   (this file)
--
-- Creates 200 load users funded in BOTH assets, plus a resting
-- SELL book deep enough that a sustained run keeps matching
-- instead of degenerating into cheap rejections.
-- ============================================================

-- 1. 200 load users -------------------------------------------
INSERT INTO users (username)
SELECT 'load_u' || g
FROM generate_series(1, 200) AS g
ON CONFLICT (username) DO NOTHING;

-- 2. Fund every load user in both assets ----------------------
-- Deliberately generous: the point is to measure the matching
-- path, not to hit an insufficient-funds rejection mid-run.
INSERT INTO balances (user_id, asset, available)
SELECT u.id, 'USDC', 10000000
FROM users u
WHERE substring(u.username, 1, 6) = 'load_u'
ON CONFLICT (user_id, asset) DO UPDATE SET available = EXCLUDED.available;

INSERT INTO balances (user_id, asset, available)
SELECT u.id, 'SOL', 100000
FROM users u
WHERE substring(u.username, 1, 6) = 'load_u'
ON CONFLICT (user_id, asset) DO UPDATE SET available = EXCLUDED.available;

-- 3. Resting SELL book ----------------------------------------
-- 10 orders x 200 users = 2,000 resting sells, 50 SOL each
-- = 100,000 SOL of liquidity.
--
-- Sized this way on purpose: quantity 50 lets one row absorb many
-- partial fills, so the book stays SMALL in row count. A book of
-- 100,000 single-unit rows would make the (unindexed) match query
-- a large sequential scan, and we would end up measuring scan cost
-- rather than the lock -> match -> move funds -> commit path.
INSERT INTO orders (user_id, symbol, side, price, quantity)
SELECT u.id, 'SOL_USDC', 'sell', 100, 50
FROM generate_series(1, 10) AS s
CROSS JOIN users u
WHERE substring(u.username, 1, 6) = 'load_u';

-- 4. Report what was seeded -----------------------------------
SELECT
  (SELECT count(*) FROM users WHERE substring(username,1,6) = 'load_u')   AS load_users,
  (SELECT count(*) FROM balances b JOIN users u ON u.id = b.user_id
     WHERE substring(u.username,1,6) = 'load_u')                          AS funded_balance_rows,
  (SELECT count(*) FROM orders WHERE side = 'sell' AND status = 'open')   AS resting_sells,
  (SELECT SUM(quantity - filled) FROM orders
     WHERE side = 'sell' AND status IN ('open','partial'))                AS sol_liquidity;
