const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll, redisClient } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

// The point of Session 2: losing the cache must cost latency, not availability.
describe("with Redis down", () => {
  it("still redirects, serving from Postgres", async () => {
    const target = "https://example.com/survives";
    const { body } = await request(app).post("/shorten").send({ url: target });

    await redisClient.quit(); // simulate the cache disappearing

    const res = await request(app).get(`/${body.short_code}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(target);
  });

  it("still 404s correctly on an unknown code", async () => {
    await redisClient.quit();
    const res = await request(app).get(`/nope12`);
    expect(res.status).toBe(404);
  });

  it("still counts clicks", async () => {
    const { body } = await request(app)
      .post("/shorten")
      .send({ url: "https://example.com/counted" });

    await redisClient.quit();

    await request(app).get(`/${body.short_code}`);
    await request(app).get(`/${body.short_code}`);

    const res = await request(app).get(`/analytics/${body.short_code}`);
    expect(res.body.clicks).toBe(2);
  });
});
