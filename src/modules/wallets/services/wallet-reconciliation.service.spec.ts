import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma, StellarNetwork } from '@prisma/client';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import {
  WalletReconciliationTarget,
  WalletRepository,
} from '../wallet.repository';
import { StellarService } from '../../stellar/stellar.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { WalletReconciliationConfig } from '../../../config/wallet-reconciliation.config';

const SETTINGS: WalletReconciliationConfig = {
  enabled: true,
  intervalMs: 15 * 60 * 1000,
  concurrency: 2,
  driftThreshold: 0.5,
};

function wallet(
  id: string,
  balance: string | null,
  overrides: Partial<WalletReconciliationTarget> = {},
): WalletReconciliationTarget {
  return {
    id,
    organizationId: 'org_1',
    stellarAddress: `G${id.toUpperCase().padEnd(55, 'A')}`,
    network: StellarNetwork.TESTNET,
    balance: balance === null ? null : new Prisma.Decimal(balance),
    ...overrides,
  };
}

describe('WalletReconciliationService', () => {
  let service: WalletReconciliationService;
  let wallets: {
    findActiveForReconciliation: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let stellar: { getNativeBalance: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    wallets = {
      findActiveForReconciliation: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(async () => wallet('w1', '10')),
    };
    stellar = { getNativeBalance: vi.fn().mockResolvedValue('10.0000000') };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    service = new WalletReconciliationService(
      wallets as unknown as WalletRepository,
      stellar as unknown as StellarService,
      eventBus as unknown as EventBusService,
      { get: vi.fn(() => SETTINGS) } as unknown as ConfigService,
    );
  });

  it('reconciles an active wallet and persists the new balance and lastSyncedAt', async () => {
    const target = wallet('w1', '5');
    wallets.findActiveForReconciliation.mockResolvedValue([target]);
    stellar.getNativeBalance.mockResolvedValue('25.5000000');

    const summary = await service.reconcile();

    expect(stellar.getNativeBalance).toHaveBeenCalledWith(
      target.stellarAddress,
      'testnet',
    );
    expect(wallets.update).toHaveBeenCalledWith(target.id, {
      balance: new Prisma.Decimal('25.5'),
      lastSyncedAt: expect.any(Date),
    });
    expect(summary).toEqual({ processed: 1, updated: 1, drifted: 1, failed: 0 });
  });

  it('leaves the stored balance untouched when the upstream request fails', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([wallet('w1', '10')]);
    stellar.getNativeBalance.mockRejectedValue(new Error('horizon unavailable'));

    const summary = await service.reconcile();

    expect(wallets.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(summary).toEqual({ processed: 1, updated: 0, drifted: 0, failed: 1 });
  });

  it('does not interrupt the run when one wallet fails', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([
      wallet('w1', '10'),
      wallet('w2', '10'),
      wallet('w3', '10'),
    ]);
    stellar.getNativeBalance
      .mockRejectedValueOnce(new Error('horizon 503'))
      .mockResolvedValue('11');

    const summary = await service.reconcile();

    expect(summary.processed).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.updated).toBe(2);
    expect(wallets.update).toHaveBeenCalledTimes(2);
  });

  it('emits one drift event when the difference exceeds the threshold', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([wallet('w1', '10')]);
    stellar.getNativeBalance.mockResolvedValue('20');

    await service.reconcile();

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.WalletBalanceDriftDetected,
      expect.objectContaining({
        walletId: 'w1',
        previousBalance: '10.0000000',
        newBalance: '20.0000000',
        reconciledAt: expect.any(String),
      }),
      expect.objectContaining({ organizationId: 'org_1', aggregateId: 'w1' }),
    );
  });

  it('does not emit when the difference stays below the threshold', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([wallet('w1', '10')]);
    stellar.getNativeBalance.mockResolvedValue('10.4');

    const summary = await service.reconcile();

    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(summary.drifted).toBe(0);
    expect(wallets.update).toHaveBeenCalledTimes(1);
  });

  it('does not emit a drift event for a wallet with no previous snapshot', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([wallet('w1', null)]);
    stellar.getNativeBalance.mockResolvedValue('99');

    const summary = await service.reconcile();

    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(summary.updated).toBe(1);
  });

  it('processes wallets with bounded concurrency', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([
      wallet('w1', '10'),
      wallet('w2', '10'),
      wallet('w3', '10'),
      wallet('w4', '10'),
      wallet('w5', '10'),
    ]);
    let active = 0;
    let maxActive = 0;
    stellar.getNativeBalance.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return '10';
    });

    await service.reconcile();

    expect(maxActive).toBe(2);
    expect(wallets.update).toHaveBeenCalledTimes(5);
  });

  it('emits at most one event per wallet per run', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([
      wallet('w1', '10'),
      wallet('w2', '10'),
    ]);
    stellar.getNativeBalance.mockResolvedValue('30');

    await service.reconcile();

    const walletIds = eventBus.emit.mock.calls.map(
      ([, payload]) => (payload as { walletId: string }).walletId,
    );
    expect(walletIds.sort()).toEqual(['w1', 'w2']);
  });

  it('treats an unparsable upstream balance as a failure without writing', async () => {
    wallets.findActiveForReconciliation.mockResolvedValue([wallet('w1', '10')]);
    stellar.getNativeBalance.mockResolvedValue('not-a-number');

    const summary = await service.reconcile();

    expect(wallets.update).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });
});
