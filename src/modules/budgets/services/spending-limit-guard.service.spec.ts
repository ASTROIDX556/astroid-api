import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpendingLimitGuardService } from './spending-limit-guard.service';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetService } from '../budget.service';

describe('SpendingLimitGuardService', () => {
  let service: SpendingLimitGuardService;
  let redisLock: RedisLock;
  let budgets: BudgetService;

  beforeEach(() => {
    redisLock = {
      withLock: vi.fn(),
    } as unknown as RedisLock;

    budgets = {
      assertWithinBudget: vi.fn(),
      consume: vi.fn(),
    } as unknown as BudgetService;

    service = new SpendingLimitGuardService(redisLock, budgets);
  });

  it('should acquire lock and call assertWithinBudget + consume', async () => {
    const fakeBudget = { id: 'b1', spent: 0, limitAmount: { toFixed: () => '100' } };
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());
    vi.mocked(budgets.assertWithinBudget).mockResolvedValue(undefined as never);
    vi.mocked(budgets.consume).mockResolvedValue(fakeBudget as never);

    const result = await service.guardAndConsume('org1', 'b1', 50);

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'budget:guard:b1',
      expect.any(Function),
      5000,
    );
    expect(budgets.assertWithinBudget).toHaveBeenCalledWith('org1', 'b1', 50);
    expect(budgets.consume).toHaveBeenCalledWith('org1', 'b1', 50);
    expect(result).toBe(fakeBudget);
  });

  it('should not call consume if assertWithinBudget throws', async () => {
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());
    vi.mocked(budgets.assertWithinBudget).mockRejectedValueOnce(
      new Error('Budget exceeded'),
    );

    await expect(service.guardAndConsume('org1', 'b1', 200)).rejects.toThrow('Budget exceeded');
    expect(budgets.consume).not.toHaveBeenCalled();
  });

  it('should use custom TTL when provided', async () => {
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());
    vi.mocked(budgets.assertWithinBudget).mockResolvedValue(undefined as never);
    vi.mocked(budgets.consume).mockResolvedValue({} as never);

    await service.guardAndConsume('org1', 'b1', 10, 10_000);

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'budget:guard:b1',
      expect.any(Function),
      10_000,
    );
  });

  it('should propagate lock acquisition failure', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(
      new Error('Lock not acquired'),
    );

    await expect(service.guardAndConsume('org1', 'b1', 50)).rejects.toThrow(
      'Lock not acquired',
    );
    expect(budgets.assertWithinBudget).not.toHaveBeenCalled();
  });
});
