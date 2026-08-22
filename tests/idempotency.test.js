const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll, pool } = require("./helpers");
const { createShortCode } = require("../src/lib/codes");
const { hashUrl, normalizeUrl } = require("../src/lib/urls");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

const shorten = (url) => request(app).post("/shorten").send({ url });

describe("idempotent shortening", () => {
  it("returns the same code for the same url twice", async () => {
    const url = "https://example.com/same";
    const first = await shorten(url);
    const second = await shorten(url);

    expect(first.body.short_code).toBe(second.body.short_code);
  });

  it("stores only one row for a repeated url", async () => {
    await shorten("https://example.com/once");
    await shorten("https://example.com/once");

    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM urls");
    expect(rows[0].n).toBe(1);
  });

  it("treats scheme and host case as the same url", async () => {
    const a = await shorten("https://Example.COM/path");
    const b = await shorten("https://example.com/path");

    expect(a.body.short_code).toBe(b.body.short_code);
  });

  it("treats a default port as the same url", async () => {
    const a = await shorten("https://example.com:443/p");
    const b = await shorten("https://example.com/p");

    expect(a.body.short_code).toBe(b.body.short_code);
  });

  it("keeps different query strings separate", async () => {
    const a = await shorten("https://example.com/watch?v=aaa");
    const b = await shorten("https://example.com/watch?v=bbb");

    expect(a.body.short_code).not.toBe(b.body.short_code);
  });

  it("keeps different fragments separate", async () => {
    const a = await shorten("https://example.com/doc#one");
    const b = await shorten("https://example.com/doc#two");

    expect(a.body.short_code).not.toBe(b.body.short_code);
  });

  it("stores the original url, not the normalized one", async () => {
    const url = "https://Example.COM/Path?v=abc#section";
    const { body } = await shorten(url);
    const res = await request(app).get(`/analytics/${body.short_code}`);

    expect(res.body.original_url).toBe(url);
  });
});

describe("normalizeUrl / hashUrl", () => {
  it("lowercases scheme and host but leaves the path alone", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Path")).toBe("https://example.com/Path");
  });

  it("produces a 64 character hex hash", () => {
    expect(hashUrl("https://example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("short code collisions", () => {
  it("retries with a fresh code when the generated one is taken", async () => {
    const taken = "TAKEN1";
    await pool.query(
      "INSERT INTO urls (short_code, original_url, url_hash) VALUES ($1, $2, $3)",
      [taken, "https://example.com/first", hashUrl("https://example.com/first")]
    );

    // Hand out the colliding code once, then a usable one.
    let call = 0;
    const generator = () => (++call === 1 ? taken : "FRESH1");

    const result = await createShortCode(
      pool,
      "https://example.com/second",
      hashUrl("https://example.com/second"),
      generator
    );

    expect(call).toBe(2);              // it really did retry
    expect(result.short_code).toBe("FRESH1");
    expect(result.reused).toBe(false);
  });

  it("gives up after 3 attempts if every code collides", async () => {
    const taken = "TAKEN2";
    await pool.query(
      "INSERT INTO urls (short_code, original_url, url_hash) VALUES ($1, $2, $3)",
      [taken, "https://example.com/a", hashUrl("https://example.com/a")]
    );

    const alwaysCollides = () => taken;

    await expect(
      createShortCode(pool, "https://example.com/b", hashUrl("https://example.com/b"), alwaysCollides)
    ).rejects.toThrow("Could not generate a unique short code");
  });
});

describe("duplicate url race", () => {
  it("returns the winner's code when the same url is inserted first", async () => {
    const url = "https://example.com/raced";
    const urlHash = hashUrl(url);

    // Stand in for the other request that won the race.
    await pool.query(
      "INSERT INTO urls (short_code, original_url, url_hash) VALUES ($1, $2, $3)",
      ["WINNER", url, urlHash]
    );

    // We skip the SELECT fast path by calling createShortCode directly, which
    // is exactly what happens when the winner commits after our SELECT ran.
    const result = await createShortCode(pool, url, urlHash, () => "LOSER1");

    expect(result.short_code).toBe("WINNER");
    expect(result.reused).toBe(true);
  });

  it("does not create a second row for the raced url", async () => {
    const url = "https://example.com/raced2";
    const urlHash = hashUrl(url);
    await pool.query(
      "INSERT INTO urls (short_code, original_url, url_hash) VALUES ($1, $2, $3)",
      ["WINNER2", url, urlHash]
    );

    await createShortCode(pool, url, urlHash, () => "LOSER2");

    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM urls");
    expect(rows[0].n).toBe(1);
  });
});
