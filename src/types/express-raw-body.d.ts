/** Augment Express Request to include the raw body captured by RawBodyMiddleware. */
declare namespace Express {
  interface Request {
    rawBody?: Buffer;
  }
}
