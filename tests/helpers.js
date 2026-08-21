require("dotenv").config({ quiet: true });
const { pool, initDB } = require("../src/db");
const { client: redisClient, connectCache } = require("../src/cache");

// Called once before a test file runs. Creates the table if it isn't there
// and opens the Redis connection that app.js expects to already exist.
const setupAll = async () => {
  if (!redisClient.isOpen) await connectCache();
  await initDB();
};

// Called before each test. Both stores must be empty, or a code left behind by
// an earlier test can satisfy a later one and hide a real failure.
const reset = async () => {
  await pool.query("TRUNCATE urls RESTART IDENTITY");
  await redisClient.flushDb();
};

// Called once after a test file. Jest hangs on open handles otherwise.
const teardownAll = async () => {
  if (redisClient.isOpen) await redisClient.quit();
  await pool.end();
};

module.exports = { setupAll, reset, teardownAll, pool, redisClient };
