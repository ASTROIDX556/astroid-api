import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventBusService } from '../../events/event-bus.service';
import { TypedEventEmitter } from '../../events/typed-event-emitter.service';
import { DOMAIN_EVENT_ENVELOPE, DomainEventEnvelope } from '../../events/domain-event.types';
import { DomainEventName } from '../../events/event-names';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListener } from './audit.listener';
import { PrismaService } from '../../database/prisma.service';

/**
 * Wiring integration: the shared event bus emits a domain event, the wildcard
 * AuditListener persists a structured entry, and AuditService.list returns the
 * row with its filters applied. No database is involved — the repository and
 * Prisma client are stand-ins.
 */
describe('Audit event wiring (integration)', () => {
  const orgId = 'org-1';
  let eventBus: EventBusService;
  let auditRepository: {
    createChained: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
  };
  let auditService: AuditService;

  beforeEach(() => {
    auditRepository = {
      createChained: vi.fn(
        async (
          data: Record<string, unknown>,
          computeHash: (id: string, prevHash: string | null, createdAt: Date) => string,
        ) => ({
          id: 'audit-row-1',
          createdAt: new Date(),
          ...data,
          hash: computeHash('audit-row-1', null, new Date()),
        }),
      ),
      findManyAndCount: vi.fn().mockResolvedValue({
        items: [{ id: 'audit-row-1', organizationId: orgId, action: 'transaction.completed' }],
        total: 1,
      }),
    };
    const prisma = { domainEvent: { create: vi.fn().mockResolvedValue({}) } } as unknown as PrismaService;
    const emitter = new EventEmitter2({ wildcard: true });
    const typedEmitter = new TypedEventEmitter(emitter);
    eventBus = new EventBusService(prisma, typedEmitter);
    auditService = new AuditService(
      auditRepository as unknown as AuditRepository,
      new AuditHashService(prisma),
    );

    // Registration replicates what EventEmitterModule performs on app boot.
    const auditListener = new AuditListener(auditService);
    emitter.on(DOMAIN_EVENT_ENVELOPE, (envelope: DomainEventEnvelope) =>
      auditListener.handleDomainEvent(envelope),
    );
  });

  it('persists an audit row when a transaction event is emitted, and returns it filtered', async () => {
    await eventBus.emit(
      DomainEventName.TransactionCompleted,
      { transactionId: 'tx-1', stellarHash: 'abc123' },
      {
        organizationId: orgId,
        aggregateType: 'transaction',
        aggregateId: 'tx-1',
        actorId: 'user-1',
      },
    );

    // The wildcard AuditListener persisted the entry via AuditService.record.
    expect(auditRepository.createChained).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        userId: 'user-1',
        action: 'transaction.completed',
        entity: 'transaction',
        entityId: 'tx-1',
      }),
      expect.any(Function),
    );

    // The list endpoint surfaces the row with its filters applied.
    const listed = (await auditService.list(orgId, { action: 'transaction.completed' })) as {
      items: unknown[];
    };
    expect(auditRepository.findManyAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: orgId, action: 'transaction.completed' }),
      expect.objectContaining({ take: 20 }),
    );
    expect(listed.items).toHaveLength(1);
  });
});
