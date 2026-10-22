import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeadLetterController } from './dead-letter.controller';
import { DeadLetterService } from './dead-letter.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';

vi.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Queue: vi.fn().mockImplementation((name: string) => ({ name, close: vi.fn(async () => undefined) })),
  QueueEvents: vi.fn().mockImplementation((name: string) => ({
    name,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

const ROWS = Array.from({ length: 65 }, (_, index) => ({
  id: `evt-${index + 1}`,
  name: 'job.failed',
  aggregateId: `job-${index + 1}`,
  payload: { queue: 'webhooks' },
  occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 65 - index)),
}));

function buildPrisma() {
  const sorted = () => [...ROWS].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return {
    domainEvent: {
      findMany: vi.fn(async ({ skip = 0, take = 50 }: { skip?: number; take?: number }) =>
        sorted().slice(skip, skip + take),
      ),
      count: vi.fn(async () => ROWS.length),
    },
  };
}

type ListBody = {
  success: boolean;
  data: { id: string }[];
  meta: Record<string, unknown>;
};

describe('Dead-letter list pagination (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = buildPrisma();
    const service = new DeadLetterService(prisma as never);
    const moduleRef = await Test.createTestingModule({
      controllers: [DeadLetterController],
      providers: [{ provide: DeadLetterService, useValue: service }],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { organizationId: 'org-1' };
      next();
    });
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/admin/dead-letter`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function get(query = '') {
    const res = await fetch(`${baseUrl}${query}`);
    return { res, body: (await res.json()) as ListBody };
  }

  it('returns the default first page with total metadata and header', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-total-count')).toBe('65');
    expect(body.data).toHaveLength(50);
    expect(body.data[0].id).toBe('evt-1');
    expect(body.meta).toEqual({
      offset: 0,
      page: 1,
      limit: 50,
      total: 65,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });
  });

  it('returns the requested offset/limit slice', async () => {
    const { res, body } = await get('?offset=60&limit=10');

    expect(res.status).toBe(200);
    expect(body.data.map((row) => row.id)).toEqual([
      'evt-61', 'evt-62', 'evt-63', 'evt-64', 'evt-65',
    ]);
    expect(body.meta).toMatchObject({ offset: 60, limit: 10, hasPrev: true, hasNext: false });
  });

  it('returns an empty slice past the end instead of failing', async () => {
    const { res, body } = await get('?offset=500');

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(res.headers.get('x-total-count')).toBe('65');
  });

  it.each([
    ['limit above the cap', '?limit=201'],
    ['negative offset', '?offset=-1'],
    ['offset and page together', '?offset=10&page=2'],
  ])('rejects a %s with 400 Bad Request', async (_label, query) => {
    const { res } = await get(query);

    expect(res.status).toBe(400);
    expect(res.headers.get('x-total-count')).toBeNull();
  });
});
