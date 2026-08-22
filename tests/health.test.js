const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll, redisClient } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

describe("GET /health", () => {
  it("reports ok when both dependencies are up", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "up", cache: "up" });
  });

  it("reports degraded, not error, when only the cache is down", async () => {
    await redisClient.quit();
    const res = await request(app).get("/health");

    expect(res.status).toBe(200); // still serving traffic
    expect(res.body.status).toBe("degraded");
    expect(res.body.database).toBe("up");
    expect(res.body.cache).toBe("down");
  });
});
