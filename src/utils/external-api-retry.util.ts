export async function retryExternalApiRequest<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts: number = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) {
        throw err;
      }
    }
  }
  throw lastErr;
}
