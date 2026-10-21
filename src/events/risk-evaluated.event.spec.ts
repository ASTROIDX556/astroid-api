import { describe, it, expect } from 'vitest';
import { RiskEvaluatedEvent } from './risk-evaluated.event';
import { DomainEventName } from './event-names';

describe('RiskEvaluatedEvent (#414)', () => {
  it('constructs an immutable risk evaluation event with score, band, and factors', () => {
    const evt = new RiskEvaluatedEvent(
      'org_123',
      {
        transactionId: 'tx_999',
        score: 82,
        band: 'HIGH',
        factors: [
          {
            factor: 'amount',
            weight: 30,
            contribution: 25,
            detail: 'Exceeds standard agent transfer limit',
          },
        ],
        canAutoExecute: false,
      },
      'agent_42',
    );

    expect(RiskEvaluatedEvent.eventName).toBe(DomainEventName.RiskEvaluated);
    expect(evt.organizationId).toBe('org_123');
    expect(evt.payload.score).toBe(82);
    expect(evt.payload.band).toBe('HIGH');
    expect(evt.payload.canAutoExecute).toBe(false);
    expect(evt.actorId).toBe('agent_42');
    expect(evt.occurredAt).toBeInstanceOf(Date);
  });
});
