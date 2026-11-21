import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, from, lastValueFrom } from 'rxjs';

import { IDEMPOTENCY_REPLAYED_HEADER } from '../constants/headers';
import { DomainException } from '../exceptions/domain.exception';
import {
  IdempotencyIdentity,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyReservationInput,
  IdempotencyStore,
  StoredIdempotentResponse,
} from './idempotency-store';
import { hashRequestBody, IdempotencyInterceptor } from './idempotency.interceptor';

/** Minimal in-memory store with the same unique-key semantics as the DB. */
class InMemoryIdempotencyStore implements IdempotencyStore {
  records = new Map<string, IdempotencyRecord>();
  private nextId = 0;

  async reserve(input: IdempotencyReservationInput): Promise<IdempotencyReservation> {
    const mapKey = identityKey(input);
    const existing = this.records.get(mapKey);
    if (existing && existing.expiresAt.getTime() <= Date.now()) {
      this.records.delete(mapKey);
    } else if (existing) {
      return { created: false, record: existing };
    }
    const record: IdempotencyRecord = {
      id: `record_${(this.nextId += 1)}`,
      requestHash: input.requestHash,
      status: 'PROCESSING',
      response: null,
      expiresAt: input.expiresAt,
    };
    this.records.set(mapKey, record);
    return { created: true, record };
  }

  async find(identity: IdempotencyIdentity): Promise<IdempotencyRecord | null> {
    const record = this.records.get(identityKey(identity));
    if (!record || record.expiresAt.getTime() <= Date.now()) return null;
    return record;
  }

  async complete(
    id: string,
    response: StoredIdempotentResponse,
    expiresAt: Date,
  ): Promise<void> {
    const record = this.findById(id);
    if (record) Object.assign(record, { status: 'COMPLETED', response, expiresAt });
  }

  async release(id: string): Promise<void> {
    for (const [mapKey, record] of this.records) {
      if (record.id === id) this.records.delete(mapKey);
    }
  }

  async deleteExpired(now = new Date()): Promise<number> {
    let deleted = 0;
    for (const [mapKey, record] of this.records) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.records.delete(mapKey);
        deleted += 1;
      }
    }
    return deleted;
  }

  private findById(id: string): IdempotencyRecord | undefined {
    for (const record of this.records.values()) {
      if (record.id === id) return record;
    }
    return undefined;
  }
}

function identityKey(identity: IdempotencyIdentity): string {
  return `${identity.principalId}|${identity.operation}|${identity.keyHash}`;
}

const USER = {
  id: 'user_1',
  organizationId: 'org_1',
  role: 'ADMIN' as never,
};

interface Harness {
  interceptor: IdempotencyInterceptor;
  store: InMemoryIdempotencyStore;
  reflector: Reflector;
  response: { statusCode: number; status: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };
  handler: CallHandler & { handle: ReturnType<typeof vi.fn> };
  context: ExecutionContext;
}

function createHarness(
  options: { ttlMs?: number; required?: boolean; waitForCompletionMs?: number } | undefined,
  body: unknown = { amount: '10' },
  store = new InMemoryIdempotencyStore(),
  headers: Record<string, string> = { 'idempotency-key': 'key-abc' },
): Harness {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  const response = { statusCode: 201, status: vi.fn(), setHeader: vi.fn() };
  const handler = { handle: vi.fn(() => of({ ok: true })) };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers, body, user: USER, method: 'POST', path: '/transactions' }),
      getResponse: () => response,
    }),
    getHandler: () => function create() {},
    getClass: () => class TransactionController {},
  } as unknown as ExecutionContext;
  return {
    interceptor: new IdempotencyInterceptor(reflector, store),
    store,
    reflector,
    response,
    handler,
    context,
  };
}

async function run(harness: Harness) {
  const observable = await harness.interceptor.intercept(harness.context, harness.handler);
  return lastValueFrom(observable);
}

async function expectDomainStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainException);
  expect((error as DomainException).getStatus()).toBe(status);
}

