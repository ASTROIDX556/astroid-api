export interface RpcRetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as Record<string, unknown>;
  const status = typeof err.status === 'number' ? err.status : err.statusCode;

  if (typeof status === 'number') {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }

  const code = typeof err.code === 'string' ? err.code : '';
  if (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)
  ) {
    return true;
  }

  const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return (
    msg.includes('timeout') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503')
  );
}

export async function executeRpcWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  config: RpcRetryConfig = {},
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 200;
  const maxDelayMs = config.maxDelayMs ?? 5_000;
  const jitterRatio = config.jitterRatio ?? 0;
  const sleep = config.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableRpcError(error)) {
        throw error;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = jitterRatio > 0 ? Math.round(exp * jitterRatio) : 0;
      await sleep(exp + jitter);
    }
  }

  throw lastError;
}
