import { describe, expect, it } from 'vitest';
import { assertRequiredStartupEnv } from './startup-env-guard.util';

describe('assertRequiredStartupEnv (#291)', () => {
  it('passes when all required keys are populated and throws listing missing keys', () => {
    expect(() =>
      assertRequiredStartupEnv(
        { DATABASE_URL: 'postgres://localhost/db', JWT_SECRET: 'secret' },
        ['DATABASE_URL', 'JWT_SECRET'],
      ),
    ).not.toThrow();

    expect(() =>
      assertRequiredStartupEnv({ DATABASE_URL: '' }, ['DATABASE_URL', 'REDIS_URL']),
    ).toThrow(/DATABASE_URL, REDIS_URL/);
  });
});
