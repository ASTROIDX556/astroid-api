import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StellarNetwork, Wallet, WalletStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { WalletService } from './wallet.service';
import { WalletRepository } from './wallet.repository';
import { BalanceCacheService } from './services/balance-cache.service';
import { StellarService } from '../stellar/stellar.service';
import { EventBusService } from '../../events/event-bus.service';
import { ConfigService } from '@nestjs/config';
import { BalanceCacheConfig } from '../../config/balance-cache.config';

const ADDRESS = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const BALANCES = [{ asset: 'XLM', balance: '100.0000000', assetType: 'native' }];

class FakeRedis {
  readonly store = new Map<string, string>();
  get = vi.fn(async (key: string) => this.store.get(key) ?? null);
  setex = vi.fn(async (key: string, _ttl: number, value: string) => {
    this.store.set(key, value);
    return 'OK';
  });
  del = vi.fn(async (key: string) => (this.store.delete(key) ? 1 : 0));
}

function buildConfig(): ConfigService {
  const value: BalanceCacheConfig = { ttlSeconds: 30, environment: 'test' };
  return {
    get: vi.fn((key: string) => (key === 'balanceCache' ? value : undefined)),
  } as unknown as ConfigService;
}

function makeWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet_1',
    organizationId: 'org_1',
    agentId: null,
    stellarAddress: ADDRESS,
    label: 'Treasury',
    walletType: 'AGENT',
    network: StellarNetwork.TESTNET,
    status: WalletStatus.ACTIVE,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  } as Wallet;
}

describe('WalletService.getBalances caching', () => {
  let repository: { findById: ReturnType<typeof vi.fn> };
  let stellar: { getBalances: ReturnType<typeof vi.fn> };
  let cache: BalanceCacheService;
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let service: WalletService;

  beforeEach(() => {
    repository = { findById: vi.fn().mockResolvedValue(makeWallet()) };
    stellar = { getBalances: vi.fn().mockResolvedValue(BALANCES) };
    cache = new BalanceCacheService(buildConfig(), new FakeRedis() as unknown as Redis);
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    service = new WalletService(
      repository as unknown as WalletRepository,
      stellar as unknown as StellarService,
      cache,
      eventBus as unknown as EventBusService,
    );
  });

  it('serves two reads within the TTL from one RPC call with an unchanged shape', async () => {
    const first = await service.getBalances('org_1', 'wallet_1');
    const second = await service.getBalances('org_1', 'wallet_1');

    expect(first).toEqual({
      walletId: 'wallet_1',
      stellarAddress: ADDRESS,
      network: 'testnet',
      balances: BALANCES,
    });
    // The cached response is byte-for-byte the same shape as the live one.
    expect(second).toEqual(first);
    expect(stellar.getBalances).toHaveBeenCalledTimes(1);
    expect(stellar.getBalances).toHaveBeenCalledWith(ADDRESS, 'testnet');
  });

  it('reads the RPC again after the cached balance is invalidated', async () => {
    await service.getBalances('org_1', 'wallet_1');
    await cache.invalidate(ADDRESS, 'testnet');
    await service.getBalances('org_1', 'wallet_1');

    expect(stellar.getBalances).toHaveBeenCalledTimes(2);
  });

  it('never mixes the two networks of the same address', async () => {
    await service.getBalances('org_1', 'wallet_1');
    repository.findById.mockResolvedValue(makeWallet({ network: StellarNetwork.PUBLIC }));
    const publicRead = await service.getBalances('org_1', 'wallet_1');

    expect(publicRead.network).toBe('public');
    expect(stellar.getBalances).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the RPC result when Redis is down', async () => {
    const brokenRedis = new FakeRedis();
    brokenRedis.get.mockRejectedValue(new Error('redis down'));
    brokenRedis.setex.mockRejectedValue(new Error('redis down'));
    const warn = vi
      .spyOn((await import('@nestjs/common')).Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    cache = new BalanceCacheService(buildConfig(), brokenRedis as unknown as Redis);
    service = new WalletService(
      repository as unknown as WalletRepository,
      stellar as unknown as StellarService,
      cache,
      eventBus as unknown as EventBusService,
    );

    await expect(service.getBalances('org_1', 'wallet_1')).resolves.toMatchObject({
      balances: BALANCES,
    });
    expect(stellar.getBalances).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('invalidates the cached balance when the wallet is archived', async () => {
    repository.findById.mockResolvedValue(makeWallet());
    await service.getBalances('org_1', 'wallet_1');

    const invalidate = vi.spyOn(cache, 'invalidate');
    const archivedService = new WalletService(
      {
        findById: vi.fn().mockResolvedValue(makeWallet()),
        softDelete: vi.fn().mockResolvedValue(makeWallet()),
      } as unknown as WalletRepository,
      stellar as unknown as StellarService,
      cache,
      eventBus as unknown as EventBusService,
    );
    await archivedService.remove('org_1', 'user_1', 'wallet_1');

    expect(invalidate).toHaveBeenCalledWith(ADDRESS, 'testnet');
  });
});
