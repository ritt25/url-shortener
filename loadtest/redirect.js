import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

// Target is chosen at run time so the same script measures local and remote:
//   k6 run -e BASE_URL=http://localhost:3000 loadtest/redirect.js
//   k6 run -e BASE_URL=https://url-shortener-7ive.onrender.com loadtest/redirect.js
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const cacheHit = new Trend("redirect_cache_hit", true);

export const options = {
  stages: [
    { duration: "20s", target: 20 }, // ramp up
    { duration: "40s", target: 20 }, // hold
    { duration: "10s", target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

// Runs once before the load. Creating the link here rather than hardcoding a
// short code means the script works against any environment, and against a
// database that was wiped since the last run.
export function setup() {
  const target = `https://example.com/loadtest-${Date.now()}`;

  const res = http.post(
    `${BASE_URL}/shorten`,
    JSON.stringify({ url: target }),
    { headers: { "Content-Type": "application/json" }, timeout: "60s" }
  );

  if (res.status !== 200) {
    throw new Error(`setup failed: POST /shorten returned ${res.status} — ${res.body}`);
  }

  const code = JSON.parse(res.body).short_code;

  // Warm the cache with one request, so the measured run is steady-state
  // cache-hit performance rather than a mix that includes the first miss.
  http.get(`${BASE_URL}/${code}`, { redirects: 0, timeout: "60s" });

  return { code, target };
}

export default function (data) {
  // redirects: 0 stops k6 following the 302 out to example.com — we are
  // measuring our own service, not the internet.
  const res = http.get(`${BASE_URL}/${data.code}`, { redirects: 0 });

  cacheHit.add(res.timings.duration);

  check(res, {
    "status is 302": (r) => r.status === 302,
    "location is correct": (r) => r.headers["Location"] === data.target,
  });
}
