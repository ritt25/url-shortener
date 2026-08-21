const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

describe("GET /analytics/:code", () => {
  it("404s on an unknown code", async () => {
    const res = await request(app).get("/analytics/nope12");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not found");
  });

  it("starts a new code at zero clicks", async () => {
    const { body } = await request(app)
      .post("/shorten")
      .send({ url: "https://example.com" });

    const res = await request(app).get(`/analytics/${body.short_code}`);

    expect(res.status).toBe(200);
    expect(res.body.clicks).toBe(0);
    expect(res.body.original_url).toBe("https://example.com");
  });

  it("counts clicks after redirects", async () => {
    const { body } = await request(app)
      .post("/shorten")
      .send({ url: "https://example.com" });

    await request(app).get(`/${body.short_code}`);
    await request(app).get(`/${body.short_code}`);
    await request(app).get(`/${body.short_code}`);

    const res = await request(app).get(`/analytics/${body.short_code}`);

    expect(res.body.clicks).toBe(3);
  });
});
