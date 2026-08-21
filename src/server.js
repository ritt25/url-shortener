require("dotenv").config({ quiet: true });
const app = require("./app");
const { initDB } = require("./db");
const { connectCache } = require("./cache");

// Connecting to Postgres and Redis happens here, not in app.js. Tests supply
// their own connections, so app.js must stay side-effect free on import.
const start = async () => {
  await connectCache();
  await initDB();
  app.listen(process.env.PORT, () => {
    console.log(`Running at ${process.env.BASE_URL}`);
  });
};

start();
