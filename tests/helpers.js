require("dotenv").config({ quiet: true });
const { pool, initDB } = require("../src/db");
const { client: redisClient, connectCache } = require("../src/cache");

// Called once before a test file runs.
const setupAll = async () => {
  if (!redisClient.isOpen) await connectCache();
  await initDB();
};

// Called before each test. Both stores must be empty, or a code left behind by
// an earlier test can satisfy a later one and hide a real failure.
//
// Reconnects Redis first: the resilience tests deliberately close the client to
// simulate an outage, and every following test needs a healthy cache again.
const reset = async () => {
  await pool.query("TRUNCATE urls RESTART IDENTITY");

  if (!redisClient.isOpen) {
    try {
      await connectCache();
    } catch (err) {
      console.error("Test setup: could not reconnect Redis:", err.message);
    }
  }

  if (redisClient.isReady) {
    await redisClient.flushDb();
  }
};

// Called once after a test file. Jest hangs on open handles otherwise.
const teardownAll = async () => {
  if (redisClient.isOpen) await redisClient.quit();
  await pool.end();
};

module.exports = { setupAll, reset, teardownAll, pool, redisClient };
