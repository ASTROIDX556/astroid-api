import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { WALLET_LOCK_KEY, UseWalletLock } from './wallet-lock.decorator';

describe('UseWalletLock', () => {
  it('sets the wallet-lock metadata with default options', () => {
    class Controller {
      @UseWalletLock()
      create(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(WALLET_LOCK_KEY, Controller.prototype.create)).toEqual({});
  });

  it('stores custom key resolver and ttl options', () => {
    const keyResolver = () => 'wallet:custom';

    class Controller {
      @UseWalletLock({ key: keyResolver, ttl: 1000 })
      create(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(WALLET_LOCK_KEY, Controller.prototype.create)).toEqual({
      key: keyResolver,
      ttl: 1000,
    });
  });

  it('is only applied to the decorated method', () => {
    class Controller {
      @UseWalletLock()
      create(): void {}

      list(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(WALLET_LOCK_KEY, Controller.prototype.create)).toEqual({});
    expect(reflector.get(WALLET_LOCK_KEY, Controller.prototype.list)).toBeUndefined();
  });
});
