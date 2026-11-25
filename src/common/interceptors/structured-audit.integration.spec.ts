import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventEmitter2 } from 'eventemitter2';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';

import { StructuredAuditInterceptor } from './structured-audit.interceptor';
import { EventBusService } from '../../events/event-bus.service';
import { TypedEventEmitter } from '../../events/typed-event-emitter.service';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditRecordedListener } from '../../modules/audit/audit-recorded.listener';
import { PrismaService } from '../../database/prisma.service';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator';

/**
 * End-to-end proof of the audit pipeline:
 * `StructuredAuditInterceptor` -> `EventBusService` -> `@nestjs/event-emitter`
 * -> `AuditRecordedListener` -> `AuditService.record`.
 */
describe('Structured audit pipeline (integration)', () => {
  let emitter: EventEmitter2;
  let auditService: { record: ReturnType<typeof vi.fn> };
  let eventBus: EventBusService;
  let domainEventCreate: ReturnType<typeof vi.fn>;

  const request = {
    method: 'POST',
    path: '/api/v1/developers/keys/key-1/rotate',
    originalUrl: '/api/v1/developers/keys/key-1/rotate',
    url: '/api/v1/developers/keys/key-1/rotate',
    body: { name: 'rotated-key', secret: 'never-log-me' },
    params: { id: 'key-1' },
    query: {},
    headers: { 'user-agent': 'TestAgent/1.0' },
    ip: '127.0.0.1',
    user: { id: 'user-1', organizationId: 'org-1' },
  };

  beforeAll(async () => {
    auditService = { record: vi.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot({
          wildcard: true,
          delimiter: '.',
          maxListeners: 50,
          verboseMemoryLeak: false,
        }),
      ],
      providers: [AuditRecordedListener, { provide: AuditService, useValue: auditService }],
    }).compile();
    await moduleRef.init();
    emitter = moduleRef.get(EventEmitter2);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    domainEventCreate = vi.fn().mockResolvedValue({});
    eventBus = new EventBusService(
      { domainEvent: { create: domainEventCreate } } as unknown as PrismaService,
      new TypedEventEmitter(emitter),
    );
  });

  function buildInterceptor(): StructuredAuditInterceptor {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(((key: string) => {
      if (key === AUDIT_ACTION_KEY) return { action: 'AGENT_KEY_ROTATED', entity: 'ApiKey' };
      return undefined;
    }) as never);
    return new StructuredAuditInterceptor(reflector, eventBus);
  }

  function buildContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 200 }),
      }),
      getHandler: () => vi.fn(),
      getClass: () => class ApiKeyController {},
    } as unknown as ExecutionContext;
  }

  it('writes the audit row through the event bus without leaking secrets', async () => {
    const interceptor = buildInterceptor();
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await interceptor.intercept(buildContext(), next).toPromise();
    // The publication is asynchronous: let the event loop settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(domainEventCreate).toHaveBeenCalledTimes(1);
    expect(domainEventCreate.mock.calls[0][0].data.name).toBe('audit.recorded');

    expect(auditService.record).toHaveBeenCalledTimes(1);
    const recorded = auditService.record.mock.calls[0][0];
    expect(recorded).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'AGENT_KEY_ROTATED',
        entity: 'ApiKey',
        entityId: 'key-1',
        ipAddress: '127.0.0.1',
        newValue: expect.objectContaining({
          method: 'POST',
          url: '/api/v1/developers/keys/key-1/rotate',
          statusCode: 200,
          success: true,
        }),
      }),
    );

    // The secret never reaches the audit trail.
    expect(JSON.stringify(recorded)).not.toContain('never-log-me');
  });
});
