const { customAlphabet } = require("nanoid");
const { AppError } = require("./errors");

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 3;

// Postgres raises this for ANY unique violation. Which constraint fired is the
// only thing separating two situations that need opposite responses.
const UNIQUE_VIOLATION = "23505";
const SHORT_CODE_CONSTRAINT = "urls_short_code_key";
const URL_HASH_CONSTRAINT = "urls_url_hash_key";

const defaultGenerator = customAlphabet(BASE62, CODE_LENGTH);

// Inserts a new row and returns { short_code, reused }.
//
// The generator is injectable so tests can force a collision; production never
// passes it.
const createShortCode = async (pool, originalUrl, urlHash, generate = defaultGenerator) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const short_code = generate();

    try {
      await pool.query(
        "INSERT INTO urls (short_code, original_url, url_hash) VALUES ($1, $2, $3)",
        [short_code, originalUrl, urlHash]
      );
      return { short_code, reused: false };
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION) throw err;

      // Someone inserted this same URL between our SELECT and our INSERT.
      // Their row won. Hand back their code rather than retrying, which would
      // just lose the same race again until attempts run out.
      if (err.constraint === URL_HASH_CONSTRAINT) {
        const winner = await pool.query(
          "SELECT short_code FROM urls WHERE url_hash = $1",
          [urlHash]
        );
        if (winner.rows.length > 0) {
          return { short_code: winner.rows[0].short_code, reused: true };
        }
        throw err; // constraint fired but the row is gone; nothing sane to do
      }

      // Our random code was already taken. Different code, try again.
      if (err.constraint === SHORT_CODE_CONSTRAINT) continue;

      throw err; // some other unique constraint we don't know about
    }
  }

  throw new AppError(500, "Could not generate a unique short code");
};

module.exports = {
  createShortCode,
  SHORT_CODE_CONSTRAINT,
  URL_HASH_CONSTRAINT,
  UNIQUE_VIOLATION,
};
