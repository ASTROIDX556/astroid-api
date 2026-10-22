import { RiskBand } from '@prisma/client';
import { DomainEventName } from './event-names';
import { RiskFactorScore } from '../modules/risk/risk.types';

export interface RiskEvaluatedEventPayload {
  transactionId?: string;
  score: number;
  band: RiskBand;
  factors: RiskFactorScore[];
  canAutoExecute: boolean;
}

/**
 * Strongly typed domain event emitted whenever an agent transaction undergoes
 * risk scoring so downstream audit listeners persist immutable risk metadata.
 */
export class RiskEvaluatedEvent {
  static readonly eventName = DomainEventName.RiskEvaluated;

  constructor(
    public readonly organizationId: string,
    public readonly payload: RiskEvaluatedEventPayload,
    public readonly actorId?: string,
    public readonly occurredAt: Date = new Date(),
  ) {}
}
