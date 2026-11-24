import pinoHttp from 'pino-http';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from '../../utils/crypto.util';
import { createPinoHttpOptions } from './pino-http.options';

const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const API_KEY = `ak_live_${generateToken(24)}`;
const SIGNING_SECRET = 'whsec_4f9c2b7e1a6d4e0f8b3a';

/** A logger built from the application's real pino options, writing to memory. */
function createCapturingLogger() {
  const lines: string[] = [];
  const logger = pinoHttp(createPinoHttpOptions(), {
    write: (line: string) => {
      lines.push(line);
    },
  }).logger;
  return {
    logger,
    lines,
    last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown>,
    text: () => lines.join('\n'),
  };
}

describe('application logger redaction', () => {
  let log: ReturnType<typeof createCapturingLogger>;

  beforeEach(() => {
    log = createCapturingLogger();
  });

  it('masks authorization, cookie, API key and idempotency key headers of a logged request', () => {
    log.logger.info(
      {
        req: {
          id: 'req-1',
          method: 'POST',
          url: '/api/v1/transactions',
          headers: {
            authorization: `Bearer ${BEARER}`,
            cookie: 'session=abc123def456',
            'x-api-key': API_KEY,
            'idempotency-key': 'idem-7f3a9c',
            'user-agent': 'vitest',
          },
        },
      },
      'incoming request',
    );

    const text = log.text();
    for (const secret of [BEARER, 'abc123def456', API_KEY, 'idem-7f3a9c']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('vitest');
  });

  it('redacts an authorization header and a refreshToken body when a whole request is logged', () => {
    log.logger.info(
      {
        req: { method: 'POST', url: '/api/v1/auth/refresh', headers: { authorization: `Bearer ${BEARER}` } },
        body: { refreshToken: 'eyJ.refresh.token-value' },
      },
      'request payload',
    );

    const text = log.text();
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain('eyJ.refresh.token-value');
    expect((log.last().body as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
  });

  it('masks the Set-Cookie header of a logged response', () => {
    log.logger.info({ res: { statusCode: 200, headers: { 'set-cookie': 'sid=topsecretvalue' } } }, 'response');

    expect(log.text()).not.toContain('topsecretvalue');
  });

  it.each(['password', 'refreshToken', 'accessToken', 'secret', 'signingSecret', 'apiKey', 'authorization'])(
    'masks the "%s" field wherever it appears',
    (field) => {
      log.logger.info({ payload: { nested: { [field]: 'plain-secret-value-123' } } }, 'echo');

      expect(log.text()).not.toContain('plain-secret-value-123');
      expect(
        ((log.last().payload as Record<string, unknown>).nested as Record<string, unknown>)[field],
      ).toBe('[REDACTED]');
    },
  );

  it('masks a bearer token embedded in an error message', () => {
    log.logger.error(new Error(`upstream rejected Authorization: Bearer ${BEARER}`));

    expect(log.text()).not.toContain(BEARER);
    expect(log.text()).toContain('[REDACTED]');
  });

  it('masks a bearer token inside the free-text log message', () => {
    log.logger.warn(`retrying with token Bearer ${BEARER} after 401`);

    expect(log.text()).not.toContain(BEARER);
  });

  it('masks JWT-shaped and webhook-secret-shaped strings under innocuous keys', () => {
    log.logger.info({ detail: `got ${BEARER} and ${SIGNING_SECRET}` }, 'free text');

    expect(log.text()).not.toContain(BEARER);
    expect(log.text()).not.toContain(SIGNING_SECRET);
  });

  it('masks the plaintext API key echoed by a DTO but keeps its public prefix readable', () => {
    log.logger.info({ created: { id: 'key-1', prefix: API_KEY.slice(0, 14), key: API_KEY } }, 'api key created');

    const created = log.last().created as Record<string, unknown>;
    expect(created.key).toBe('[REDACTED]');
    expect(created.prefix).toBe(API_KEY.slice(0, 14));
    expect(log.text()).not.toContain(API_KEY);
  });

  it('masks an API key that appears in free text', () => {
    log.logger.error(`failed to authenticate key ${API_KEY} from 203.0.113.7`);

    expect(log.text()).not.toContain(API_KEY);
    expect(log.text()).toContain('203.0.113.7');
  });

  it('leaves request id, method, path, status and latency readable', () => {
    log.logger.info(
      {
        requestId: 'req-42',
        method: 'GET',
        path: '/api/v1/agents',
        statusCode: 200,
        durationMs: 12.5,
      },
      'HTTP request completed',
    );

    expect(log.last()).toMatchObject({
      requestId: 'req-42',
      method: 'GET',
      path: '/api/v1/agents',
      statusCode: 200,
      durationMs: 12.5,
      msg: 'HTTP request completed',
    });
  });
});