describe('IdempotencyInterceptor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bypasses endpoints without the @Idempotent() decorator', async () => {
    const harness = createHarness(undefined);

    await expect(run(harness)).resolves.toEqual({ ok: true });
    expect(harness.handler.handle).toHaveBeenCalledTimes(1);
    expect(harness.store.records.size).toBe(0);
  });

  it('returns 400 when the guarded endpoint has no Idempotency-Key', async () => {
    const harness = createHarness({}, { amount: '10' }, undefined, {});

    await expectDomainStatus(run(harness), 400);
    expect(harness.handler.handle).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed Idempotency-Key', async () => {
    const harness = createHarness({}, { amount: '10' }, undefined, {
      'idempotency-key': 'not a valid key!',
    });

    await expectDomainStatus(run(harness), 400);
    expect(harness.handler.handle).not.toHaveBeenCalled();
  });

  it('executes the first request once and stores status + body', async () => {
    const harness = createHarness({ ttlMs: 60_000 });

    await expect(run(harness)).resolves.toEqual({ ok: true });
    expect(harness.handler.handle).toHaveBeenCalledTimes(1);
    expect(harness.store.records.size).toBe(1);
    const [record] = harness.store.records.values();
    expect(record.status).toBe('COMPLETED');
    expect(record.response).toEqual({ statusCode: 201, body: { ok: true } });
    expect(record.requestHash).toBe(hashRequestBody({ amount: '10' }));
  });

  it('replays the stored status and body with Idempotency-Replayed: true', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    await run(first);

    const replay = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    await expect(run(replay)).resolves.toEqual({ ok: true });

    expect(replay.handler.handle).not.toHaveBeenCalled();
    expect(replay.response.status).toHaveBeenCalledWith(201);
    expect(replay.response.setHeader).toHaveBeenCalledWith(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    expect(store.records.size).toBe(1);
  });

  it('treats key order differences as the same payload', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = createHarness({ ttlMs: 60_000 }, { a: 1, b: { c: 2, d: 3 } }, store);
    await run(first);

    const replay = createHarness({ ttlMs: 60_000 }, { b: { d: 3, c: 2 }, a: 1 }, store);
    await expect(run(replay)).resolves.toEqual({ ok: true });

    expect(replay.handler.handle).not.toHaveBeenCalled();
    expect(replay.response.setHeader).toHaveBeenCalledWith(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  });

  it('answers 409 and creates no side effect when the payload changed', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    await run(first);

    const conflict = createHarness({ ttlMs: 60_000 }, { amount: '99' }, store);
    await expectDomainStatus(run(conflict), 409);

    expect(conflict.handler.handle).not.toHaveBeenCalled();
    expect(store.records.size).toBe(1);
    const [record] = store.records.values();
    expect(record.response).toEqual({ statusCode: 201, body: { ok: true } });
  });

  it('executes only one of two concurrent duplicates and replays for the loser', async () => {
    const store = new InMemoryIdempotencyStore();
    const options = { ttlMs: 60_000, waitForCompletionMs: 1_000 };

    const execute = async (): Promise<{ body: unknown; replayed: boolean; handled: number }> => {
      const harness = createHarness(options, { amount: '10' }, store);
      const body = await run(harness);
      return {
        body,
        handled: harness.handler.handle.mock.calls.length,
        replayed: harness.response.setHeader.mock.calls.some(
          ([name]) => name === IDEMPOTENCY_REPLAYED_HEADER,
        ),
      };
    };

    const [first, second] = await Promise.all([execute(), execute()]);

    expect(first.handled + second.handled).toBe(1);
    expect(store.records.size).toBe(1);
    expect(first.body).toEqual({ ok: true });
    expect(second.body).toEqual({ ok: true });
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
  });

  it('treats an expired record as absent so the request executes again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = new InMemoryIdempotencyStore();

    const first = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    await run(first);
    expect(first.handler.handle).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    const afterExpiry = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    await expect(run(afterExpiry)).resolves.toEqual({ ok: true });

    expect(afterExpiry.handler.handle).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(1);
  });

  it('releases the reservation when the handler fails so a retry can execute', async () => {
    const store = new InMemoryIdempotencyStore();
    const harness = createHarness({ ttlMs: 60_000 }, { amount: '10' }, store);
    harness.handler.handle = vi.fn(() => from(Promise.reject(new Error('downstream failed'))));

    await expect(run(harness)).rejects.toThrow('downstream failed');
    expect(store.records.size).toBe(0);
  });
});
