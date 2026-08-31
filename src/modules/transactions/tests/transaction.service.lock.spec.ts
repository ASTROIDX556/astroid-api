import { Test, TestingModule } from '@nestjs/testing';
import { WalletStatus, TransactionStatus, RiskBand, StellarNetwork, Prisma } from '@prisma/client';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Redis } from 'ioredis';

import { TransactionService } from '../transaction.service';
import { TransactionRepository } from '../transaction.repository';
import { WalletService } from '../../wallets/wallet.service';
import { AgentService } from '../../agents/agent.service';
import { PolicyService } from '../../policies/policy.service';
import { RiskService } from '../../risk/risk.service';
import { BudgetService } from '../../budgets/budget.service';
import { StellarService } from '../../stellar/stellar.service';
import { EventBusService } from '../../../events/event-bus.service';
import { PrismaService } from '../../../database/prisma.service';
import { RedisLock } from '../../../common/locks/redis-lock.util';

/** In-memory Redis mock with atomic NX-set and compare-and-delete semantics. */
function createRedisMock() {
  const store = new Map<string, { token: string }>();
  const set = vi.fn(
    async (key: string, value: string, mode: string, ttl: number, nx: string) => {
      if (nx === 'NX') {
        if (store.has(key)) return null;
        store.set(key, { token: value });
        if (mode === 'PX') setTimeout(() => store.delete(key), ttl);
        return 'OK';
      }
      store.set(key, { token: value });
      return 'OK';
    },
  );
  const evalMock = vi.fn(
    async (_script: string, _n: number, key: string, token: string) => {
      const cur = store.get(key);
      if (cur && cur.token === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  );
  return {
    redis: { set, eval: evalMock, status: 'ready', quit: vi.fn().mockResolvedValue('OK') } as unknown as Redis,
    store,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildBaseTransaction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tx-1',
    organizationId: 'org-1',
    walletId: 'wallet-1',
    agentId: null,
    policyId: null,
    budgetId: 'budget-1',
    asset: 'USDC',
    amount: new Prisma.Decimal('1.0000000'),
    senderAddress: 'GBASE',
    recipientAddress: 'GDEST',
    memo: null,
    memoType: null,
    purpose: null,
    status: TransactionStatus.DRAFT,
    riskScore: 0,
    riskBand: RiskBand.LOW,
    requiresApproval: false,
    metadata: null,
    stellarHash: null,
    confirmationCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('TransactionService distributed lock integration', () => {
  let service: TransactionService;
  let repository: {
    findById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let wallets: { getOrThrow: ReturnType<typeof vi.fn> };
  let stellar: { submitPayment: ReturnType<typeof vi.fn> };
  let budgets: { consume: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let lock: RedisLock;
  let store: Map<string, { token: string }>;
  const network = StellarNetwork.TESTNET;
  const WALLET = {
    id: 'wallet-1',
    organizationId: 'org-1',
    stellarAddress: 'GBASE',
    network,
    status: WalletStatus.ACTIVE,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    repository = {
      findById: vi.fn().mockResolvedValue(buildBaseTransaction()),
      update: vi.fn().mockImplementation((_id, data) =>
        Promise.resolve(buildBaseTransaction({ ...data, status: data.status ?? TransactionStatus.SUBMITTED })),
      ),
    };
    wallets = { getOrThrow: vi.fn().mockResolvedValue(WALLET) };
    stellar = { submitPayment: vi.fn().mockResolvedValue({ successful: true, hash: 'abc', ledger: 123 }) };
    budgets = { consume: vi.fn().mockResolvedValue(undefined) };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };

    const { redis, store: s } = createRedisMock();
    store = s;
    lock = new RedisLock(redis);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        { provide: TransactionRepository, useValue: repository },
        { provide: WalletService, useValue: wallets },
        { provide: AgentService, useValue: {} },
        { provide: PolicyService, useValue: {} },
        { provide: RiskService, useValue: {} },
        { provide: BudgetService, useValue: budgets },
        { provide: StellarService, useValue: stellar },
        { provide: EventBusService, useValue: eventBus },
        { provide: PrismaService, useValue: {} },
        { provide: RedisLock, useValue: lock },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
  });

  it('acquires a per-wallet lock keyed by the Stellar account before submitting', async () => {
    await service.execute('org-1', 'tx-1', 'actor-1');

    expect(stellar.submitPayment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAddress: 'GBASE' }),
    );
    expect(store.has('lock:stellar_account:GBASE')).toBe(false);
  });

  it('serializes concurrent submissions for the same wallet so only one runs at a time', async () => {
    // Pre-hold the wallet lock so first contenders observe contention.
    const release = await lock.acquire('stellar_account:GBASE', { retries: 0 });

    let active = 0;
    let maxActive = 0;
    stellar.submitPayment.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(2);
      active--;
      return { successful: true, hash: 'abc', ledger: 123 };
    });

    const executions = Promise.all([
      service.execute('org-1', 'tx-1'),
      service.execute('org-1', 'tx-1'),
      service.execute('org-1', 'tx-1'),
    ]);

    await sleep(5);
    await release();
    await executions;

    expect(stellar.submitPayment).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });
});