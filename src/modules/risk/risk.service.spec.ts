import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskFactorsInput } from './risk.types';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskRepository } from './risk.repository';

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

describe('RiskService', () => {
  it('emits a RiskEvaluated event with full factor breakdown', async () => {
    const eventBus = createEventBus();
    const repository = { createAssessmentRecord: vi.fn().mockResolvedValue(undefined) } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = await service.evaluate('org-1', lowRisk, {
      transactionId: 'tx-1',
      actorId: 'agent-1',
    });

    expect(assessment.band).toBe(RiskBand.LOW);
    expect(assessment.factors.length).toBe(6);

    const emitMock = eventBus.emit as ReturnType<typeof vi.fn>;
    expect(emitMock).toHaveBeenCalledOnce();
    const [eventName, payload] = emitMock.mock.calls[0];
    expect(eventName).toBe('risk.evaluated');
    expect(payload.transactionId).toBe('tx-1');
    expect(payload.score).toBe(assessment.score);
    expect(payload.band).toBe(RiskBand.LOW);
    expect(payload.factors).toEqual(assessment.factors);
    expect(payload.canAutoExecute).toBe(true);
  });

  it('assess() returns a result without emitting events', async () => {
    const eventBus = createEventBus();
    const repository = { createAssessmentRecord: vi.fn().mockResolvedValue(undefined) } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = service.assess(lowRisk);
    expect(assessment.band).toBe(RiskBand.LOW);
    const emitMock = eventBus.emit as ReturnType<typeof vi.fn>;
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('passes config overrides through to the engine', async () => {
    const eventBus = createEventBus();
    const repository = { createAssessmentRecord: vi.fn().mockResolvedValue(undefined) } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = service.assess(
      { ...lowRisk, amount: 100 },
      { amountSaturation: 100 },
    );
    const amountFactor = assessment.factors.find((f) => f.factor === 'amount');
    expect(amountFactor!.contribution).toBe(30);
  });
});

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
