// One error type for anything we deliberately reject, so routes can throw a
// status code instead of each one hand-rolling res.status(...).json(...).
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.isExpected = true; // distinguishes "user sent junk" from "we broke"
  }
}

// Express identifies error middleware ONLY by the 4-argument signature.
// Drop the unused `next` and Express treats this as a normal route that never
// matches, and errors fall through to the default HTML error page.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err.isExpected) {
    return res.status(err.status).json({ error: err.message });
  }

  // Anything unexpected: log the real reason for us, tell the caller nothing.
  // Leaking err.message here is how database schema details end up in public.
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong" });
};

const notFoundHandler = (req, res) => {
  res.status(404).json({ error: "Not found" });
};

module.exports = { AppError, errorHandler, notFoundHandler };
