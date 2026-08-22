const crypto = require("crypto");
const { AppError } = require("./errors");

const ALLOWED_PROTOCOLS = ["http:", "https:"];

// Validates a URL submitted for shortening. Returns the trimmed original on
// success and throws AppError(400) otherwise.
//
// Deliberately does NOT normalize (lowercase host, strip default ports, etc.).
// That belongs with the deduplication work, where changing the stored string
// changes which URLs are considered identical.
const validateUrl = (raw) => {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AppError(400, "URL is required");
  }

  const trimmed = raw.trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(400, "Not a valid URL");
  }

  // Without this check we happily mint links that run script under our own
  // domain's reputation: javascript:, data:, file: and friends.
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new AppError(400, "Only http and https URLs can be shortened");
  }

  // Shortening our own short links lets someone build a redirect loop that
  // costs us two lookups per hop.
  if (process.env.BASE_URL) {
    let baseHost;
    try {
      baseHost = new URL(process.env.BASE_URL).host;
    } catch {
      baseHost = null; // misconfigured BASE_URL shouldn't break shortening
    }
    if (baseHost && baseHost === parsed.host) {
      throw new AppError(400, "Cannot shorten a link to this service");
    }
  }

  return trimmed;
};

// Produces the string we hash for deduplication. Kept SEPARATE from what we
// store: original_url keeps exactly what the user sent, this only decides
// which URLs count as the same one.
//
// The URL class already does the safe parts for us — it lowercases the scheme
// and host and drops :80 / :443 — so this is mostly a documented pass-through.
//
// It deliberately does NOT touch path, query or fragment. `?v=abc` and
// `#section` change what page you land on, so collapsing them would hand two
// genuinely different URLs the same short code. That is a correctness bug
// dressed up as a feature.
const normalizeUrl = (raw) => new URL(raw.trim()).href;

// sha256 gives a fixed 64-char hex string, which is why the column is CHAR(64).
// Hashing rather than indexing the URL itself keeps the index small and
// side-steps Postgres' btree size limit on very long URLs.
const hashUrl = (raw) =>
  crypto.createHash("sha256").update(normalizeUrl(raw)).digest("hex");

module.exports = { validateUrl, normalizeUrl, hashUrl };
