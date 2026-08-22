const request = require("supertest");
const app = require("../src/app");
const { setupAll, reset, teardownAll } = require("./helpers");

beforeAll(setupAll);
beforeEach(reset);
afterAll(teardownAll);

describe("POST /shorten validation", () => {
  it("rejects a missing url", async () => {
    const res = await request(app).post("/shorten").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("URL is required");
  });

  it("rejects an empty url", async () => {
    const res = await request(app).post("/shorten").send({ url: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects a string that is not a url", async () => {
    const res = await request(app).post("/shorten").send({ url: "not a url" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Not a valid URL");
  });

  it("rejects javascript: urls", async () => {
    const res = await request(app)
      .post("/shorten")
      .send({ url: "javascript:alert(document.cookie)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Only http and https URLs can be shortened");
  });

  it("rejects data: and file: urls", async () => {
    for (const url of ["data:text/html,<script>1</script>", "file:///etc/passwd"]) {
      const res = await request(app).post("/shorten").send({ url });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a link back to this service", async () => {
    const res = await request(app)
      .post("/shorten")
      .send({ url: `${process.env.BASE_URL}/abc123` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cannot shorten a link to this service");
  });

  it("accepts http and https", async () => {
    for (const url of ["http://example.com/a", "https://example.com/b"]) {
      const res = await request(app).post("/shorten").send({ url });
      expect(res.status).toBe(200);
    }
  });

  it("stores the url unchanged, preserving query and fragment", async () => {
    const url = "https://Example.com/Path?v=abc#section";
    const { body } = await request(app).post("/shorten").send({ url });
    const res = await request(app).get(`/analytics/${body.short_code}`);
    expect(res.body.original_url).toBe(url);
  });
});
