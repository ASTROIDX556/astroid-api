import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { AstroidThrottlerGuard } from './throttler.guard';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { RedisThrottlerStorage } from '../throttler/redis-throttler.storage';

/**
 * The app runs on Express (no Fastify `app.inject`), so bursts are driven over
 * real HTTP. The Redis client is a stand-in whose `eval` reproduces the
 * throttler storage script's contract
 * (`[totalHits, timeToExpire, isBlocked, timeToBlockExpire]`) on top of a
 * fixed-window counter, exercising the Redis-backed storage code path end to
 * end — mirroring how `AppModule` wires `RedisThrottlerStorage` through
 * `ThrottlerModule.forRootAsync`.
 */

const LIMIT = 2;
const WINDOW_SECONDS = 60;

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
  let hits: number;

  beforeAll(async () => {
    hits = 0;
    const fakeRedis = {
      status: 'ready',
      eval: vi.fn(async () => {
        hits += 1;
        // [totalHits, timeToExpire, isBlocked, timeToBlockExpire]
        return [hits, WINDOW_SECONDS, hits > LIMIT ? 1 : 0, hits > LIMIT ? WINDOW_SECONDS : 0];
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'api', ttl: WINDOW_SECONDS * 1000, limit: LIMIT }],
        }),
      ],
      controllers: [TestSensitiveController],
      providers: [
        {
          provide: REDIS_CLIENT,
          useValue: fakeRedis,
        },
        {
          provide: ThrottlerStorage,
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
