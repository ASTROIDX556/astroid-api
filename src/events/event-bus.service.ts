import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../database/prisma.service';
import { DomainEventNameType } from './event-names';
import { DomainEventEnvelope } from './domain-event.types';
import { TraceContext } from '../common/context/trace.context';

export interface EmitOptions {
  organizationId?: string;
  aggregateType: string;
  aggregateId?: string;
  actorId?: string;
  correlationId?: string;
  /** Defaults to the active trace context's request id when omitted. */
  requestId?: string;
  /** When false, the event is broadcast but NOT written to the ledger. */
  persist?: boolean;
}

/**
 * Central publisher for domain events. Every emit:
 *   1. persists an immutable row to the append-only `domain_events` ledger
 *      (the event-sourcing / immutable event ledger enhancement), and
 *   2. broadcasts in-process via EventEmitter2 so audit, notifications,
 *      analytics and webhook subscribers can react independently.
 *
 * A failure in a subscriber must never roll back the originating operation, so
 * broadcasting is fire-and-forget and ledger writes are best-effort logged.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  async emit<TPayload extends Record<string, unknown>>(
    name: DomainEventNameType,
    payload: TPayload,
    options: EmitOptions,
  ): Promise<void> {
    const envelope: DomainEventEnvelope<TPayload> = {
      name,
      organizationId: options.organizationId,
      aggregateType: options.aggregateType,
      aggregateId: options.aggregateId,
      actorId: options.actorId,
      correlationId: options.correlationId,
      requestId: options.requestId ?? TraceContext.getTraceId() ?? null,
      payload,
      occurredAt: new Date(),
    };

    if (options.persist !== false) {
      await this.persist(envelope);
    }

    // Broadcast synchronously in-process; subscribers isolate their own errors.
    this.emitter.emit(name, envelope);
  }

  private async persist(envelope: DomainEventEnvelope): Promise<void> {
    try {
      await this.prisma.domainEvent.create({
        data: {
          organizationId: envelope.organizationId ?? null,
          name: envelope.name,
          aggregateType: envelope.aggregateType,
          aggregateId: envelope.aggregateId ?? null,
          actorId: envelope.actorId ?? null,
          payload: envelope.payload as object,
          occurredAt: envelope.occurredAt,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist domain event '${envelope.name}': ${(error as Error).message}`,
      );
    }
  }
}
