import { getQueueToken } from '@nestjs/bullmq';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  INestApplication,
  Injectable,
  Post,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../common/context/request-context';
import { RequestContextInterceptor } from '../common/interceptors/request-context.interceptor';
import { DomainEventName } from '../events/event-names';
import { RiskService } from '../modules/risk/risk.service';
import { RiskAnalysisJobData } from '../modules/risk/risk.types';
import { WebhookDeliveryService } from '../modules/webhooks/services/webhook-delivery.service';
import { WebhookJobData } from '../modules/webhooks/types/webhook-job.types';
import { Queues } from './queues.constants';

const webhookJob: WebhookJobData = {
  webhookId: 'wh-1',
  organizationId: 'org-1',
  url: 'https://example.test/hook',
  eventName: 'transaction.created',
  payload: { transactionId: 'tx-1' },
  eventId: 'evt-1',
};

/** Stands in for the JWT guard: attaches an API-key principal to every request. */
@Injectable()
class FakeApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: unknown }>();
    request.user = {
      id: 'user-1',
      organizationId: 'org-1',
      role: 'ADMIN',
      isApiKey: true,
      apiKeyId: 'key-1',
    };
    return true;
  }
}

/** A controller whose action enqueues a webhook job, as the real ones do through the service. */
@Controller('hooks')
class EnqueueController {
  constructor(private readonly deliveries: WebhookDeliveryService) {}

  @Post()
  async enqueue() {
    await this.deliveries.queueDelivery({ ...webhookJob });
    return { queued: true };
  }
}

describe('webhook delivery producer', () => {
  const add = vi.fn();
  const service = new WebhookDeliveryService({ add } as never);

  beforeEach(() => add.mockReset().mockResolvedValue(undefined));

  it('stamps the request id, correlation fields, actor and API key id of the running request', async () => {
    await RequestContext.run(
      {
        identity: {
          requestId: 'req-web',
          correlationId: 'corr-web',
          traceId: 'trace-web',
          method: 'POST',
          path: '/x',
          url: '/x',
          ip: null,
          userAgent: null,
          startedAt: Date.now(),
        },
        principal: { userId: 'user-9', apiKeyId: 'key-9', authMethod: 'api-key' },
        timings: {},
        data: {},
      },
      () => service.queueDelivery({ ...webhookJob }),
    );

    const [, data] = add.mock.calls[0] as [string, WebhookJobData];
    expect(data.metadata).toEqual({
      requestId: 'req-web',
      correlationId: 'corr-web',
      traceId: 'trace-web',
      actorId: 'user-9',
      apiKeyId: 'key-9',
    });
  });

  it('still enqueues a job outside any request, without an actor or API key', async () => {
    await service.queueDelivery({ ...webhookJob });

    const [, data] = add.mock.calls[0] as [string, WebhookJobData];
    expect(data.metadata).not.toHaveProperty('actorId');
    expect(data.metadata).not.toHaveProperty('apiKeyId');
    expect(data.webhookId).toBe('wh-1');
  });

  it('keeps correlation fields the caller passed in', async () => {
    await service.queueDelivery({
      ...webhookJob,
      metadata: { requestId: 'req-given', actorId: 'actor-given' },
    });

    const [, data] = add.mock.calls[0] as [string, WebhookJobData];
    expect(data.metadata).toMatchObject({ requestId: 'req-given', actorId: 'actor-given' });
  });
});

