require("dotenv").config();
const rateLimit = require("express-rate-limit");
const express = require("express");
const path = require("path");
const { customAlphabet } = require("nanoid");
const { pool, initDB } = require("./db");
const { client: redisClient, connectCache } = require("./cache");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/shorten", limiter);

const nanoid = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  6
);

// --- ROUTE 1: Shorten a URL ---
app.post("/shorten", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const short_code = nanoid();
  await pool.query(
    "INSERT INTO urls (short_code, original_url) VALUES ($1, $2)",
    [short_code, url]
  );

  res.json({
    short_url: `${process.env.BASE_URL}/${short_code}`,
    short_code,
  });
});

// --- ROUTE 2: Analytics (must be before /:code) ---
app.get("/analytics/:code", async (req, res) => {
  const { code } = req.params;
  const result = await pool.query(
    "SELECT short_code, original_url, clicks, created_at FROM urls WHERE short_code = $1",
    [code]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(result.rows[0]);
});

// --- ROUTE 3: Redirect short → original ---
app.get("/:code", async (req, res) => {
  const { code } = req.params;

  const cached = await redisClient.get(code);
  if (cached) {
    console.log(`Cache HIT for ${code}`);
    await pool.query("UPDATE urls SET clicks = clicks + 1 WHERE short_code = $1", [code]);
    return res.redirect(cached);
  }

  console.log(`Cache MISS for ${code}`);
  const result = await pool.query(
    "SELECT original_url FROM urls WHERE short_code = $1",
    [code]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Short URL not found" });
  }

  const originalUrl = result.rows[0].original_url;
  await redisClient.setEx(code, 86400, originalUrl);
  await pool.query("UPDATE urls SET clicks = clicks + 1 WHERE short_code = $1", [code]);

  res.redirect(originalUrl);
});

// --- START SERVER ---
const start = async () => {
  await connectCache();
  await initDB();
  app.listen(process.env.PORT, () => {
    console.log(`🚀 Running at ${process.env.BASE_URL}`);
  });
};

start();