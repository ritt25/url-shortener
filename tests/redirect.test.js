const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

describe("GET /:code", () => {
  it("404s on a code that does not exist", async () => {
    const res = await request(app).get("/nope12");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Short URL not found");
  });

  it("redirects to the original url", async () => {
    const target = "https://example.com/deep/link?x=1";
    const { body } = await request(app).post("/shorten").send({ url: target });

    const res = await request(app).get(`/${body.short_code}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(target);
  });

  it("serves the second hit from cache and still redirects", async () => {
    const target = "https://example.com/cached";
    const { body } = await request(app).post("/shorten").send({ url: target });

    await request(app).get(`/${body.short_code}`); // populates Redis
    const res = await request(app).get(`/${body.short_code}`); // cache hit

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(target);
  });
});
