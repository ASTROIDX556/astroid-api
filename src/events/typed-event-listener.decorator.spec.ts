import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedOnEvent } from './typed-event-listener.decorator';
import { OnEvent } from '@nestjs/event-emitter';

vi.mock('@nestjs/event-emitter', () => ({
  OnEvent: vi.fn(),
}));

describe('TypedOnEvent decorator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call OnEvent with the correct event name', () => {
    TypedOnEvent('wallet.created');
    expect(OnEvent).toHaveBeenCalledWith('wallet.created');
  });

  it('should call OnEvent with agent registered event', () => {
    TypedOnEvent('agent.registered');
    expect(OnEvent).toHaveBeenCalledWith('agent.registered');
  });

  it('should call OnEvent with policy evaluated event', () => {
    TypedOnEvent('policy.evaluated');
    expect(OnEvent).toHaveBeenCalledWith('policy.evaluated');
  });

  it('should return a decorator function', () => {
    const decorator = TypedOnEvent('wallet.created');
    expect(typeof decorator).toBe('function');
  });

  it('should be usable as a method decorator', () => {
    const decorator = TypedOnEvent('wallet.created');
    const target = {};
    const propertyKey = 'handleWalletCreated';
    const descriptor = {
      value: vi.fn(),
    };

    decorator(target, propertyKey, descriptor);

    expect(OnEvent).toHaveBeenCalledWith('wallet.created');
  });
});
