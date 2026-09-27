import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter, DomainEventMap } from './typed-event-emitter.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEventName } from './event-names';

describe('TypedEventEmitter', () => {
  let typedEmitter: TypedEventEmitter;
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    typedEmitter = new TypedEventEmitter(eventEmitter);
  });

  describe('emit', () => {
    it('emits typed event with correct payload', () => {
      const handler = vi.fn();
      eventEmitter.on(DomainEventName.WalletCreated, handler);

      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      const result = typedEmitter.emit(DomainEventName.WalletCreated, payload);

      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('returns false when no listeners are registered', () => {
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      const result = typedEmitter.emit(DomainEventName.WalletCreated, payload);

      expect(result).toBe(false);
    });

    it('enforces type safety at compile time', () => {
      const payload: DomainEventMap[typeof DomainEventName.AgentRegistered] = {
        agentId: 'agent-123',
        name: 'Test Agent',
        role: 'worker',
      };

      const handler = vi.fn();
      eventEmitter.on(DomainEventName.AgentRegistered, handler);

      typedEmitter.emit(DomainEventName.AgentRegistered, payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('on', () => {
    it('registers typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on(DomainEventName.WalletCreated, handler);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('supports async handlers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on(DomainEventName.WalletCreated, handler);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);

      await expect(handler()).resolves.toBeUndefined();
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('once', () => {
    it('registers one-time typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.once(DomainEventName.WalletCreated, handler);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('off', () => {
    it('removes specific typed event listener', () => {
      const handler = vi.fn();
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on(DomainEventName.WalletCreated, handler);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);
      expect(handler).toHaveBeenCalledTimes(1);

      typedEmitter.off(DomainEventName.WalletCreated, handler);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners for specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const payload: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };

      typedEmitter.on(DomainEventName.WalletCreated, handler1);
      typedEmitter.on(DomainEventName.WalletCreated, handler2);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      typedEmitter.removeAllListeners(DomainEventName.WalletCreated);
      eventEmitter.emit(DomainEventName.WalletCreated, payload);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('removes all listeners when no event specified', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const payload1: DomainEventMap[typeof DomainEventName.WalletCreated] = {
        walletId: 'wallet-123',
        stellarAddress: 'GABC...',
        walletType: 'standard',
      };
      const payload2: DomainEventMap[typeof DomainEventName.AgentRegistered] = {
        agentId: 'agent-123',
        name: 'Test Agent',
        role: 'worker',
      };

      typedEmitter.on(DomainEventName.WalletCreated, handler1);
      typedEmitter.on(DomainEventName.AgentRegistered, handler2);
      eventEmitter.emit(DomainEventName.WalletCreated, payload1);
      eventEmitter.emit(DomainEventName.AgentRegistered, payload2);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      typedEmitter.removeAllListeners();
      eventEmitter.emit(DomainEventName.WalletCreated, payload1);
      eventEmitter.emit(DomainEventName.AgentRegistered, payload2);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });
});
