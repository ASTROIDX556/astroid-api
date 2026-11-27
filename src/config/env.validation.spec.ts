import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as envValidation from './env.validation';
import {
  assertValidEnvironment,
  environmentSchema,
  EnvironmentValidationError,
  INSECURE_DEFAULT_ENCRYPTION_KEY,
} from './env.validation';

/** The smallest environment that satisfies every required key. */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://astroid:astroid@localhost:5432/astroid',
  JWT_ACCESS_SECRET: 'access-secret-at-least-16-chars',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-16-chars',
  AI_PROVIDER_KEY: 'nvapi-test-key',
} as const;

/** Parses a dotenv file into key/value pairs (comments and blanks skipped). */
function parseDotenv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

/** Runs the validator and returns the thrown error, failing if none is thrown. */
function validationError(env: NodeJS.ProcessEnv): EnvironmentValidationError {
  try {
    assertValidEnvironment(env);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return error as EnvironmentValidationError;
  }
  throw new Error('Expected environment validation to fail');
}

const ROOT = resolve(__dirname, '..', '..');

describe('assertValidEnvironment', () => {
  it('accepts a configuration containing only the required keys and applies defaults', () => {
    const env = assertValidEnvironment({ ...REQUIRED_ENV });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_HOST).toBe('localhost');
    expect(env.WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(env.STELLAR_USE_MOCK).toBe(true);
    expect(env.DATABASE_URL).toBe(REQUIRED_ENV.DATABASE_URL);
    expect(env.DATABASE_SLOW_QUERY_THRESHOLD_MS).toBe(250);
  });

  it('requires a positive slow query threshold', () => {
    for (const threshold of ['0', '-1', 'invalid']) {
      const error = validationError({
        ...REQUIRED_ENV,
        DATABASE_SLOW_QUERY_THRESHOLD_MS: threshold,
      });
      expect(error.issues.map((issue) => issue.key)).toContain('DATABASE_SLOW_QUERY_THRESHOLD_MS');
    }
  });

  it('defaults the API-key grace period to 24 hours and caps it at 30 days', () => {
    expect(assertValidEnvironment({ ...REQUIRED_ENV }).API_KEY_ROTATION_GRACE_PERIOD_SECONDS).toBe(86400);
    expect(
      assertValidEnvironment({
        ...REQUIRED_ENV,
        API_KEY_ROTATION_GRACE_PERIOD_SECONDS: '2592000',
      }).API_KEY_ROTATION_GRACE_PERIOD_SECONDS,
    ).toBe(2592000);

    for (const value of ['0', '-1', '2592001', 'invalid']) {
      const error = validationError({
        ...REQUIRED_ENV,
        API_KEY_ROTATION_GRACE_PERIOD_SECONDS: value,
      });
      expect(error.issues.map((issue) => issue.key)).toContain(
        'API_KEY_ROTATION_GRACE_PERIOD_SECONDS',
      );
    }
  });

  it('accepts a positive webhook retry limit and rejects zero', () => {
    expect(assertValidEnvironment({ ...REQUIRED_ENV, WEBHOOK_MAX_ATTEMPTS: '3' }).WEBHOOK_MAX_ATTEMPTS).toBe(3);
    const error = validationError({ ...REQUIRED_ENV, WEBHOOK_MAX_ATTEMPTS: '0' });
    expect(error.issues.map((issue) => issue.key)).toContain('WEBHOOK_MAX_ATTEMPTS');
  });

  it('defaults the credential minute window to 60 seconds and validates overrides', () => {
    expect(assertValidEnvironment({ ...REQUIRED_ENV }).RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS).toBe(60);
    expect(
      assertValidEnvironment({
        ...REQUIRED_ENV,
        RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS: '30',
      }).RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS,
    ).toBe(30);

    const error = validationError({
      ...REQUIRED_ENV,
      RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS: '0',
    });
    expect(error.issues.map((issue) => issue.key)).toContain(
      'RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS',
    );
  });

  it('validates the shutdown grace period at startup, together with the other problems', () => {
    const error = validationError({
      ...REQUIRED_ENV,
      SHUTDOWN_GRACE_PERIOD_MS: 'soon',
      PORT: 'not-a-port',
    });

    expect(error.issues.map((issue) => issue.key).sort()).toEqual(['PORT', 'SHUTDOWN_GRACE_PERIOD_MS']);
    expect(assertValidEnvironment({ ...REQUIRED_ENV }).SHUTDOWN_GRACE_PERIOD_MS).toBe(20_000);
  });

  it('validates the health migration toggle and the public rate-limit identifiers', () => {
    const defaults = assertValidEnvironment({ ...REQUIRED_ENV });
    expect(defaults.HEALTH_CHECK_MIGRATIONS_ENABLED).toBe(true);
    expect(defaults.PUBLIC_RATE_LIMIT_CLIENT_IDENTIFIERS).toBe('');

    const configured = assertValidEnvironment({
      ...REQUIRED_ENV,
      HEALTH_CHECK_MIGRATIONS_ENABLED: 'false',
      PUBLIC_RATE_LIMIT_CLIENT_IDENTIFIERS: 'ip,apiKey',
    });
    expect(configured.HEALTH_CHECK_MIGRATIONS_ENABLED).toBe(false);
    expect(configured.PUBLIC_RATE_LIMIT_CLIENT_IDENTIFIERS).toBe('ip,apiKey');

    const error = validationError({ ...REQUIRED_ENV, HEALTH_CHECK_MIGRATIONS_ENABLED: 'maybe' });
    expect(error.issues).toEqual([
      { key: 'HEALTH_CHECK_MIGRATIONS_ENABLED', message: 'must be one of: true, false' },
    ]);
  });

  it('accepts the documented .env.example as-is', () => {
    expect(() => assertValidEnvironment(parseDotenv(resolve(ROOT, '.env.example')))).not.toThrow();
  });

  it('reports every missing required variable together, not just the first', () => {
    const error = validationError({});

    expect(error.issues.map((issue) => issue.key).sort()).toEqual([
      'AI_PROVIDER_KEY',
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ]);
    for (const issue of error.issues) {
      expect(issue.message).toBe('is required but was not set');
    }
    expect(error.message).toContain('Invalid environment configuration (4 problems):');
    expect(error.message).toContain('  - DATABASE_URL: is required but was not set');
    expect(error.message).toContain('.env.example');
  });

  it('treats an empty required value as missing', () => {
    const error = validationError({ ...REQUIRED_ENV, DATABASE_URL: '' });

    expect(error.issues).toEqual([{ key: 'DATABASE_URL', message: 'DATABASE_URL is required' }]);
  });

  it('rejects malformed values with a descriptive message per key', () => {
    const error = validationError({
      ...REQUIRED_ENV,
      NODE_ENV: 'staging',
      PORT: 'not-a-port',
      REDIS_PORT: '-1',
      STELLAR_USE_MOCK: 'yes',
      JWT_ACCESS_SECRET: 'short',
      ENCRYPTION_KEY: 'too-short',
    });

    const byKey = Object.fromEntries(error.issues.map((issue) => [issue.key, issue.message]));
    expect(byKey).toEqual({
      NODE_ENV: 'must be one of: development, test, production',
      PORT: 'must be a valid number',
      REDIS_PORT: expect.stringContaining('greater than 0'),
      STELLAR_USE_MOCK: 'must be one of: true, false',
      JWT_ACCESS_SECRET: 'JWT_ACCESS_SECRET must be >= 16 chars',
      ENCRYPTION_KEY: expect.stringContaining('32-byte'),
    });
  });

  it('never echoes the offending values, which may be secrets', () => {
    const secret = 'hunter2-not-an-enum-value';
    const error = validationError({
      ...REQUIRED_ENV,
      NODE_ENV: secret,
      STELLAR_NETWORK: secret,
      JWT_REFRESH_SECRET: 'tiny-secret',
    });

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('tiny-secret');
  });

  describe('in production', () => {
    const PRODUCTION_ENV = {
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      ENCRYPTION_KEY: 'a'.repeat(64),
    } as const;

    it('accepts a securely configured environment', () => {
      expect(() => assertValidEnvironment({ ...PRODUCTION_ENV })).not.toThrow();
    });

    it('rejects the publicly known default encryption key, explicit or implied', () => {
      for (const env of [
        { ...PRODUCTION_ENV, ENCRYPTION_KEY: INSECURE_DEFAULT_ENCRYPTION_KEY },
        { ...PRODUCTION_ENV, ENCRYPTION_KEY: undefined },
      ]) {
        const error = validationError(env);
        expect(error.issues).toEqual([
          {
            key: 'ENCRYPTION_KEY',
            message: expect.stringContaining('unique secret in production'),
          },
        ]);
      }
    });

    it('rejects reusing the access-token secret for refresh tokens', () => {
      const error = validationError({
        ...PRODUCTION_ENV,
        JWT_REFRESH_SECRET: PRODUCTION_ENV.JWT_ACCESS_SECRET,
      });

      expect(error.issues).toEqual([
        { key: 'JWT_REFRESH_SECRET', message: 'must differ from JWT_ACCESS_SECRET in production' },
      ]);
    });

    it('does not apply the production rules in development', () => {
      expect(() =>
        assertValidEnvironment({
          ...REQUIRED_ENV,
          JWT_REFRESH_SECRET: REQUIRED_ENV.JWT_ACCESS_SECRET,
        }),
      ).not.toThrow();
    });
  });
});

