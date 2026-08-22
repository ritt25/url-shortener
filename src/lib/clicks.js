const { client, isCacheUp } = require("../cache");

// Redis key layout:
//   clicks:<code>   integer, increments since the last flush
//   clicks:pending  set of codes that currently have a non-zero counter
//
// The set exists so flushing does not need a KEYS/SCAN sweep of the whole
// keyspace, which is O(n) over every key Redis holds.
const COUNTER_PREFIX = "clicks:";
const PENDING_SET = "clicks:pending";

// Records one click.
//
// The fast path never touches Postgres: an in-memory INCR replaces a disk
// write on every single redirect. If Redis is unavailable we fall straight
// back to the synchronous UPDATE, because losing the cache should cost
// latency, not correctness.
const recordClick = async (pool, code) => {
  if (isCacheUp()) {
    try {
      await client
        .multi()
        .incr(COUNTER_PREFIX + code)
        .sAdd(PENDING_SET, code)
        .exec();
      return "buffered";
    } catch (err) {
      console.error("Click buffering failed, writing directly:", err.message);
    }
  }

  await pool.query("UPDATE urls SET clicks = clicks + 1 WHERE short_code = $1", [code]);
  return "direct";
};

// Clicks not yet written to Postgres. Analytics adds this to the stored value
// so a count is never silently missing for up to a flush interval.
const getPendingClicks = async (code) => {
  if (!isCacheUp()) return 0;
  try {
    const raw = await client.get(COUNTER_PREFIX + code);
    return raw ? parseInt(raw, 10) : 0;
  } catch (err) {
    console.error("Pending click read failed:", err.message);
    return 0;
  }
};

// Moves buffered counts into Postgres. Returns how many codes were written.
const flushClicks = async (pool) => {
  if (!isCacheUp()) return 0;

  let codes;
  try {
    codes = await client.sMembers(PENDING_SET);
  } catch (err) {
    console.error("Flush failed reading pending set:", err.message);
    return 0;
  }
  if (codes.length === 0) return 0;

  const pairs = [];
  for (const code of codes) {
    try {
      // GETDEL reads and clears atomically. Any increment arriving after this
      // starts a fresh counter rather than being wiped, so no click is lost in
      // the gap between reading and deleting.
      const raw = await client.getDel(COUNTER_PREFIX + code);
      await client.sRem(PENDING_SET, code);
      const delta = raw ? parseInt(raw, 10) : 0;
      if (delta > 0) pairs.push([code, delta]);
    } catch (err) {
      console.error(`Flush failed for ${code}:`, err.message);
    }
  }
  if (pairs.length === 0) return 0;

  // One statement for every code, rather than one round trip each.
  await pool.query(
    `UPDATE urls u
     SET clicks = u.clicks + d.delta
     FROM (SELECT unnest($1::text[]) AS code, unnest($2::int[]) AS delta) d
     WHERE u.short_code = d.code`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])]
  );

  return pairs.length;
};

module.exports = { recordClick, getPendingClicks, flushClicks, COUNTER_PREFIX, PENDING_SET };
