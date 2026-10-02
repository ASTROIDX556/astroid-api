import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainEventName } from '../../events/event-names';
import { VelocityLimitExceededException } from '../../common/exceptions/domain.exception';
import { PolicyService } from './policy.service';

describe('PolicyService daily velocity limit', () => {
  let service: PolicyService;
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let transaction: { findMany: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    transaction = { findMany: vi.fn().mockResolvedValue([{ amount: '7' }]) };
    const repository = {
      findActiveForEvaluation: vi.fn().mockResolvedValue([
        { organizationId: 'org-1', configuration: { dailyLimit: 10 } },
      ]),
    };
    service = new PolicyService(
      repository as never,
      {} as never,
      eventBus as never,
      { transaction } as never,
    );
  });

  it('allows spend exactly at the daily limit using the UTC day boundary', async () => {
    await expect(service.checkVelocityLimit('org-1', 'agent-1', 3, 'XLM')).resolves.toBeUndefined();

    const query = transaction.findMany.mock.calls[0][0] as {
      where: { createdAt: { gte: Date } };
    };
    expect(query.where.createdAt.gte.getUTCHours()).toBe(0);
    expect(query.where.createdAt.gte.getUTCMinutes()).toBe(0);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('emits an audit-capable policy violation before rejecting over-limit spend', async () => {
    await expect(
      service.checkVelocityLimit('org-1', 'agent-1', 4, 'XLM', 'user-1'),
    ).rejects.toBeInstanceOf(VelocityLimitExceededException);

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.PolicyViolated,
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'DAILY_LIMIT_EXCEEDED' })],
      }),
      expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'user-1',
        aggregateId: 'agent-1',
      }),
    );
  });
});