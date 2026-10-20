import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskFactorsInput } from './risk.types';

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
  return {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pick<EventBusService, 'emit'> & { emit: ReturnType<typeof vi.fn> };
}

describe('RiskService', () => {
  it('emits a RiskEvaluated event with the factor breakdown', async () => {
    const eventBus = createEventBus();
    const repository = {
      createAssessmentRecord: vi.fn().mockResolvedValue(undefined),
    } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = await service.evaluate('org-1', lowRisk, {
      transactionId: 'tx-1',
      actorId: 'agent-1',
    });

    const [eventName, payload] = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(eventBus.emit).toHaveBeenCalledOnce();
    expect(eventName).toBe(DomainEventName.RiskEvaluated);
    expect(payload).toMatchObject({
      transactionId: 'tx-1',
      score: assessment.score,
      band: RiskBand.LOW,
      factors: assessment.factors,
      canAutoExecute: true,
    });
  });

  it('assess() returns a result without emitting events', () => {
    const eventBus = createEventBus();
    const repository = {
      createAssessmentRecord: vi.fn().mockResolvedValue(undefined),
    } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    expect(service.assess(lowRisk).band).toBe(RiskBand.LOW);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('passes config overrides through to the engine', () => {
    const eventBus = createEventBus();
    const repository = {
      createAssessmentRecord: vi.fn().mockResolvedValue(undefined),
    } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = service.assess({ ...lowRisk, amount: 100 }, { amountSaturation: 100 });
    const amountFactor = assessment.factors.find((factor) => factor.factor === 'amount');
    expect(amountFactor?.contribution).toBe(30);
  });

  it('emits an assessment without persisting when no transaction id is supplied', async () => {
    const eventBus = createEventBus();
    const repository = {
      createAssessmentRecord: vi.fn().mockResolvedValue(undefined),
    } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService, repository);

    const assessment = await service.evaluate('org-1', lowRisk);

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.RiskEvaluated,
      expect.objectContaining({ score: assessment.score, band: assessment.band }),
      expect.objectContaining({ organizationId: 'org-1', aggregateType: 'transaction' }),
    );
    expect(repository.createAssessmentRecord).not.toHaveBeenCalled();
  });

  it('delegates history and statistics queries with default and explicit limits', async () => {
    const repository = {
      createAssessmentRecord: vi.fn(),
      findByOrganization: vi.fn().mockResolvedValue([{ id: 'assessment-1' }]),
      getStatistics: vi.fn().mockResolvedValue({ total: 1 }),
    } as unknown as RiskRepository;
    const service = new RiskService(new RiskEngine(), createEventBus() as unknown as EventBusService, repository);

    await expect(service.getHistory('org-1')).resolves.toEqual([{ id: 'assessment-1' }]);
    await expect(service.getHistory('org-2', 10)).resolves.toEqual([{ id: 'assessment-1' }]);
    await expect(service.getStatistics('org-1')).resolves.toEqual({ total: 1 });
    await expect(service.getStatistics('org-2', 7)).resolves.toEqual({ total: 1 });

    expect(repository.findByOrganization).toHaveBeenNthCalledWith(1, 'org-1', 100);
    expect(repository.findByOrganization).toHaveBeenNthCalledWith(2, 'org-2', 10);
    expect(repository.getStatistics).toHaveBeenNthCalledWith(1, 'org-1', 30);
    expect(repository.getStatistics).toHaveBeenNthCalledWith(2, 'org-2', 7);
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
      eventId: 'event-123',
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
      eventId: 'event-duplicate',
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

  it('ignores transaction-created events without a transaction id', async () => {
    await riskService.handleTransactionCreated({
      payload: {},
      occurredAt: new Date(),
    } as never);

    expect(eventBusService.emit).not.toHaveBeenCalled();
    expect(riskRepository.createAssessmentRecord).not.toHaveBeenCalled();
  });

  it('uses fallback input values and evicts the oldest processed event key', async () => {
    const processedEvents = riskService['processedEvents'];
    for (let index = 0; index < 5000; index += 1) {
      processedEvents.add(`old-${index}`);
    }

    await riskService.handleTransactionCreated({
      payload: { transactionId: 'tx-fallback' },
    } as never);

    expect(processedEvents.size).toBe(5000);
    expect(processedEvents.has('old-0')).toBe(false);
    expect(eventBusService.emit).toHaveBeenCalledWith(
      DomainEventName.RiskEvaluated,
      expect.objectContaining({ transactionId: 'tx-fallback' }),
      expect.objectContaining({ organizationId: 'default-org' }),
    );
    const emittedPayload = vi.mocked(eventBusService.emit).mock.calls[0][1] as {
      factors: Array<{ factor: string; contribution: number }>;
    };
    expect(
      emittedPayload.factors.find((factor) => factor.factor === 'amount')?.contribution,
    ).toBe(0);
  });

  it('should handle failure resilience gracefully when evaluation throws', async () => {
    vi.spyOn(riskRepository, 'createAssessmentRecord').mockRejectedValueOnce(
      new Error('DB connection failed'),
    );
    const envelope = {
      eventId: 'event-failure',
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

    await expect(riskService.handleTransactionCreated(envelope)).rejects.toThrow(
      'DB connection failed',
    );
  });

  it('rethrows non-Error failures from event processing', async () => {
    vi.mocked(eventBusService.emit).mockRejectedValueOnce('event bus unavailable');

    await expect(
      riskService.handleTransactionCreated({
        payload: { transactionId: 'tx-non-error' },
      } as never),
    ).rejects.toBe('event bus unavailable');
  });
});
