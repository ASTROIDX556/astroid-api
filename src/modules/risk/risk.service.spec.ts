import { describe, expect, it, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskFactorsInput } from './risk.types';
import { EventBusService } from '../../events/event-bus.service';

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
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService);

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
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService);

    const assessment = service.assess(lowRisk);
    expect(assessment.band).toBe(RiskBand.LOW);
    const emitMock = eventBus.emit as ReturnType<typeof vi.fn>;
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('passes config overrides through to the engine', async () => {
    const eventBus = createEventBus();
    const service = new RiskService(new RiskEngine(), eventBus as unknown as EventBusService);

    const assessment = service.assess(
      { ...lowRisk, amount: 100 },
      { amountSaturation: 100 },
    );
    const amountFactor = assessment.factors.find((f) => f.factor === 'amount');
    expect(amountFactor!.contribution).toBe(30);
  });
});