describe('configuration documentation', () => {
  const schemaKeys = Object.keys(environmentSchema.innerType().shape);

  it('validates at startup every variable of every configuration slice schema', () => {
    const startupKeys = new Set(schemaKeys);
    const missing: string[] = [];
    let sliceCount = 0;

    // A slice schema missing from `environmentSchema` is only validated later,
    // from inside Nest's module initialisation, and not reported with the rest.
    for (const [name, exported] of Object.entries(envValidation)) {
      if (!(exported instanceof z.ZodObject)) continue;
      sliceCount += 1;
      for (const key of Object.keys(exported.shape as Record<string, unknown>)) {
        if (!startupKeys.has(key)) missing.push(`${name}.${key}`);
      }
    }

    expect(sliceCount).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it('documents every validated variable in docs/configuration.md', () => {
    const doc = readFileSync(resolve(ROOT, 'docs', 'configuration.md'), 'utf8');
    const undocumented = schemaKeys.filter((key) => !doc.includes(`\`${key}\``));

    expect(undocumented).toEqual([]);
  });

  it('lists every required variable in .env.example', () => {
    const example = parseDotenv(resolve(ROOT, '.env.example'));

    for (const key of Object.keys(REQUIRED_ENV)) {
      expect(example).toHaveProperty(key);
    }
  });
});

describe('log redaction and budget alert configuration', () => {
  it('parses LOG_REDACT_FIELDS into a trimmed, non-empty list', () => {
    const env = assertValidEnvironment({
      ...REQUIRED_ENV,
      LOG_REDACT_FIELDS: ' accountNumber, payoutDetails ,, ',
    });

    expect(env.LOG_REDACT_FIELDS).toEqual(['accountNumber', 'payoutDetails']);
  });

  it('defaults LOG_REDACT_FIELDS to an empty list', () => {
    expect(assertValidEnvironment(REQUIRED_ENV).LOG_REDACT_FIELDS).toEqual([]);
  });

  it('sorts and de-duplicates budget alert thresholds', () => {
    const env = assertValidEnvironment({
      ...REQUIRED_ENV,
      BUDGET_ALERT_THRESHOLDS: '100, 80, 80',
    });

    expect(env.BUDGET_ALERT_THRESHOLDS).toEqual([80, 100]);
  });

  it('rejects a budget threshold above 100 instead of silently dropping it', () => {
    const error = validationError({ ...REQUIRED_ENV, BUDGET_ALERT_THRESHOLDS: '80,150' });

    expect(error.issues.map((issue) => issue.key)).toContain('BUDGET_ALERT_THRESHOLDS');
  });

  it('rejects a non-integer or zero budget threshold', () => {
    expect(
      validationError({ ...REQUIRED_ENV, BUDGET_ALERT_THRESHOLDS: '0' }).issues.map((i) => i.key),
    ).toContain('BUDGET_ALERT_THRESHOLDS');
    expect(
      validationError({ ...REQUIRED_ENV, BUDGET_ALERT_THRESHOLDS: '79.5' }).issues.map((i) => i.key),
    ).toContain('BUDGET_ALERT_THRESHOLDS');
  });
});
