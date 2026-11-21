import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';

import { IDEMPOTENT_KEY } from '../../../common/decorators/idempotent.decorator';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../../../common/constants/headers';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { IdempotencyInterceptor } from '../../../common/interceptors/idempotency.interceptor';
import {
  IdempotencyIdentity,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyReservationInput,
  IdempotencyStore,
  StoredIdempotentResponse,
} from '../../../common/interceptors/idempotency-store';
import { TransactionController } from '../transaction.controller';
import { TransactionService } from '../transaction.service';

class FakeStore implements IdempotencyStore {
  records = new Map<string, IdempotencyRecord>();
  private nextId = 0;

  async reserve(input: IdempotencyReservationInput): Promise<IdempotencyReservation> {
    const mapKey = keyOf(input);
    const existing = this.records.get(mapKey);
    if (existing && existing.expiresAt.getTime() <= Date.now()) this.records.delete(mapKey);
    else if (existing) return { created: false, record: existing };
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
    const record = this.records.get(keyOf(identity));
    if (!record || record.expiresAt.getTime() <= Date.now()) return null;
    return record;
  }

  async complete(id: string, response: StoredIdempotentResponse, expiresAt: Date): Promise<void> {
    for (const record of this.records.values()) {
      if (record.id === id) Object.assign(record, { status: 'COMPLETED', response, expiresAt });
    }
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
}

function keyOf(identity: IdempotencyIdentity): string {
  return `${identity.principalId}|${identity.operation}|${identity.keyHash}`;
}

const USER: AuthenticatedUser = {
  id: 'user_1',
  organizationId: 'org_1',
  role: 'ADMIN' as never,
};

const BODY = { agentId: 'agent_1', amount: '10' };

interface ApiResponse {
  statusCode: number;
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  headers: Record<string, string>;
}

describe('POST /transactions idempotency', () => {
  let store: FakeStore;
  let interceptor: IdempotencyInterceptor;
  let responseInterceptor: ResponseInterceptor<unknown>;
  let controller: TransactionController;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new FakeStore();
    const reflector = new Reflector();
    interceptor = new IdempotencyInterceptor(reflector, store);
    responseInterceptor = new ResponseInterceptor<unknown>();
    create = vi.fn().mockResolvedValue({
      transaction: { id: 'tx_1', amount: '10' },
      requiresApproval: false,
      risk: { score: 5 },
    });
    const service = { create } as unknown as TransactionService;
    controller = new TransactionController(service);
  });

  function makeContext(request: Record<string, unknown>, response: ApiResponse): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: () => TransactionController.prototype.create,
      getClass: () => TransactionController,
    } as unknown as ExecutionContext;
  }

  function makeResponse(): ApiResponse {
    const headers: Record<string, string> = {};
    return {
      statusCode: 201,
      headers,
      status: vi.fn(),
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    };
  }

  /** Runs the real route-level idempotency interceptor + global envelope. */
  async function submit(idempotencyKey: string, requestId: string, body = BODY) {
    const request = {
      headers: { 'idempotency-key': idempotencyKey, 'x-request-id': requestId },
      body,
      user: USER,
      method: 'POST',
      path: '/transactions',
    };
    const response = makeResponse();
    const context = makeContext(request, response);
    const handler: CallHandler<unknown> = {
      handle: () => from(controller.create(USER, body as never)),
    };

    const idempotent$ = (await interceptor.intercept(context, handler)) as Observable<unknown>;
    const envelope$ = responseInterceptor.intercept(context, { handle: () => idempotent$ });
    return { body: await lastValueFrom(envelope$), response };
  }

  it('is guarded by the @Idempotent() decorator', () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_KEY, TransactionController.prototype.create),
    ).toBeDefined();
  });

  it('enqueues one transaction, stores one record and replays identical data', async () => {
    const first = await submit('order-42', 'req_1');
    const second = await submit('order-42', 'req_2');

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(1);

    expect(first.body).toMatchObject({
      success: true,
      data: { transaction: { id: 'tx_1', amount: '10' }, requiresApproval: false },
      meta: {},
      requestId: 'req_1',
    });
    expect(second.body).toMatchObject({
      success: true,
      data: (first.body as { data: unknown }).data,
      meta: {},
      requestId: 'req_2',
    });
    expect(second.response.status).toHaveBeenCalledWith(201);
    expect(second.response.statusCode).toBe(201);
    expect(second.response.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(first.response.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
  });

  it('answers 409 without enqueuing when the same key carries a different body', async () => {
    await submit('order-42', 'req_1');

    const error: unknown = await submit('order-42', 'req_2', { ...BODY, amount: '99' }).catch(
      (reason: unknown) => reason,
    );
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(1);
  });
});