describe('risk analysis producer', () => {
  const add = vi.fn();
  // RiskService de-duplicates events by transaction and timestamp, so every test
  // gets its own instance.
  let service: RiskService;

  const envelope = (overrides: Record<string, unknown> = {}) =>
    ({
      name: DomainEventName.TransactionCreated,
      aggregateType: 'transaction',
      organizationId: 'org-1',
      payload: { transactionId: 'tx-1', amount: '10', asset: 'XLM' },
      occurredAt: new Date('2026-11-22T10:00:00.000Z'),
      ...overrides,
    }) as Parameters<RiskService['handleTransactionCreated']>[0];

  beforeEach(() => {
    add.mockReset().mockResolvedValue(undefined);
    service = new RiskService({} as never, {} as never, {} as never, { add } as never);
  });

  it('carries the correlation fields of the domain event into the job', async () => {
    await service.handleTransactionCreated(
      envelope({ actorId: 'user-1', requestId: 'req-ev', correlationId: 'corr-ev' }),
    );

    const [name, data, options] = add.mock.calls[0] as [string, RiskAnalysisJobData, { jobId: string }];
    expect(name).toBe('risk-evaluation');
    expect(options).toEqual({ jobId: 'risk-tx-1' });
    expect(data).toMatchObject({ organizationId: 'org-1', transactionId: 'tx-1', actorId: 'user-1' });
    expect(data.metadata).toEqual({ requestId: 'req-ev', correlationId: 'corr-ev', actorId: 'user-1' });
  });

  it('reads the ids from the event metadata block too', async () => {
    await service.handleTransactionCreated(
      envelope({ metadata: { requestId: 'req-meta', correlationId: 'corr-meta', traceId: 'trace-meta' } }),
    );

    const [, data] = add.mock.calls[0] as [string, RiskAnalysisJobData];
    expect(data.metadata).toEqual({ requestId: 'req-meta', correlationId: 'corr-meta', traceId: 'trace-meta' });
  });

  it('falls back to the running request when the event carries no ids', async () => {
    await RequestContext.run(
      {
        identity: {
          requestId: 'req-ambient',
          correlationId: 'corr-ambient',
          traceId: 'trace-ambient',
          method: 'POST',
          path: '/x',
          url: '/x',
          ip: null,
          userAgent: null,
          startedAt: Date.now(),
        },
        principal: { userId: 'user-ambient', apiKeyId: 'key-ambient' },
        timings: {},
        data: {},
      },
      () => service.handleTransactionCreated(envelope()),
    );

    const [, data] = add.mock.calls[0] as [string, RiskAnalysisJobData];
    expect(data.metadata).toMatchObject({
      requestId: 'req-ambient',
      actorId: 'user-ambient',
      apiKeyId: 'key-ambient',
    });
  });

  it('prefers the event over the running request', async () => {
    await RequestContext.run(
      {
        identity: {
          requestId: 'req-ambient',
          correlationId: 'corr-ambient',
          traceId: 'trace-ambient',
          method: 'POST',
          path: '/x',
          url: '/x',
          ip: null,
          userAgent: null,
          startedAt: Date.now(),
        },
        timings: {},
        data: {},
      },
      () => service.handleTransactionCreated(envelope({ requestId: 'req-ev' })),
    );

    const [, data] = add.mock.calls[0] as [string, RiskAnalysisJobData];
    expect(data.metadata?.requestId).toBe('req-ev');
  });

  it('enqueues exactly the payload it always did when there is no correlation context', async () => {
    await service.handleTransactionCreated(envelope());

    const [, data] = add.mock.calls[0] as [string, RiskAnalysisJobData];
    expect(data).not.toHaveProperty('metadata');
    expect(Object.keys(data).sort()).toEqual(['actorId', 'input', 'organizationId', 'transactionId']);
  });
});

/**
 * From a controller call to the enqueued job: real routing, the request-context
 * interceptor that every API request goes through, a controller, the producer
 * service and the queue it adds to.
 */
describe('controller call to enqueued job payload', () => {
  let app: INestApplication;
  let baseUrl: string;
  const add = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EnqueueController],
      providers: [
        WebhookDeliveryService,
        { provide: getQueueToken(Queues.Webhooks), useValue: { add } },
        { provide: APP_GUARD, useClass: FakeApiKeyGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => add.mockReset().mockResolvedValue(undefined));

  it('puts the caller’s request id, actor and API key id into the job', async () => {
    const res = await fetch(`${baseUrl}/hooks`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-from-client-1', 'x-correlation-id': 'corr-from-client-1' },
    });

    expect(res.status).toBe(201);
    expect(add).toHaveBeenCalledTimes(1);
    const [, data] = add.mock.calls[0] as [string, WebhookJobData];
    expect(data.metadata).toEqual({
      requestId: 'req-from-client-1',
      correlationId: 'corr-from-client-1',
      traceId: 'corr-from-client-1',
      actorId: 'user-1',
      apiKeyId: 'key-1',
    });
  });

  it('keeps simultaneous requests apart', async () => {
    await Promise.all(
      ['req-aaa-1', 'req-bbb-2', 'req-ccc-3'].map((id) =>
        fetch(`${baseUrl}/hooks`, { method: 'POST', headers: { 'x-request-id': id } }),
      ),
    );

    const ids = add.mock.calls.map(([, data]) => (data as WebhookJobData).metadata?.requestId).sort();
    expect(ids).toEqual(['req-aaa-1', 'req-bbb-2', 'req-ccc-3']);
  });

  it('never stores credentials in the job metadata', async () => {
    await fetch(`${baseUrl}/hooks`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-secret-check', authorization: 'Bearer eyJ.secret.token', 'x-api-key': 'ak_live_secret' },
    });

    const [, data] = add.mock.calls[0] as [string, WebhookJobData];
    expect(Object.keys(data.metadata ?? {}).sort()).toEqual(
      ['actorId', 'apiKeyId', 'correlationId', 'requestId', 'traceId'].sort(),
    );
    expect(JSON.stringify(data.metadata)).not.toMatch(/Bearer|ak_live_secret|eyJ/);
  });
});
