import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedOnEvent } from './typed-event-listener.decorator';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventName } from './event-names';

vi.mock('@nestjs/event-emitter', () => ({
  OnEvent: vi.fn(),
}));

describe('TypedOnEvent decorator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call OnEvent with the correct event name', () => {
    TypedOnEvent(DomainEventName.WalletCreated);
    expect(OnEvent).toHaveBeenCalledWith(DomainEventName.WalletCreated);
  });

  it('should call OnEvent with agent registered event', () => {
    TypedOnEvent(DomainEventName.AgentRegistered);
    expect(OnEvent).toHaveBeenCalledWith(DomainEventName.AgentRegistered);
  });

  it('should call OnEvent with policy evaluated event', () => {
    TypedOnEvent(DomainEventName.PolicyEvaluated);
    expect(OnEvent).toHaveBeenCalledWith(DomainEventName.PolicyEvaluated);
  });

  it('should return a decorator function', () => {
    const decorator = TypedOnEvent(DomainEventName.WalletCreated);
    expect(typeof decorator).toBe('function');
  });

  it('should be usable as a method decorator', () => {
    const decorator = TypedOnEvent(DomainEventName.WalletCreated);
    const target = {};
    const propertyKey = 'handleWalletCreated';
    const descriptor = {
      value: vi.fn(),
    };

    decorator(target, propertyKey, descriptor);

    expect(OnEvent).toHaveBeenCalledWith(DomainEventName.WalletCreated);
  });
});
