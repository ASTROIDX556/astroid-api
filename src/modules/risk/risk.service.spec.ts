import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskFactorsInput } from './risk.types';

describe('RiskService Event Handler', () => {
  let riskService: RiskService;
  let riskEngine: RiskEngine;
  let riskRepository: RiskRepository;
  let eventBusService: EventBusService;

  beforeEach(() => {
    riskEngine = new RiskEngine();
    riskRepository = {
      createAssessmentRecord: vi.fn().mockResolvedValue({ id: 'assessment-1' }),
      findByOrganization: vi.fn().mockResolvedValue([]),
      findByTransaction: vi.fn().mockResolvedValue(null),
    } as unknown as RiskRepository;

    eventBusService = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBusService;

    riskService = new RiskService(riskEngine, eventBusService, riskRepository);
    });

  it('should evaluate and persist risk assessment upon handling transaction created event', async () => {
    const envelope = {
      name: DomainEventName.TransactionCreated,
      organizationId: 'org-1',
      aggregateType: 'transaction',
      aggregateId: 'tx-123',
      actorId: 'agent-1',
      payload: {
        transactionId: 'tx-123',
        walletId: 'wallet-1',
        amount: '150.0',
        asset: 'XLM',
      },
      occurredAt: new Date(),
    };

    await riskService.handleTransactionCreated(envelope);

    expect(eventBusService.emit).toHaveBeenCalledWith(
      DomainEventName.RiskEvaluated,
      expect.objectContaining({
        transactionId: 'tx-123',
      }),
      expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'agent-1',
        aggregateType: 'transaction',
        aggregateId: 'tx-123',
      }),
    );

    expect(riskRepository.createAssessmentRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        transactionId: 'tx-123',
      }),
    );
  });

  it('should deduplicate concurrent or repeated event deliveries', async () => {
    const timestamp = new Date();
    const envelope = {
      name: DomainEventName.TransactionCreated,
      organizationId: 'org-1',
      aggregateType: 'transaction',
      aggregateId: 'tx-dup',
      payload: {
        transactionId: 'tx-dup',
        amount: '50.0',
      },
      occurredAt: timestamp,
    };

    await riskService.handleTransactionCreated(envelope);
    await riskService.handleTransactionCreated(envelope);

    expect(riskRepository.createAssessmentRecord).toHaveBeenCalledTimes(1);
  });

  it('should handle failure resilience gracefully when evaluation throws', async () => {
    vi.spyOn(riskRepository, 'createAssessmentRecord').mockRejectedValueOnce(new Error('DB connection failed'));
    const envelope = {
      name: DomainEventName.TransactionCreated,
      organizationId: 'org-1',
      aggregateType: 'transaction',
      aggregateId: 'tx-err',
      payload: {
        transactionId: 'tx-err',
        amount: '100.0',
      },
      occurredAt: new Date(),
    };

    await expect(riskService.handleTransactionCreated(envelope)).rejects.toThrow('DB connection failed');
  });
});


const lowRisk: RiskFactorsInput = {
  amount: 20,
  asset: 'USDC',
  knownRecipient: true,
  recentTransactionCount: 1,
  walletAgeDays: 365,
  policyViolations: 0,
  hourUtc: 12,
};

function createEventBus() {
  return { emit: vi.fn().mockResolvedValue(undefined) } as unknown as Pick<EventBusService, 'emit'> & { emit: ReturnType<typeof vi.fn> };
}
