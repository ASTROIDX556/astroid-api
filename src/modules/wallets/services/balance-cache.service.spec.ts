import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { BalanceCacheService } from './balance-cache.service';

function buildMockConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      const config: Record<string, unknown> = {
        BALANCE_CACHE_TTL: 60,
        LOW_XLM_THRESHOLD: 10,
        REDIS_URL: undefined, // no Redis in tests
        ...overrides,
      };
      return config[key] ?? defaultValue;
    }),
  } as unknown as ConfigService;
}

describe('BalanceCacheService', () => {
  let service: BalanceCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BalanceCacheService(buildMockConfig());
  });

  describe('get/set', () => {
    it('should store and retrieve cached balances', async () => {
      const balances = [
        { asset: 'XLM', balance: '100.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '50.0000000', assetType: 'credit_alphanum4' },
      ];

      await service.set('GABC...', 'testnet', balances);
      const cached = await service.get('GABC...', 'testnet');

      expect(cached).not.toBeNull();
      expect(cached!.address).toBe('GABC...');
      expect(cached!.network).toBe('testnet');
      expect(cached!.balances).toHaveLength(2);
      expect(cached!.balances[0].asset).toBe('XLM');
    });

    it('should return null for cache miss', async () => {
      const result = await service.get('GMISS...', 'testnet');
      expect(result).toBeNull();
    });

    it('should invalidate cached data', async () => {
      await service.set('GABC...', 'testnet', [
        { asset: 'XLM', balance: '100.0000000', assetType: 'native' },
      ]);
      await service.invalidate('GABC...', 'testnet');
      const result = await service.get('GABC...', 'testnet');
      expect(result).toBeNull();
    });

    it('should use different cache keys for different networks', async () => {
      const balances = [
        { asset: 'XLM', balance: '100.0000000', assetType: 'native' },
      ];

      await service.set('GABC...', 'testnet', balances);
      await service.set('GABC...', 'public', [
        { asset: 'XLM', balance: '200.0000000', assetType: 'native' },
      ]);

      const testnet = await service.get('GABC...', 'testnet');
      const publicNet = await service.get('GABC...', 'public');

      expect(testnet!.balances[0].balance).toBe('100.0000000');
      expect(publicNet!.balances[0].balance).toBe('200.0000000');
    });
  });

  describe('checkThresholds', () => {
    it('should detect low XLM balance', () => {
      const balances = [
        { asset: 'XLM', balance: '5.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '1000.0000000', assetType: 'credit_alphanum4' },
      ];

      const alerts = service.checkThresholds(balances);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].asset).toBe('XLM');
      expect(alerts[0].balance).toBe('5.0000000');
      expect(alerts[0].threshold).toBe(10);
    });

    it('should not alert for healthy balances', () => {
      const balances = [
        { asset: 'XLM', balance: '100.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '1000.0000000', assetType: 'credit_alphanum4' },
      ];

      const alerts = service.checkThresholds(balances);
      expect(alerts).toHaveLength(0);
    });

    it('should return empty array when no thresholds configured', () => {
      const balances = [
        { asset: 'XLM', balance: '1.0000000', assetType: 'native' },
        { asset: 'UNKNOWN', balance: '0.001', assetType: 'credit_alphanum12' },
      ];

      const alerts = service.checkThresholds(balances);
      // XLM should alert, UNKNOWN has no threshold
      expect(alerts).toHaveLength(1);
      expect(alerts[0].asset).toBe('XLM');
    });
  });

  describe('getTtlSeconds', () => {
    it('should return configured TTL', () => {
      expect(service.getTtlSeconds()).toBe(60);
    });

    it('should use custom TTL from config', () => {
      const customService = new BalanceCacheService(
        buildMockConfig({ BALANCE_CACHE_TTL: 120 }),
      );
      expect(customService.getTtlSeconds()).toBe(120);
    });
  });
});
