# snip — URL Shortener

A production-deployed URL shortener built with real engineering depth. Live at **[url-shortener-7ive.onrender.com](https://url-shortener-7ive.onrender.com)**.

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

Tested against the live Render deployment:

| Metric | Result |
|---|---|
| Virtual Users | 20 concurrent |
| Total Requests | 1,322 |
| Success Rate | 100% |
| Avg Latency | 257ms |
| p90 Latency | 271ms |
| p95 Latency | 283ms |
| Error Rate | 0% |

> Numbers reflect free-tier hosting constraints. The Redis cache layer is designed to scale horizontally — cache hits never touch the database, so Node instances can be scaled behind a load balancer while Redis absorbs redirect traffic.

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
