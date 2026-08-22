require("dotenv").config({ quiet: true });
const app = require("./app");
const { initDB } = require("./db");
const { connectCache } = require("./cache");

const start = async () => {
  // Postgres is required: with no database there is nothing to serve, so a
  // failure here should stop the deploy rather than serve a broken site.
  await initDB();

  // Redis is NOT required. Kicking the connection off without awaiting it means
  // an unreachable cache costs us a log line instead of the whole service.
  // Awaiting this is what kept the site down when the Upstash database vanished.
  connectCache().catch((err) =>
    console.error("Redis unavailable at startup, serving from Postgres:", err.message)
  );

  app.listen(process.env.PORT, () => {
    console.log(`Running at ${process.env.BASE_URL}`);
  });
};

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
