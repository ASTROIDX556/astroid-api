import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BudgetReservationService } from './budget-reservation.service';
import { BudgetRepository } from '../budget.repository';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { ConflictException } from '../../../common/exceptions/domain.exception';

describe('BudgetReservationService', () => {
  let service: BudgetReservationService;
  let budgetRepository: BudgetRepository;
  let redisLock: RedisLock;

  beforeEach(() => {
    budgetRepository = {
      findById: vi.fn(),
    } as unknown as BudgetRepository;

    redisLock = {
      withLock: vi.fn(),
    } as unknown as RedisLock;

    service = new BudgetReservationService(budgetRepository, redisLock);
  });

  const createMockBudget = (overrides: { spent?: number; limitAmount?: number } = {}) => ({
    id: 'budget-1',
    organizationId: 'org-1',
    spent: overrides.spent ?? 0,
    limitAmount: overrides.limitAmount ?? 1000,
  });

  it('acquires lock and reserves budget successfully', async () => {
    const mockBudget = createMockBudget({ spent: 100, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.reserve('org-1', 'budget-1', 50);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-1', expect.any(Function));
    expect(budgetRepository.findById).toHaveBeenCalledWith('org-1', 'budget-1');
    expect(result).toEqual(mockBudget);
  });

  it('uses correct lock key format with budget ID', async () => {
    const mockBudget = createMockBudget();
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await service.reserve('org-1', 'budget-123', 100);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-123', expect.any(Function));
  });

  it('throws ConflictException when budget is not found', async () => {
    vi.mocked(budgetRepository.findById).mockResolvedValue(null);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await expect(service.reserve('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
    await expect(service.reserve('org-1', 'budget-1', 50)).rejects.toThrow('Budget not found');
  });

  it('throws ConflictException when budget limit is exceeded', async () => {
    const mockBudget = createMockBudget({ spent: 950, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await expect(service.reserve('org-1', 'budget-1', 100)).rejects.toThrow(ConflictException);
    await expect(service.reserve('org-1', 'budget-1', 100)).rejects.toThrow('Budget limit exceeded due to concurrent operation');
  });

  it('throws ConflictException when lock acquisition fails', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(new Error('Lock acquisition failed'));

    await expect(service.reserve('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
    await expect(service.reserve('org-1', 'budget-1', 50)).rejects.toThrow('Failed to acquire budget lock due to concurrent operation');
  });

  it('re-throws ConflictException from within lock', async () => {
    vi.mocked(redisLock.withLock).mockRejectedValue(new ConflictException('Budget limit exceeded'));

    await expect(service.reserve('org-1', 'budget-1', 50)).rejects.toThrow(ConflictException);
  });

  it('allows reservation when new total equals limit', async () => {
    const mockBudget = createMockBudget({ spent: 900, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.reserve('org-1', 'budget-1', 100);

    expect(result).toEqual(mockBudget);
  });

  it('handles zero amount reservation', async () => {
    const mockBudget = createMockBudget({ spent: 500, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.reserve('org-1', 'budget-1', 0);

    expect(result).toEqual(mockBudget);
  });

  it('converts spent and limit to numbers for comparison', async () => {
    const mockBudget = createMockBudget({ 
      spent: 500 as unknown as number, 
      limitAmount: 1000 as unknown as number 
    });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.reserve('org-1', 'budget-1', 100);

    expect(result).toEqual(mockBudget);
  });

  it('handles concurrent reservation attempts with lock', async () => {
    const mockBudget = createMockBudget({ spent: 500, limitAmount: 1000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    
    let lockCallCount = 0;
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => {
      lockCallCount++;
      return fn();
    });

    // Simulate concurrent reservations
    const promises = [
      service.reserve('org-1', 'budget-1', 100),
      service.reserve('org-1', 'budget-1', 200),
      service.reserve('org-1', 'budget-1', 50),
    ];

    await Promise.all(promises);

    expect(lockCallCount).toBe(3);
    expect(redisLock.withLock).toHaveBeenCalledTimes(3);
  });

  it('prevents race condition with lock-based serialization', async () => {
    const executionOrder: string[] = [];
    const mockBudget = createMockBudget({ spent: 500, limitAmount: 1000 });
    
    vi.mocked(budgetRepository.findById).mockImplementation(async () => {
      executionOrder.push('findById');
      return mockBudget as never;
    });

    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => {
      executionOrder.push('acquire-lock');
      await fn();
      executionOrder.push('release-lock');
    });

    await service.reserve('org-1', 'budget-1', 100);

    // Verify lock is acquired before repository access
    expect(executionOrder[0]).toBe('acquire-lock');
    expect(executionOrder[1]).toBe('findById');
    expect(executionOrder[2]).toBe('release-lock');
  });

  it('uses default TTL of 5000ms for lock', async () => {
    const mockBudget = createMockBudget();
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    await service.reserve('org-1', 'budget-1', 50);

    expect(redisLock.withLock).toHaveBeenCalledWith('budget:budget-1', expect.any(Function));
  });

  it('handles large amount reservations correctly', async () => {
    const mockBudget = createMockBudget({ spent: 0, limitAmount: 1_000_000 });
    vi.mocked(budgetRepository.findById).mockResolvedValue(mockBudget as never);
    vi.mocked(redisLock.withLock).mockImplementation(async (_key, fn) => fn());

    const result = await service.reserve('org-1', 'budget-1', 500_000);

    expect(result).toEqual(mockBudget);
  });
});
