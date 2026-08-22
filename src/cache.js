const redis = require("redis");

const client = redis.createClient({
  url: process.env.REDIS_URL,
  socket: {
    // Default behaviour is to retry forever. When the host genuinely no longer
    // exists (a deleted Upstash database resolves to NXDOMAIN) that means an
    // error line per attempt, forever. Give up after 10 tries and stay down;
    // the safe* helpers below make "down" survivable.
    reconnectStrategy: (retries) =>
      retries > 10 ? false : Math.min(retries * 200, 3000),
  },
});

// Without an 'error' listener, node-redis emits an unhandled 'error' event and
// Node kills the process. This listener is what keeps a dead cache from being
// a fatal crash.
let lastErrorLogged = null;
client.on("error", (err) => {
  if (err.message !== lastErrorLogged) {
    console.error("Redis error:", err.message);
    lastErrorLogged = err.message; // don't spam identical lines on every retry
  }
});
client.on("ready", () => {
  lastErrorLogged = null;
  console.log("Redis ready");
});

const connectCache = async () => {
  await client.connect();
};

// --- fail-open wrappers ---
// The cache is an optimisation. Every value in it also exists in Postgres, so
// a cache failure must make us slower, never unavailable. Both helpers swallow
// their errors on purpose.

const safeGet = async (key) => {
  // isReady, not isOpen. isOpen is true the moment connect() is called, while
  // the socket may still be failing to resolve; isReady means commands will
  // actually be accepted.
  if (!client.isReady) return null;
  try {
    return await client.get(key);
  } catch (err) {
    console.error("Cache read failed, falling back to Postgres:", err.message);
    return null; // a miss, as far as the caller is concerned
  }
};

const safeSetEx = async (key, ttlSeconds, value) => {
  if (!client.isReady) return false;
  try {
    await client.setEx(key, ttlSeconds, value);
    return true;
  } catch (err) {
    console.error("Cache write failed, continuing:", err.message);
    return false;
  }
};

const isCacheUp = () => client.isReady;

module.exports = {
  client,
  connectCache,
  safeGet,
  safeSetEx,
  isCacheUp,
};
