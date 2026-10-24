import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication, Logger, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { PROBLEM_JSON_CONTENT_TYPE } from '../interfaces/api-response.interface';

/**
 * Verifies over real HTTP that failures raised outside Nest's request pipeline —
 * body-parser rejecting malformed JSON or an oversized payload, for example —
 * are rendered by `AllExceptionsFilter` with the same RFC 9457 problem details
 * envelope as application errors, instead of Express's default error page.
 */
@Controller('items')
class ItemsController {
  @Post()
  create(): { ok: boolean } {
    return { ok: true };
  }

  @Get()
  list(): { ok: boolean } {
    return { ok: true };
  }
}

const PROBLEM_KEYS = [
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'requestId',
  'timestamp',
];

describe('External error responses (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ItemsController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  function expectProblem(res: Response, body: Record<string, unknown>, status: number): void {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    for (const key of PROBLEM_KEYS) {
      expect(body).toHaveProperty(key);
    }
    expect(body.status).toBe(status);
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('stack');
  }

  it('renders malformed JSON bodies with the problem details envelope', async () => {
    const res = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-body-parser-1' },
      body: '{"name": "wallet", }',
    });
    const body = (await res.json()) as Record<string, unknown>;

    expectProblem(res, body, 400);
    expect(body).toMatchObject({
      type: 'urn:astroid:problem:bad-request',
      title: 'Bad Request',
      instance: '/api/v1/items',
      code: 'BAD_REQUEST',
      requestId: 'req-body-parser-1',
    });
  });

  it('renders oversized payloads as a 413 problem rather than a 500', async () => {
    const res = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wallet', padding: 'x'.repeat(200_000) }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expectProblem(res, body, 413);
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Payload Too Large',
      detail: 'Request body is too large',
    });
  });

  it('still serves successful requests normally', async () => {
    const res = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wallet' }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });
});
