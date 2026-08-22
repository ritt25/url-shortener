require("dotenv").config({ quiet: true });
const rateLimit = require("express-rate-limit");
const express = require("express");
const path = require("path");
const { pool } = require("./db");
const { safeGet, safeSetEx, isCacheUp } = require("./cache");
const { validateUrl, hashUrl } = require("./lib/urls");
const { createShortCode } = require("./lib/codes");
const { recordClick, getPendingClicks } = require("./lib/clicks");
const { AppError, errorHandler, notFoundHandler } = require("./lib/errors");

const app = express();

// Render sits one proxy in front of us. Without this, req.ip is the proxy's
// address for every visitor, so the rate limiter buckets the entire internet
// into a single key: "10 per minute" becomes 10 per minute in total.
// Use 1, not true. `true` trusts the whole X-Forwarded-For chain, letting a
// caller spoof a header to get a fresh bucket and bypass the limit entirely.
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
});

app.use("/shorten", limiter);

const CACHE_TTL_SECONDS = 86400;

// --- ROUTE: health ---
// Reports degraded rather than unhealthy when only the cache is down, matching
// what the redirect route actually does. A health check that fails on a dead
// cache would have Render restart a service that is working fine.
app.get("/health", async (req, res) => {
  let dbUp = false;
  try {
    await pool.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.error("Health check: database unreachable:", err.message);
  }

  const cacheUp = isCacheUp();
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? (cacheUp ? "ok" : "degraded") : "error",
    database: dbUp ? "up" : "down",
    cache: cacheUp ? "up" : "down",
  });
});

// --- ROUTE: shorten ---
app.post("/shorten", async (req, res) => {
  const url = validateUrl(req.body?.url);
  const urlHash = hashUrl(url);

  // Fast path: we have already shortened this URL, hand back the same code.
  // This is only an optimisation — it is NOT what makes the operation safe.
  // Two requests can both find nothing here and both go on to INSERT; the
  // unique constraint inside createShortCode is what actually arbitrates.
  const existing = await pool.query(
    "SELECT short_code FROM urls WHERE url_hash = $1",
    [urlHash]
  );
  if (existing.rows.length > 0) {
    const short_code = existing.rows[0].short_code;
    return res.json({
      short_url: `${process.env.BASE_URL}/${short_code}`,
      short_code,
    });
  }

  const { short_code } = await createShortCode(pool, url, urlHash);

  res.json({
    short_url: `${process.env.BASE_URL}/${short_code}`,
    short_code,
  });
});

// --- ROUTE: analytics (must stay above /:code) ---
app.get("/analytics/:code", async (req, res) => {
  const { code } = req.params;
  const result = await pool.query(
    "SELECT short_code, original_url, clicks, created_at FROM urls WHERE short_code = $1",
    [code]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, "Not found");
  }

  // Stored count plus whatever is still buffered in Redis, so a click is never
  // invisible for up to a flush interval.
  const row = result.rows[0];
  const pending = await getPendingClicks(code);
  res.json({ ...row, clicks: row.clicks + pending });
});

// --- ROUTE: redirect ---
app.get("/:code", async (req, res) => {
  const { code } = req.params;

  // safeGet returns null on any cache failure, so a dead Redis reads as a
  // plain cache miss and we carry on to Postgres.
  const cached = await safeGet(code);
  if (cached) {
    // A cache hit now touches Postgres zero times: the lookup came from Redis
    // and the click is counted in Redis too.
    await recordClick(pool, code);
    return res.redirect(cached);
  }

  const result = await pool.query(
    "SELECT original_url FROM urls WHERE short_code = $1",
    [code]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, "Short URL not found");
  }

  const originalUrl = result.rows[0].original_url;
  await safeSetEx(code, CACHE_TTL_SECONDS, originalUrl);
  await recordClick(pool, code);

  res.redirect(originalUrl);
});

// Both of these must stay last. Express matches in registration order, so a
// 404 handler placed higher would swallow every route below it.
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
