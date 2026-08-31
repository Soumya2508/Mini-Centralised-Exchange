// ── Stage 4.2 — read-side load ────────────────────────────────
//
// Hammers the CQRS query API (:3001) while the write side is under
// load, to show that queries cannot affect engine throughput.
//
//   k6 run -e VUS=25 -e DURATION=20s loadtest/read-load.js
//
// Every request here hits Postgres readmodel.* through a process that
// has no connection to the engine whatsoever.

import http from "k6/http";
import { Rate } from "k6/metrics";

const okRate = new Rate("query_ok");

const BASE = __ENV.READ_URL || "http://localhost:3001";
const USER_LO = Number(__ENV.USER_LO || 6);
const USER_HI = Number(__ENV.USER_HI || 205);

export const options = {
  scenarios: {
    reads: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 25),
      duration: __ENV.DURATION || "20s",
      gracefulStop: "10s",
    },
  },
  thresholds: {},
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const uid = USER_LO + Math.floor(Math.random() * (USER_HI - USER_LO + 1));
  // Rotate through the endpoints a real client would use.
  const pick = Math.floor(Math.random() * 4);
  let res;
  if (pick === 0) res = http.get(`${BASE}/history?userId=${uid}&limit=50`, { tags: { name: "history" } });
  else if (pick === 1) res = http.get(`${BASE}/openorders?userId=${uid}`, { tags: { name: "openorders" } });
  else if (pick === 2) res = http.get(`${BASE}/balances?userId=${uid}`, { tags: { name: "balances" } });
  else res = http.get(`${BASE}/orderbook?symbol=SOL_USDC&depth=10`, { tags: { name: "orderbook" } });

  okRate.add(res.status === 200);
}
