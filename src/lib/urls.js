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

module.exports = { validateUrl };
