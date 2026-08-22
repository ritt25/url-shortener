const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll, pool, redisClient } = require("./helpers");
const { flushClicks, COUNTER_PREFIX, PENDING_SET } = require("../src/lib/clicks");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

const makeLink = async (url = "https://example.com/clicks") => {
  const { body } = await request(app).post("/shorten").send({ url });
  return body.short_code;
};

const storedClicks = async (code) => {
  const { rows } = await pool.query(
    "SELECT clicks FROM urls WHERE short_code = $1",
    [code]
  );
  return rows[0].clicks;
};

describe("click buffering", () => {
  it("does not write to Postgres on redirect", async () => {
    const code = await makeLink();

    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    // The whole point: the redirect path no longer costs a database write.
    expect(await storedClicks(code)).toBe(0);
  });

  it("buffers the count in Redis", async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    const buffered = await redisClient.get(COUNTER_PREFIX + code);
    expect(parseInt(buffered, 10)).toBe(2);

    const pending = await redisClient.sMembers(PENDING_SET);
    expect(pending).toContain(code);
  });

  it("analytics reports buffered clicks before any flush", async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    const res = await request(app).get(`/analytics/${code}`);
    expect(res.body.clicks).toBe(2);
    expect(await storedClicks(code)).toBe(0); // still only in Redis
  });

  it("flush moves the count into Postgres", async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    const written = await flushClicks(pool);

    expect(written).toBe(1);
    expect(await storedClicks(code)).toBe(2);
  });

  it("does not double count across a flush", async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await flushClicks(pool);
    await request(app).get(`/${code}`);
    await flushClicks(pool);

    expect(await storedClicks(code)).toBe(2);

    const res = await request(app).get(`/analytics/${code}`);
    expect(res.body.clicks).toBe(2);
  });

  it("a flush with nothing pending is a no-op", async () => {
    expect(await flushClicks(pool)).toBe(0);
  });

  it("flushes several codes in one pass", async () => {
    const a = await makeLink("https://example.com/a");
    const b = await makeLink("https://example.com/b");

    await request(app).get(`/${a}`);
    await request(app).get(`/${b}`);
    await request(app).get(`/${b}`);

    expect(await flushClicks(pool)).toBe(2);
    expect(await storedClicks(a)).toBe(1);
    expect(await storedClicks(b)).toBe(2);
  });

  it("clears the pending set after flushing", async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await flushClicks(pool);

    expect(await redisClient.sMembers(PENDING_SET)).toHaveLength(0);
    expect(await redisClient.get(COUNTER_PREFIX + code)).toBeNull();
  });
});

describe("click counting with Redis down", () => {
  it("falls back to writing Postgres directly", async () => {
    const code = await makeLink();
    await redisClient.quit();

    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    // No buffer available, so the count must land in Postgres immediately or
    // it would be lost entirely.
    expect(await storedClicks(code)).toBe(2);
  });

  it("analytics still reports the right total", async () => {
    const code = await makeLink();
    await redisClient.quit();
    await request(app).get(`/${code}`);

    const res = await request(app).get(`/analytics/${code}`);
    expect(res.body.clicks).toBe(1);
  });
});
