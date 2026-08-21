const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

describe("POST /shorten", () => {
  it("returns a 6-character code", async () => {
    const res = await request(app)
      .post("/shorten")
      .send({ url: "https://example.com/some/page" });

    expect(res.status).toBe(200);
    expect(res.body.short_code).toHaveLength(6);
    expect(res.body.short_code).toMatch(/^[a-zA-Z0-9]{6}$/);
  });

  it("includes BASE_URL in the returned short_url", async () => {
    const res = await request(app)
      .post("/shorten")
      .send({ url: "https://example.com" });

    expect(res.body.short_url).toBe(
      `${process.env.BASE_URL}/${res.body.short_code}`
    );
  });

  it("rejects a request with no url", async () => {
    const res = await request(app).post("/shorten").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("URL is required");
  });
});
