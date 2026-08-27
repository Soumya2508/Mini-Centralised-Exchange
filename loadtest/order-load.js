// ── Stage 0.5 — k6 load harness ──────────────────────────────
//
//   docker compose down -v && docker compose up -d
//   npm run seed:load
//   npm run dev                       (API on :3000)
//   k6 run -e VUS=25 -e DURATION=30s loadtest/order-load.js
//
// Fires BUY orders that genuinely MATCH the seeded resting sell
// book, so we measure the real transactional path
// (lock -> match -> move funds -> commit), not rejection speed.
// match_rate below confirms the commit path was actually exercised.

import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const filled = new Counter("orders_filled");
const rejected = new Counter("orders_rejected");
const deadlocks = new Counter("orders_deadlocked");
const matchRate = new Rate("match_rate");
const commitLatency = new Trend("commit_latency", true);

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const USER_LO = Number(__ENV.USER_LO || 6);    // load_u1  (after alice..eve)
const USER_HI = Number(__ENV.USER_HI || 205);  // load_u200
const PRICE = Number(__ENV.PRICE || 100);

export const options = {
  scenarios: {
    matching: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || "30s",
      gracefulStop: "10s",
    },
  },
  // Measurement run: no pass/fail gates, we are characterising
  // the baseline rather than enforcing an SLO.
  thresholds: {},
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const userId = USER_LO + Math.floor(Math.random() * (USER_HI - USER_LO + 1));

  const res = http.post(
    `${BASE}/order`,
    JSON.stringify({
      userId,
      symbol: "SOL_USDC",
      side: "buy",
      price: PRICE,   // at the resting sells' price -> eligible to match
      quantity: 1,
    }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /order" } }
  );

  let ok = false;
  let body = null;
  try {
    body = res.json();
  } catch (e) {
    body = null;
  }

  if (body && body.success === true) {
    ok = true;
    filled.add(1);
    commitLatency.add(res.timings.duration);
  } else {
    rejected.add(1);
    const err = (body && body.error) || "";
    if (/deadlock/i.test(err)) deadlocks.add(1);
  }
  matchRate.add(ok);
}
