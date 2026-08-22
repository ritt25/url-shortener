# snip — URL Shortener

[![CI](https://github.com/ritt25/url-shortener/actions/workflows/ci.yml/badge.svg)](https://github.com/ritt25/url-shortener/actions/workflows/ci.yml)

A production-grade URL shortener built with real engineering depth. Live at https://url-shortener-7ive.onrender.com/

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js + Express | Lightweight, non-blocking I/O — ideal for high-concurrency redirect traffic |
| Database | PostgreSQL (Supabase) | ACID compliance for reliable URL storage, persistent across restarts |
| Cache | Redis (Upstash) | Sub-millisecond lookups for hot URLs, drastically reduces DB load |
| Hosting | Render | Simple deployment with environment variable management |
| Load Testing | k6 | Scripted performance testing with VU simulation |

---

## Architecture

```
Client
  │
  ▼
Express Server
  │
  ├── POST /shorten ──────────────────► PostgreSQL (write)
  │
  ├── GET /:code
  │     │
  │     ├── Redis HIT ──────────────► 301 Redirect (no DB touch)
  │     │
  │     └── Redis MISS ─────────────► PostgreSQL (read) ──► cache in Redis ──► 301 Redirect
  │
  └── GET /analytics/:code ─────────► PostgreSQL (read)
```

### How it works

1. **Shortening** — A Base-62 nanoid (6 characters) is generated, giving 62⁶ = ~56 billion unique codes. The original URL and code are stored in Postgres.

2. **Redirecting** — On every redirect request, Redis is checked first. If the code is cached (TTL: 24hrs), the redirect is served instantly without touching the database. On a cache miss, Postgres is queried and the result is written to Redis for subsequent requests.

3. **Analytics** — Click count is incremented in Postgres on every redirect (both cache hits and misses). The `/analytics/:code` endpoint returns total clicks, original URL, and creation time.

---

## Key Design Decisions

### Why Base-62 over UUID?
UUIDs are 36 characters — too long for a short URL. Base-62 (a-z, A-Z, 0-9) gives 56 billion combinations in just 6 characters, which is sufficient for massive scale while keeping URLs human-friendly.

### Why Redis as a cache layer?
The redirect path (`GET /:code`) is by far the most frequent operation in a URL shortener — every shared link triggers it. Hitting Postgres on every redirect wouldn't scale. Redis serves cached redirects in under 1ms, keeping the DB free for writes and analytics queries.

### Why a 24-hour TTL on Redis entries?
A TTL prevents Redis memory from growing unboundedly. 24 hours covers the viral spike window for most shared links — after that, traffic typically drops enough that a DB lookup is acceptable.

### Why PostgreSQL over MongoDB?
URL shortener data is highly relational and structured — short code, original URL, click count, timestamp. There's no need for schema flexibility. PostgreSQL's ACID guarantees ensure no duplicate short codes are ever written, even under concurrent load.

### Rate Limiting
`/shorten` is limited to 10 requests/minute per IP using `express-rate-limit`. This prevents abuse (bulk short code generation, DB spam) without affecting normal usage.

---

## Performance (k6 Load Test)

Same script, two targets: `loadtest/redirect.js`. 20 virtual users, 70s
(20s ramp / 40s hold / 10s ramp down), hammering `GET /:code` on a warmed
cache. `setup()` creates its own link, so the run does not depend on any
particular row existing.

```bash
k6 run -e BASE_URL=http://localhost:3000 loadtest/redirect.js
k6 run -e BASE_URL=https://url-shortener-7ive.onrender.com loadtest/redirect.js
```

Local figures are from the current build. The Render column was measured on the
build immediately prior to click buffering; see the note on re-running below.

| Metric | Local (docker-compose) | Render (free tier) |
|---|---|---|
| Requests | 773,771 | 4,105 |
| Throughput | 11,051 req/s | 41 req/s |
| Avg latency | 1.4 ms | 276 ms |
| p90 latency | 2.1 ms | 297 ms |
| p95 latency | 2.4 ms | 316 ms |
| Fastest request | 0.3 ms | 212 ms |
| Error rate | 0% | 0% |

### Effect of buffering click counts

Redirects originally issued a synchronous `UPDATE` to Postgres for the click
counter, so a "cache hit" still cost one database write. Moving counting to a
Redis `INCR` flushed on an interval removed that write from the request path:

| Local, 20 VUs | Synchronous UPDATE | Buffered in Redis |
|---|---|---|
| Throughput | 2,923 req/s | **11,051 req/s** |
| Avg latency | 5.4 ms | **1.4 ms** |
| p95 latency | 12.7 ms | **2.4 ms** |

3.8x throughput and a 5.4x lower p95, from deleting one write per request.
Verified lossless: 773,772 redirects produced exactly 773,772 recorded clicks.

The remote column is network-bound and dominated by a cross-continent hop, so
buffering does not move it meaningfully — see below.

### Where the latency actually lives

The two columns differ by ~25x, and almost none of that is application code.

Breaking down a single warm request to Render from Mumbai:

| Stage | Time |
|---|---|
| TCP connect to Cloudflare edge | ~19 ms |
| TLS handshake | ~46 ms |
| Edge → Render origin (`gcp-us-west1`, Oregon) → response | ~170 ms |

The origin is in Oregon; requests originate from India. That single geographic
hop accounts for the bulk of every measurement. The local column — same code,
same queries, no ocean — settles at 12.7 ms p95, and the fastest remote request
ever recorded (212 ms) is still slower than the slowest local one (77 ms).

So roughly **4% of remote p95 is this service and 96% is distance**. The
honest read: the application is not the bottleneck, the free tier's single
region is. Moving the origin closer to users would do more for p95 than any
amount of query optimisation.

Throughput tells the same story from the other side. 41 req/s remote is not a
capacity ceiling — with 20 virtual users each waiting ~270 ms per round trip,
41 req/s is simply what arithmetic allows. The local run, with the same 20
users, reached 2,923 req/s because each one finished 25x sooner.

### A note on load testing the free tier

Repeating the remote run shortly after the first produced a 97% error rate.
The service itself stayed healthy and recovered immediately — the platform was
shedding load, not failing.

Worth understanding, because the failure is self-amplifying: when requests fail
instantly instead of taking ~270 ms, each virtual user loops straight into the
next one. Offered load jumped from 41 req/s to 911 req/s without the test
changing at all, which provoked more shedding. A load test that starts failing
will keep failing harder unless it backs off.

The lesson for the numbers above: throughput measured from a single machine
across an ocean against a free tier says more about the path and the platform's
limits than about the application. The local column is the one that describes
this code.

### Click counting: the durability tradeoff

Clicks are counted with a Redis `INCR` and flushed to Postgres every 10 seconds
(`CLICK_FLUSH_MS`), plus once more on `SIGTERM` so ordinary deploys lose
nothing. A hard crash loses at most one flush interval of counts.

That is an explicit tradeoff, not an oversight: analytics counters are worth
trading exact durability for a 5x latency win. A payment counter would not be.
If Redis is unavailable the code falls back to writing Postgres directly, so
counting degrades to the old, slower behaviour rather than being lost.
`GET /analytics/:code` adds the buffered value to the stored one, so a click is
never invisible while it waits to be flushed.

> With counting buffered, a cache hit now touches Postgres zero times. Node
> instances stay stateless and can be scaled horizontally behind a load
> balancer with Redis absorbing redirect traffic.

---

## Scaling to Production

If this were to handle millions of requests:

- **Horizontal scaling** — Run multiple Node instances behind a load balancer (e.g. AWS ALB). Since all state lives in Redis + Postgres, instances are stateless and trivially scalable.
- **Read replicas** — Add Postgres read replicas for analytics queries to avoid contention with write operations.
- **Redis cluster** — Shard Redis across nodes for high-availability caching.
- **CDN layer** — Popular short codes could be cached at the CDN edge (Cloudflare Workers) for truly global sub-10ms redirects.
- **Async click tracking** — Move click count updates to a message queue (e.g. Kafka) to decouple analytics writes from the redirect critical path.

---

## API Reference

### `POST /shorten`
Shorten a URL.

**Request:**
```json
{ "url": "https://example.com/very/long/url" }
```

**Response:**
```json
{
  "short_url": "https://url-shortener-7ive.onrender.com/aB3x9k",
  "short_code": "aB3x9k"
}
```

**Rate limit:** 10 requests/minute per IP.

---

### `GET /:code`
Redirects to the original URL. Returns `301` on success, `404` if code not found.

---

### `GET /analytics/:code`
Returns click analytics for a short code.

**Response:**
```json
{
  "short_code": "aB3x9k",
  "original_url": "https://example.com/very/long/url",
  "clicks": 42,
  "created_at": "2026-03-17T12:00:00.000Z"
}
```

---

## Local Development

```bash
# Clone
git clone https://github.com/ritt25/url-shortener
cd url-shortener

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, BASE_URL, PORT

# Run
node src/app.js
```

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Supabase) |
| `REDIS_URL` | Redis connection string (Upstash, use `rediss://`) |
| `BASE_URL` | Public URL of the app (e.g. `https://url-shortener-7ive.onrender.com`) |
| `PORT` | Port to listen on (Render sets this automatically) |

---

Built by [Ritwik Guha](https://github.com/ritt25) · BITS Pilani Goa
