require("dotenv").config({ quiet: true });
const app = require("./app");
const { pool, initDB } = require("./db");
const { connectCache, client } = require("./cache");
const { flushClicks } = require("./lib/clicks");

// How long buffered clicks may sit in Redis before being written to Postgres.
// This is the durability window: a hard crash loses at most this much counting.
// Acceptable for analytics, not for anything you would bill on.
const FLUSH_INTERVAL_MS = Number(process.env.CLICK_FLUSH_MS || 10000);

const start = async () => {
  // Postgres is required: with no database there is nothing to serve.
  await initDB();

  // Redis is not. An unreachable cache costs a log line, not the service.
  connectCache().catch((err) =>
    console.error("Redis unavailable at startup, serving from Postgres:", err.message)
  );

  const flushTimer = setInterval(async () => {
    try {
      const n = await flushClicks(pool);
      if (n > 0) console.log(`Flushed clicks for ${n} code(s)`);
    } catch (err) {
      console.error("Click flush failed:", err.message);
    }
  }, FLUSH_INTERVAL_MS);

  // unref so a pending timer never keeps the process alive on its own.
  flushTimer.unref();

  const server = app.listen(process.env.PORT, () => {
    console.log(`Running at ${process.env.BASE_URL}`);
  });

  // Render sends SIGTERM before replacing an instance. Flushing here turns a
  // routine deploy from "loses up to 10s of clicks" into "loses none", leaving
  // the durability window to cover only genuine crashes.
  const shutdown = async (signal) => {
    console.log(`${signal} received, flushing clicks before exit`);
    clearInterval(flushTimer);
    try {
      await flushClicks(pool);
    } catch (err) {
      console.error("Shutdown flush failed:", err.message);
    }
    server.close(async () => {
      if (client.isOpen) await client.quit();
      await pool.end();
      process.exit(0);
    });
    // Don't hang forever if a connection refuses to close.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
