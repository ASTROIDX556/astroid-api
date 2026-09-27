import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../database/prisma.service';
import { DomainEventNameType } from './event-names';
import { DomainEventEnvelope } from './domain-event.types';
import { TypedEventEmitter, DomainEventMap } from './typed-event-emitter.service';

export interface EmitOptions {
  organizationId?: string;
  aggregateType: string;
  aggregateId?: string;
  actorId?: string;
  correlationId?: string;
  /** When false, the event is broadcast but NOT written to the ledger. */
  persist?: boolean;
}

/**
 * Central publisher for domain events. Every emit:
 *   1. persists an immutable row to the append-only `domain_events` ledger
 *      (the event-sourcing / immutable event ledger enhancement), and
 *   2. broadcasts in-process via TypedEventEmitter for type-safe event dispatch
 *      so audit, notifications, analytics and webhook subscribers can react independently.
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
    private readonly typedEmitter: TypedEventEmitter,
  ) {}

  async emit<K extends keyof DomainEventMap>(
    name: K,
    payload: DomainEventMap[K],
    options: EmitOptions,
  ): Promise<void> {
    const envelope: DomainEventEnvelope<DomainEventMap[K]> = {
      name: name as DomainEventNameType,
      organizationId: options.organizationId,
      aggregateType: options.aggregateType,
      aggregateId: options.aggregateId,
      actorId: options.actorId,
      correlationId: options.correlationId,
      payload,
      occurredAt: new Date(),
    };

    if (options.persist !== false) {
      await this.persist(envelope);
    }

    // Broadcast synchronously in-process using typed emitter for type safety.
    // Subscribers isolate their own errors.
    this.typedEmitter.emit(name, payload);
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
