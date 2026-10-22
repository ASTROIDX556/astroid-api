import { describe, expect, it, vi } from 'vitest';
import { retryExternalApiRequest } from './external-api-retry.util';

describe('retryExternalApiRequest (#292)', () => {
  it('retries failed external API calls up to maxAttempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ ok: true });

    const result = await retryExternalApiRequest(fn, 3);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
