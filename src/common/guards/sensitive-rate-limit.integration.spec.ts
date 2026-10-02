import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication, Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AstroidThrottlerGuard } from './throttler.guard';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';
import { RedisThrottlerStorage } from '../throttler/redis-throttler.storage';
import type { Redis } from 'ioredis';

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
  let baseUrl: string;

  beforeAll(async () => {
    const store = new MemorySlidingWindowStore();
    const fakeRedis = {
      status: 'ready',
      eval: vi.fn(async (_script: string, _keys: number, key: string, now: number, windowMs: number, limit: number) => {
        const hit = await store.hit(key, limit, windowMs, now);
        return [hit.allowed ? 1 : 0, hit.count, hit.resetAt, 0];
      }),
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

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const send = () =>
    fetch(`${baseUrl}/test-sensitive/action`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key-123' },
    });

  it('enforces rate limit and returns 429 when threshold is exceeded', async () => {
    const res1 = await send();
    expect(res1.status).toBe(201);

    const res2 = await send();
    expect(res2.status).toBe(201);

    const res3 = await send();
    expect(res3.status).toBe(429);
  });
});
