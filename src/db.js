const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(10) UNIQUE NOT NULL,
      original_url TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Existing deployments already have the column as TIMESTAMP (no time zone),
  // which CREATE TABLE IF NOT EXISTS will not change. TIMESTAMP stores a wall
  // clock with no offset, so a row written by a server in UTC and read by one
  // in IST is silently off by 5.5 hours. Convert in place, treating the stored
  // values as the UTC they actually were.
  await pool.query(`
    ALTER TABLE urls
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC'
  `);

  // Session 3: dedupe identical URLs.
  // Nullable on purpose — rows created before this column existed have no hash,
  // and Postgres allows many NULLs in a unique index (NULL != NULL).
  await pool.query(`ALTER TABLE urls ADD COLUMN IF NOT EXISTS url_hash CHAR(64)`);

  // A NAMED constraint, because the insert path branches on err.constraint to
  // tell a short_code collision apart from a duplicate URL. Postgres 15 has no
  // ADD CONSTRAINT IF NOT EXISTS, hence the guard.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'urls_url_hash_key'
      ) THEN
        ALTER TABLE urls ADD CONSTRAINT urls_url_hash_key UNIQUE (url_hash);
      END IF;
    END $$;
  `);

  console.log("Database ready");
};

module.exports = { pool, initDB };
