const redis = require("redis");

const client = redis.createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true,
    rejectUnauthorized: false,
  },
});

client.on("error", (err) => console.error("Redis error:", err));

const connectCache = async () => {
  await client.connect();
  console.log("✅ Redis ready");
};

module.exports = { client, connectCache };