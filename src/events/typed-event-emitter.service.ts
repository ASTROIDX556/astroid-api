import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEventName } from './event-names';
import {
  WalletCreatedPayload,
  AgentRegisteredPayload,
  PolicyEvaluatedPayload,
  BudgetExceededPayload,
  ProposalApprovedPayload,
  TransactionCompletedPayload,
  RiskEvaluatedPayload,
} from './domain-event.types';

/**
 * Type-safe mapping of event names to their payload types.
 * This ensures compile-time type safety when emitting and listening to events.
 */
export interface DomainEventMap {
  [DomainEventName.WalletCreated]: WalletCreatedPayload;
  [DomainEventName.AgentRegistered]: AgentRegisteredPayload;
  [DomainEventName.PolicyEvaluated]: PolicyEvaluatedPayload;
  [DomainEventName.BudgetExceeded]: BudgetExceededPayload;
  [DomainEventName.ProposalApproved]: ProposalApprovedPayload;
  [DomainEventName.TransactionCompleted]: TransactionCompletedPayload;
  [DomainEventName.RiskEvaluated]: RiskEvaluatedPayload;
}

/**
 * A strongly-typed wrapper around EventEmitter2 for domain events.
 * Enforces compile-time type safety for event payloads and provides
 * type-safe emit/listen methods.
 */
@Injectable()
export class TypedEventEmitter {
  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit a typed domain event.
   * @param event - The event name
   * @param payload - The event payload (type-checked at compile time)
   * @returns boolean indicating if the event had listeners
   */
  emit<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
  ): boolean {
    return this.emitter.emit(event as string, payload);
  }

  /**
   * Listen to a typed domain event.
   * @param event - The event name
   * @param handler - The event handler (type-checked at compile time)
   */
  on<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): this {
    this.emitter.on(event as string, handler);
    return this;
  }

  /**
   * Listen to a typed domain event once.
   * @param event - The event name
   * @param handler - The event handler (type-checked at compile time)
   */
  once<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): this {
    this.emitter.once(event as string, handler);
    return this;
  }

  /**
   * Remove a listener for a typed domain event.
   * @param event - The event name
   * @param handler - The event handler to remove
   */
  off<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): this {
    this.emitter.off(event as string, handler);
    return this;
  }

  /**
   * Remove all listeners for a typed domain event.
   * @param event - The event name
   */
  removeAllListeners<K extends keyof DomainEventMap>(event?: K): this {
    this.emitter.removeAllListeners(event as string);
    return this;
  }
}
