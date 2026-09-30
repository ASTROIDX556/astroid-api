import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication, Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import * as http from 'node:http';
import { AstroidThrottlerGuard } from './throttler.guard';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';
import { RedisThrottlerStorage } from '../throttler/redis-throttler.storage';

/** Minimal POST helper over the app's underlying http.Server (no supertest dependency). */
function post(
  server: http.Server,
  path: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-length': '0', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

@Controller('test-sensitive')
class TestSensitiveController {
  @Post('action')
  @UseGuards(AstroidThrottlerGuard)
  action() {
    return { success: true };
  }
}

describe('Sensitive Endpoint Rate Limiting (Integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const store = new MemorySlidingWindowStore();
    const fakeRedis = {
      status: 'ready',
      eval: vi.fn(
        async (
          _script: string,
          _keys: number,
          key: string,
          now: number,
          windowMs: number,
          limit: number,
        ) => {
          const hit = await store.hit(key, limit, windowMs, now);
          return [hit.allowed ? 1 : 0, hit.count, hit.resetAt, 0];
        },
      ),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'api', ttl: 60000, limit: 2 }],
        }),
      ],
      controllers: [TestSensitiveController],
      providers: [
        {
          provide: REDIS_CLIENT,
          useValue: fakeRedis,
        },
        {
          provide: 'ThrottlerStorage',
          useFactory: (redisClient: Redis) => new RedisThrottlerStorage(redisClient),
          inject: [REDIS_CLIENT],
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces rate limit and returns 429 when threshold is exceeded', async () => {
    const server = app.getHttpServer() as http.Server;
    const headers = { 'x-api-key': 'test-key-123' };

    const res1 = await post(server, '/test-sensitive/action', headers);
    expect(res1.statusCode).toBe(201);

    const res2 = await post(server, '/test-sensitive/action', headers);
    expect(res2.statusCode).toBe(201);

    const res3 = await post(server, '/test-sensitive/action', headers);
    expect(res3.statusCode).toBe(429);
  });
});
