import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { BUDGET_LOCK_KEY, UseBudgetLock } from './budget-lock.decorator';

describe('UseBudgetLock', () => {
  it('sets the budget-lock metadata with default options', () => {
    class Controller {
      @UseBudgetLock()
      allocate(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(BUDGET_LOCK_KEY, Controller.prototype.allocate)).toEqual({});
  });

  it('stores custom key resolver and ttl options', () => {
    const keyResolver = () => 'budget:custom';

    class Controller {
      @UseBudgetLock({ key: keyResolver, ttl: 1000 })
      allocate(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(BUDGET_LOCK_KEY, Controller.prototype.allocate)).toEqual({
      key: keyResolver,
      ttl: 1000,
    });
  });

  it('is only applied to the decorated method', () => {
    class Controller {
      @UseBudgetLock()
      allocate(): void {}

      list(): void {}
    }

    const reflector = new Reflector();
    expect(reflector.get(BUDGET_LOCK_KEY, Controller.prototype.allocate)).toEqual({});
    expect(reflector.get(BUDGET_LOCK_KEY, Controller.prototype.list)).toBeUndefined();
  });
});
