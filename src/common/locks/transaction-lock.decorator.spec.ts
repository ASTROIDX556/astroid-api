import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { TRANSACTION_LOCK_KEY, UseTransactionLock } from './transaction-lock.decorator';

describe('UseTransactionLock', () => {
  it('sets the transaction-lock metadata with default options', () => {
    class Controller {
      @UseTransactionLock()
      create(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(TRANSACTION_LOCK_KEY, Controller.prototype.create)).toEqual({});
  });

  it('stores custom key resolver, ttl, and retry options', () => {
    const keyResolver = () => 'transaction:custom';

    class Controller {
      @UseTransactionLock({ key: keyResolver, ttl: 2000, attempts: 5, retryDelayMs: 100 })
      create(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(TRANSACTION_LOCK_KEY, Controller.prototype.create)).toEqual({
      key: keyResolver,
      ttl: 2000,
      attempts: 5,
      retryDelayMs: 100,
    });
  });

  it('is only applied to the decorated method', () => {
    class Controller {
      @UseTransactionLock()
      create(): void {}

      list(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(TRANSACTION_LOCK_KEY, Controller.prototype.create)).toEqual({});
    expect(reflector.get(TRANSACTION_LOCK_KEY, Controller.prototype.list)).toBeUndefined();
  });
});
