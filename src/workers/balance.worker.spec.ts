import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { BalanceWorker, BalanceSyncJob } from './balance.worker';
import { StellarClient, StellarBalance } from '../integrations/stellar/stellar.interface';
import { BalanceCacheService } from '../modules/wallets/services/balance-cache.service';
import { EventBusService } from '../events/event-bus.service';

interface MockStellarClient {
  generateKeypair: Mock;
  isValidAddress: Mock;
  getBalances: Mock;
  getNativeBalance: Mock;
  buildPaymentXdr: Mock;
  submitPayment: Mock;
  getTransaction: Mock;
}

function buildMockStellarClient(balances: StellarBalance[] = []): MockStellarClient {
  return {
    generateKeypair: vi.fn(),
    isValidAddress: vi.fn().mockReturnValue(true),
    getBalances: vi.fn().mockResolvedValue(balances),
    getNativeBalance: vi.fn().mockResolvedValue('100.0000000'),
    buildPaymentXdr: vi.fn(),
    submitPayment: vi.fn(),
    getTransaction: vi.fn(),
  };
}

function buildMockCacheService() {
  return {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    checkThresholds: vi.fn().mockReturnValue([]),
    invalidate: vi.fn().mockResolvedValue(undefined),
    getTtlSeconds: vi.fn().mockReturnValue(60),
  };
}

function buildMockEventBus() {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

function buildJob(overrides: Partial<BalanceSyncJob> = {}) {
  return {
    data: {
      walletId: 'wallet-1',
      stellarAddress: 'GABC123...',
      network: 'testnet' as const,
      organizationId: 'org-1',
      ...overrides,
    },
  };
}

describe('BalanceWorker', () => {
  let stellarClient: MockStellarClient;
  let cacheService: ReturnType<typeof buildMockCacheService>;
  let eventBus: ReturnType<typeof buildMockEventBus>;
  let worker: BalanceWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    stellarClient = buildMockStellarClient();
    cacheService = buildMockCacheService();
    eventBus = buildMockEventBus();
    worker = new BalanceWorker(
      stellarClient as unknown as StellarClient,
      cacheService as unknown as BalanceCacheService,
      eventBus as unknown as EventBusService,
    );
  });

  describe('process', () => {
    it('should fetch balances and cache them', async () => {
      const balances: StellarBalance[] = [
        { asset: 'XLM', balance: '1000.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '500.0000000', assetType: 'credit_alphanum4' },
      ];
      stellarClient.getBalances.mockResolvedValue(balances);

      const result = await worker.process(buildJob());

      expect(stellarClient.getBalances).toHaveBeenCalledWith('GABC123...', 'testnet');
      expect(cacheService.set).toHaveBeenCalledWith('GABC123...', 'testnet', balances);
      expect(result.balanceCount).toBe(2);
      expect(result.address).toBe('GABC123...');
    });

    it('should emit WalletBalanceUpdated event', async () => {
      const balances: StellarBalance[] = [
        { asset: 'XLM', balance: '1000.0000000', assetType: 'native' },
      ];
      stellarClient.getBalances.mockResolvedValue(balances);

      await worker.process(buildJob());

      expect(eventBus.emit).toHaveBeenCalledWith(
        'wallet.balance_updated',
        expect.objectContaining({
          walletId: 'wallet-1',
          balanceCount: 1,
        }),
        expect.objectContaining({
          organizationId: 'org-1',
          aggregateType: 'wallet',
          aggregateId: 'wallet-1',
        }),
      );
    });

    it('should emit low balance alert event when thresholds breached', async () => {
      const lowBalances: StellarBalance[] = [
        { asset: 'XLM', balance: '5.0000000', assetType: 'native' },
      ];
      stellarClient.getBalances.mockResolvedValue(lowBalances);
      cacheService.checkThresholds.mockReturnValue([
        { asset: 'XLM', balance: '5.0000000', threshold: 10 },
      ]);

      const result = await worker.process(buildJob());

      expect(result.alerts).toHaveLength(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'budget.warning',
        expect.objectContaining({
          alerts: expect.arrayContaining([
            expect.objectContaining({ asset: 'XLM' }),
          ]),
        }),
        expect.any(Object),
      );
    });

    it('should not emit alert event when no thresholds breached', async () => {
      const healthyBalances: StellarBalance[] = [
        { asset: 'XLM', balance: '1000.0000000', assetType: 'native' },
      ];
      stellarClient.getBalances.mockResolvedValue(healthyBalances);
      cacheService.checkThresholds.mockReturnValue([]);

      const result = await worker.process(buildJob());

      expect(result.alerts).toHaveLength(0);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'budget.warning',
        expect.anything(),
        expect.anything(),
      );
    });

    it('should throw and log error when Stellar client fails', async () => {
      stellarClient.getBalances.mockRejectedValue(new Error('Horizon timeout'));

      await expect(worker.process(buildJob())).rejects.toThrow('Horizon timeout');
    });

    it('should handle multiple balances with mixed thresholds', async () => {
      const balances: StellarBalance[] = [
        { asset: 'XLM', balance: '3.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '500.0000000', assetType: 'credit_alphanum4' },
      ];
      stellarClient.getBalances.mockResolvedValue(balances);
      cacheService.checkThresholds.mockReturnValue([
        { asset: 'XLM', balance: '3.0000000', threshold: 10 },
      ]);

      const result = await worker.process(buildJob());

      expect(result.balanceCount).toBe(2);
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].asset).toBe('XLM');
    });
  });
});
