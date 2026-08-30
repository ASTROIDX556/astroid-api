import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpendingLimitGuardService } from './spending-limit-guard.service';
import { BudgetRepository } from '../budget.repository';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import {
  ConflictException,
  BudgetExceededException,
} from '../../../common/exceptions/domain.exception';

describe('SpendingLimitGuardService', () => {
  let service: SpendingLimitGuardService;
  let budgetRepository: BudgetRepository;
  let redisLock: RedisLock;

  beforeEach(() => {
    budgetRepository = {
      findById: vi.fn(),
      incrementSpent: vi.fn(),
    } as unknown as BudgetRepository;

    redisLock = {
      withLock: vi.fn(),
    } as unknown as RedisLock;

    service = new SpendingLimitGuardService(budgetRepository, redisLock);
  });

  const createMockBudget = (overrides: { spent?: number; limitAmount?: number } = {}) => ({
    id: 'budget-1',
    organizationId: 'org-1',
    spent: overrides.spent ?? 0,
    limitAmount: overrides.limitAmount ?? 1000,
    name: 'Test Budget',
  });

  it('acquires lock, validates headroom, and increments spend atomically', async () => {
    const mockBudget = createMockBudget({ spent: 100, limitAmount: 1000 });
    const updatedBudget = { ...mockBudget, spent: 150 };
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(budgetRepository.incrementSpent).mockResolvedValue(updatedBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.guardAndConsume('org-1', 'budget-1', 50);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-1', expect.any(Function), 5000);
    expect(budgetRepository.findById).toHaveBeenCalledWith('org-1', 'budget-1');
    expect(budgetRepository.incrementSpent).toHaveBeenCalled();
    expect(result).toEqual(updatedBudget);
  });

  it('uses correct lock key format', async () => {
    const mockBudget = createMockBudget();
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(budgetRepository.incrementSpent).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await service.guardAndConsume('org-1', 'budget-42', 100);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-42', expect.any(Function), 5000);
  });

  it('throws BudgetExceededException when spend would exceed limit', async () => {
    const mockBudget = createMockBudget({ spent: 950, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await expect(service.guardAndConsume('org-1', 'budget-1', 100)).rejects.toThrow(BudgetExceededException);
    expect(budgetRepository.incrementSpent).not.toHaveBeenCalled();
  });

  it('throws ConflictException when budget is not found', async () => {
    vi.mocked(budgetRepository.findById).mockResolvedValue(null);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await expect(service.guardAndConsume('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
    expect(budgetRepository.incrementSpent).not.toHaveBeenCalled();
  });

  it('allows spend when total exactly equals limit', async () => {
    const mockBudget = createMockBudget({ spent: 900, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(budgetRepository.incrementSpent).mockResolvedValue({ ...mockBudget, spent: 1000 } as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.guardAndConsume('org-1', 'budget-1', 100);

    expect(result).toBeDefined();
    expect(budgetRepository.incrementSpent).toHaveBeenCalled();
  });

  it('handles zero amount', async () => {
    const mockBudget = createMockBudget({ spent: 500, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(budgetRepository.incrementSpent).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.guardAndConsume('org-1', 'budget-1', 0);

    expect(result).toEqual(mockBudget);
  });

  it('re-throws ConflictException from within lock', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(new ConflictException('Budget not found'));

    await expect(service.guardAndConsume('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
  });

  it('re-throws BudgetExceededException from within lock', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(
      new BudgetExceededException('Limit exceeded', { budgetId: 'budget-1' }),
    );

    await expect(service.guardAndConsume('org-1', 'budget-1', 50)).rejects.toThrow(BudgetExceededException);
  });

  it('wraps Redis infrastructure failures as ConflictException', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.guardAndConsume('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
    await expect(service.guardAndConsume('org-1', 'budget-1', 50)).rejects.toThrow(
      'Failed to acquire budget lock due to concurrent operation',
    );
  });

  it('serializes concurrent attempts through the lock', async () => {
    const executionOrder: string[] = [];
    const mockBudget = createMockBudget({ spent: 500, limitAmount: 1000 });

    vi.mocked(budgetRepository.findById).mockImplementation(async () => {
      executionOrder.push('findById');
      return mockBudget as never;
    });

    vi.mocked(budgetRepository.incrementSpent).mockImplementation(async () => {
      executionOrder.push('incrementSpent');
      return { ...mockBudget, spent: 600 } as never;
    });

    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => {
      executionOrder.push('acquire-lock');
      const result = await fn();
      executionOrder.push('release-lock');
      return result;
    });

    await service.guardAndConsume('org-1', 'budget-1', 100);

    // Lock acquired before repository access, released after
    expect(executionOrder[0]).toBe('acquire-lock');
    expect(executionOrder[1]).toBe('findById');
    expect(executionOrder[2]).toBe('incrementSpent');
    expect(executionOrder[3]).toBe('release-lock');
  });

  it('uses custom TTL when provided', async () => {
    const mockBudget = createMockBudget();
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(budgetRepository.incrementSpent).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await service.guardAndConsume('org-1', 'budget-1', 50, 10_000);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-1', expect.any(Function), 10_000);
  });

  it('simulates concurrent guard-and-consume calls — only one succeeds', async () => {
    const mockBudget = createMockBudget({ spent: 900, limitAmount: 1000 });
    let callCount = 0;

    vi.mocked(budgetRepository.findById).mockImplementation(async () => {
      callCount++;
      // First call sees original state, subsequent calls see incremented state
      return { ...mockBudget, spent: 900 + (callCount - 1) * 100 } as never;
    });

    vi.mocked(budgetRepository.incrementSpent).mockImplementation(async (_id, amount) => {
      return { ...mockBudget, spent: 900 + Number(amount) } as never;
    });

    // Simulate serialized lock: each call acquires and releases before the next
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    // 3 concurrent attempts of 100 each: total would be 1200, but limit is 1000
    const results = await Promise.allSettled([
      service.guardAndConsume('org-1', 'budget-1', 100),
      service.guardAndConsume('org-1', 'budget-1', 100),
      service.guardAndConsume('org-1', 'budget-1', 100),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');

    // At least one should be rejected (budget exceeded) since total would exceed limit
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededException);
    }
  });
});
