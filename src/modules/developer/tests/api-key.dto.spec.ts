import { describe, expect, it } from 'vitest';
import { rotateApiKeySchema } from '../api-key.dto';

describe('rotateApiKeySchema', () => {
  it('allows rotation without a request body', () => {
    expect(rotateApiKeySchema.parse(undefined)).toEqual({});
  });

  it('rejects grace periods above 30 days', () => {
    expect(
      rotateApiKeySchema.safeParse({ gracePeriodSeconds: 2_592_001 }).success,
    ).toBe(false);
  });
});
