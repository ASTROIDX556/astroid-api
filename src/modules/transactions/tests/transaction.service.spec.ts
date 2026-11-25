import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TransactionService } from '../transaction.service';
import { TransactionRepository } from '../transaction.repository';
import { WalletService } from '../../wallets/wallet.service';
import { AgentService } from '../../agents/agent.service';
import { PolicyService } from '../../policies/policy.service';
import { RiskAggregatorService } from '../../risk/risk-aggregator.service';
import { BudgetService } from '../../budgets/budget.service';
import { StellarService } from '../../stellar/stellar.service';
import { SpendingLimitService } from '../spending-limit.service';
import { EventBusService } from '../../../events/event-bus.service';
import { PrismaService } from '../../../database/prisma.service';
import { AgentStatus, RiskBand, TransactionStatus, WalletStatus } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { CreateTransactionInput } from '../transaction.dto';
import { DomainException, ForbiddenException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { parseIdempotencyKey } from '../transaction.dto';
import { PrismaTransactionService } from '../../../database/prisma-transaction.service';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { IdempotencyRecord } from '@prisma/client';
import { TransactionPreflightService } from '../services/transaction-preflight.service';

/**
 * Stand-in transaction manager that runs the callback straight through with a
 * stand-in client, so the specs keep exercising real TransactionService logic
 * without a live database (same pattern as budget.service-lock.spec.ts).
 */
const passthroughTxService = {
  runWithRetry: (fn: (tx: never) => Promise<unknown>) => fn({} as never),
} as unknown as PrismaTransactionService;

/**
 * In-memory stand-in for the `transaction_idempotency_records` table. The real
 * IdempotencyService runs against it, so the specs exercise the production
 * reservation/replay logic without a database.
 */
function createIdempotencyPrisma(): PrismaService {
  const rows = new Map<string, IdempotencyRecord>();
  let sequence = 0;
  const findByIdentity = (where: Record<string, unknown>) =>
    [...rows.values()].find(
      (row) =>
        row.scope === (where.scope ?? where.principalId) &&
        row.route === where.route &&
        row.keyHash === where.keyHash,
    );

  return {
    idempotencyRecord: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [id, row] of rows) {
          if (typeof where.id === 'string' && where.id !== id) continue;
          if (typeof where.principalId === 'string' && where.principalId !== row.principalId) continue;
          if (typeof where.scope === 'string' && where.scope !== row.scope) continue;
          if (typeof where.route === 'string' && where.route !== row.route) continue;
          if (typeof where.keyHash === 'string' && where.keyHash !== row.keyHash) continue;
          const expiry = where.expiresAt as { lte?: Date } | undefined;
          if (expiry?.lte && row.expiresAt.getTime() > expiry.lte.getTime()) continue;
          if ('transactionId' in where && where.transactionId === null && row.transactionId !== null) {
            continue;
          }
          rows.delete(id);
          count += 1;
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (findByIdentity(data)) throw { code: 'P2002' };
        const row: IdempotencyRecord = {
          id: `idempotency_${(sequence += 1)}`,
          principalId: data.principalId as string,
          scope: (data.scope as string | undefined) ?? (data.principalId as string),
          route: data.route as string,
          keyHash: data.keyHash as string,
          requestHash: data.requestHash as string,
          status: 'PROCESSING',
          transactionId: null,
          responseBody: null,
          responseStatus: null,
          requestId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: data.expiresAt as Date,
        };
        rows.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.id === 'string') return rows.get(where.id) ?? null;
        const identity = where.scope_route_keyHash as Record<string, unknown>;
        return findByIdentity(identity) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error(`missing idempotency record ${where.id}`);
        const updated = { ...row, ...data } as IdempotencyRecord;
        rows.set(row.id, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matching = [...rows.values()].filter(
          (row) => row.transactionId === where.transactionId && row.status === where.status,
        );
        for (const row of matching) {
          rows.set(row.id, { ...row, ...data } as IdempotencyRecord);
        }
        return { count: matching.length };
      }),
    },
  } as unknown as PrismaService;
}

describe('TransactionService', () => {
  describe('Governance simulation', () => {
    let service: TransactionService;
    let repository: {
      create: ReturnType<typeof vi.fn>;
    };
    let policyService: { evaluateIntent: ReturnType<typeof vi.fn> };
    let riskAggregator: { assess: ReturnType<typeof vi.fn> };
    let eventBus: { emit: ReturnType<typeof vi.fn> };
    let stellarService: { submitPayment: ReturnType<typeof vi.fn> };

    const input: CreateTransactionInput = {
      walletId: 'wallet_1',
      asset: 'XLM',
      amount: '50.0',
      recipientAddress: Keypair.random().publicKey(),
      metadata: {},
    };

    beforeEach(() => {
      repository = {
        create: vi.fn(),
      };
      policyService = {
        evaluateIntent: vi.fn().mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
        }),
      };
      riskAggregator = {
        assess: vi.fn().mockResolvedValue({
          score: 10,
          band: RiskBand.LOW,
          factors: [],
          canAutoExecute: true,
          requiresApproval: false,
          signals: {
            recentTransactionCount: 0,
            recentTransactionAmount: 0,
            destinationSuccessfulPayments: 0,
            destinationFailedPayments: 0,
            amountBaseline: null,
          },
        }),
      };
      eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
      stellarService = { submitPayment: vi.fn() };

      service = new TransactionService(
        repository as unknown as TransactionRepository,
        {
          getOrThrow: vi.fn().mockResolvedValue({
            id: 'wallet_1',
            status: WalletStatus.ACTIVE,
            stellarAddress: Keypair.random().publicKey(),
            network: 'TESTNET',
            createdAt: new Date(),
          }),
        } as unknown as WalletService,
        { getOrThrow: vi.fn() } as unknown as AgentService,
        policyService as unknown as PolicyService,
        riskAggregator as unknown as RiskAggregatorService,
        {} as BudgetService,
        stellarService as unknown as StellarService,
        eventBus as unknown as EventBusService,
        { proposal: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaService,
        {
          aggregateSpend: vi.fn().mockResolvedValue({
            spentToday: 0,
            spentThisWeek: 0,
            spentThisMonth: 0,
          }),
          evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
          withSpendEnforcementLock: vi.fn(async (_agentId: string, fn: () => Promise<unknown>) => fn()),
        } as unknown as SpendingLimitService,
        passthroughTxService,
      );
    });

    it('returns policy and risk results without persisting or broadcasting', async () => {
      const result = await service.simulate('org_1', input);

      expect(result).toMatchObject({
        wouldPass: true,
        requiresApproval: false,
        policy: { passed: true, violations: [] },
        risk: { score: 10, band: RiskBand.LOW },
      });
      expect(riskAggregator.assess).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org_1',
          walletId: 'wallet_1',
          recipientAddress: input.recipientAddress,
          amount: 50,
        }),
      );
      expect(repository.create).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(stellarService.submitPayment).not.toHaveBeenCalled();
    });

    it('flags high-risk assessments for approval during a dry run', async () => {
      riskAggregator.assess.mockResolvedValueOnce({
        score: 65,
        band: RiskBand.HIGH,
        factors: [],
        canAutoExecute: true,
        requiresApproval: true,
        signals: {
          recentTransactionCount: 20,
          recentTransactionAmount: 0,
          destinationSuccessfulPayments: 0,
          destinationFailedPayments: 0,
          amountBaseline: null,
        },
      });

      const result = await service.simulate('org_1', input);

      expect(result.wouldPass).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(repository.create).not.toHaveBeenCalled();
      expect(stellarService.submitPayment).not.toHaveBeenCalled();
    });
  });
});

describe('TransactionService - create', () => {
  let service: TransactionService;
  let stellarService: StellarService;
  let transactionRepository: TransactionRepository;
  let idempotencyService: IdempotencyService;
  let idempotencySettings: {
    keyTtlMs: number;
    waitTimeoutMs: number;
    pollIntervalMs: number;
  };
  let transactionPreflight: { simulate: ReturnType<typeof vi.fn> };

  const wallet = {
    id: 'wallet_1',
    status: WalletStatus.ACTIVE,
    stellarAddress: 'GDWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'TESTNET',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    idempotencySettings = {
      keyTtlMs: 24 * 60 * 60 * 1000,
      waitTimeoutMs: 1_000,
      pollIntervalMs: 5,
    };
    transactionPreflight = {
      simulate: vi.fn().mockResolvedValue({
        kind: 'ok',
        simulatedAt: new Date('2026-11-24T11:00:00.000Z'),
        minResourceFee: '125000',
        footprintSummary: { readOnlyCount: 1, readWriteCount: 2 },
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: ConfigService,
          useValue: { get: vi.fn(() => idempotencySettings) },
        },
        {
          provide: TransactionRepository,
          useValue: (() => {
            let stored: Record<string, unknown> | undefined;
            return {
              create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
                stored = { id: 'tx_1', ...data, status: data.status ?? TransactionStatus.DRAFT };
                return Promise.resolve(stored);
              }),
              update: vi.fn().mockImplementation((id: string, data: Record<string, unknown>) => {
                stored = { ...stored, id, ...data };
                return Promise.resolve(stored);
              }),
              findById: vi.fn().mockImplementation(() => Promise.resolve(stored)),
            };
          })(),
        },
        { provide: IdempotencyService, useValue: new IdempotencyService(createIdempotencyPrisma()) },
        { provide: WalletService, useValue: { getOrThrow: vi.fn().mockResolvedValue(wallet) } },
        {
          provide: AgentService,
          useValue: {
            getOrThrow: vi.fn().mockResolvedValue({ id: 'agent_1', status: AgentStatus.ACTIVE }),
          },
        },
        {
          provide: PolicyService,
          useValue: {
            checkVelocityLimit: vi.fn().mockResolvedValue(undefined),
            evaluateIntent: vi.fn().mockResolvedValue({
              passed: true,
              requiresApproval: false,
              violations: [],
              evaluatedPolicyIds: [],
            }),
          },
        },
        {
          provide: RiskAggregatorService,
          useValue: {
            assess: vi.fn().mockResolvedValue({
              score: 10,
              band: RiskBand.LOW,
              factors: [],
              canAutoExecute: true,
              requiresApproval: false,
              signals: {
                recentTransactionCount: 0,
                recentTransactionAmount: 0,
                destinationSuccessfulPayments: 0,
                destinationFailedPayments: 0,
                amountBaseline: null,
              },
            }),
            record: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: BudgetService,
          useValue: {
            reserveAtomic: vi.fn().mockResolvedValue({ id: 'rsv_1' }),
            settle: vi.fn().mockResolvedValue(undefined),
            release: vi.fn().mockResolvedValue(undefined),
            assertAgentBudgetWithinLimit: vi.fn().mockResolvedValue(undefined),
            withAgentBudgetLimit: vi.fn(
              (_organizationId, _agentId, _asset, _amount, operation) => operation(),
            ),
            consume: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StellarService,
          useValue: {
            buildPaymentXdr: vi.fn().mockResolvedValue('safe-payment-xdr'),
            submitPayment: vi.fn().mockResolvedValue({
              hash: 'stellar_hash_1',
              ledger: 100,
              successful: true,
            }),
          },
        },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: PrismaService,
          useValue: { proposal: { findUnique: vi.fn().mockResolvedValue(null) } },
        },
        { provide: PrismaTransactionService, useValue: passthroughTxService },
        { provide: TransactionPreflightService, useValue: transactionPreflight },
        {
          provide: SpendingLimitService,
          useValue: {
            aggregateSpend: vi.fn().mockResolvedValue({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 }),
            evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
            withSpendEnforcementLock: vi.fn(async (_agentId: string, fn: () => Promise<unknown>) => fn()),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
    transactionRepository = module.get<TransactionRepository>(TransactionRepository);
    idempotencyService = module.get<IdempotencyService>(IdempotencyService);
    stellarService = module.get<StellarService>(StellarService);
  });

  const input = {
    walletId: 'wallet_1',
    agentId: 'agent_1',
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
    amount: '50.0',
    asset: 'XLM',
    memo: 'Test payment',
    metadata: {},
  };

  it('auto-executes and submits on-chain when policy and risk allow it', async () => {
    const result = await service.create('org_1', 'user_1', input);

    expect(transactionPreflight.simulate).toHaveBeenCalledWith('safe-payment-xdr');
    expect(transactionRepository.update).toHaveBeenNthCalledWith(
      1,
      'tx_1',
      expect.objectContaining({
        simulatedAt: new Date('2026-11-24T11:00:00.000Z'),
        minResourceFee: expect.anything(),
        footprintSummary: { readOnlyCount: 1, readWriteCount: 2 },
      }),
      expect.any(Object),
    );
    expect(stellarService.submitPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAddress: wallet.stellarAddress,
        destinationAddress: input.recipientAddress,
        asset: input.asset,
      }),
    );
    expect(result.requiresApproval).toBe(false);
    expect(result.transaction.status).toBe(TransactionStatus.COMPLETED);
  });

  it('marks a failed simulation terminal and never submits the payment', async () => {
    transactionPreflight.simulate.mockResolvedValueOnce({
      kind: 'terminal_error',
      code: 'txINSUFFICIENT_BALANCE',
      message: 'not enough balance',
      simulatedAt: new Date('2026-11-24T11:01:00.000Z'),
    });

    await expect(service.create('org_1', 'user_1', input)).rejects.toThrow(
      'Transaction simulation failed (txINSUFFICIENT_BALANCE): not enough balance',
    );

    expect(stellarService.submitPayment).not.toHaveBeenCalled();
    expect(transactionRepository.update).toHaveBeenCalledWith(
      'tx_1',
      expect.objectContaining({
        status: TransactionStatus.FAILED,
        simulationErrorCode: 'txINSUFFICIENT_BALANCE',
        simulationErrorMessage: 'not enough balance',
      }),
    );
  });

  it('routes a high-risk transaction into the approval workflow instead of executing it', async () => {
    const proposal = { id: 'proposal_1', requiredApprovals: 2 };
    const highRiskModule: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TransactionRepository,
          useValue: {
            create: vi.fn().mockResolvedValue({
              id: 'tx_1',
              amount: { toFixed: () => '50.0000000' },
              asset: 'XLM',
              status: TransactionStatus.DRAFT,
            }),
            update: vi.fn().mockResolvedValue({ id: 'tx_1' }),
            findById: vi.fn().mockResolvedValue(null),
          },
        },
        { provide: WalletService, useValue: { getOrThrow: vi.fn().mockResolvedValue(wallet) } },
        {
          provide: AgentService,
          useValue: {
            getOrThrow: vi.fn().mockResolvedValue({ id: 'agent_1', status: AgentStatus.ACTIVE }),
          },
        },
        {
          provide: PolicyService,
          useValue: {
            checkVelocityLimit: vi.fn().mockResolvedValue(undefined),
            evaluateIntent: vi.fn().mockResolvedValue({
              passed: true,
              requiresApproval: false,
              violations: [],
              evaluatedPolicyIds: [],
            }),
          },
        },
        {
          provide: RiskAggregatorService,
          useValue: {
            assess: vi.fn().mockResolvedValue({
              score: 65,
              band: RiskBand.HIGH,
              factors: [],
              canAutoExecute: true,
              requiresApproval: true,
              signals: {
                recentTransactionCount: 20,
                recentTransactionAmount: 0,
                destinationSuccessfulPayments: 0,
                destinationFailedPayments: 0,
                amountBaseline: null,
              },
            }),
            record: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: BudgetService, useValue: { reserveAtomic: vi.fn(), consume: vi.fn() } },
        { provide: StellarService, useValue: { submitPayment: vi.fn() } },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: PrismaService,
          useValue: { proposal: { create: vi.fn().mockResolvedValue(proposal) } },
        },
        {
          provide: SpendingLimitService,
          useValue: {
            aggregateSpend: vi.fn().mockResolvedValue({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 }),
            evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
            withSpendEnforcementLock: vi.fn(async (_agentId: string, fn: () => Promise<unknown>) => fn()),
          },
        },
      ],
    }).compile();
    const highRiskService = highRiskModule.get<TransactionService>(TransactionService);
    const highRiskStellar = highRiskModule.get<StellarService>(StellarService);
    const highRiskRepository = highRiskModule.get<TransactionRepository>(TransactionRepository);
    const highRiskAggregator = highRiskModule.get<RiskAggregatorService>(RiskAggregatorService);

    const result = await highRiskService.create('org_1', 'user_1', input);

    expect(result.requiresApproval).toBe(true);
    expect(result.transaction.status).toBe(TransactionStatus.PENDING);
    expect(highRiskStellar.submitPayment).not.toHaveBeenCalled();
    expect(highRiskRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        riskScore: 65,
        riskBand: RiskBand.HIGH,
        requiresApproval: true,
      }),
    );
    expect(highRiskAggregator.record).toHaveBeenCalledWith(
      'org_1',
      'tx_1',
      expect.objectContaining({ score: 65, requiresApproval: true }),
      { actorId: 'user_1' },
    );
  });

  it('does not touch idempotency storage when no key is supplied', async () => {
    const reserve = vi.spyOn(idempotencyService, 'reserve');

    await service.create('org_1', 'user_1', input);

    expect(reserve).not.toHaveBeenCalled();
  });

  it('replays a matching request without creating or submitting another transaction', async () => {
    const first = await service.create('org_1', 'user_1', input, {
      principalId: 'principal_1',
      key: 'transaction-key-1',
    });
    const replay = await service.create(
      'org_1',
      'user_1',
      { ...input, amount: '50.0000000' },
      { principalId: 'principal_1', key: 'transaction-key-1' },
    );

    expect(replay).toMatchObject({ transaction: { id: 'tx_1', status: TransactionStatus.COMPLETED } });
    expect(first.transaction.id).toBe(replay.transaction.id);
    expect(transactionRepository.create).toHaveBeenCalledTimes(1);
    expect(stellarService.submitPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a key with a different payload as a 422 mismatch', async () => {
    await service.create('org_1', 'user_1', input, {
      principalId: 'principal_1',
      key: 'transaction-key-2',
    });

    await expect(
      service.create('org_1', 'user_1', { ...input, amount: '51.0' }, {
        principalId: 'principal_1',
        key: 'transaction-key-2',
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: ErrorCode.IDEMPOTENCY_KEY_MISMATCH,
    });
    expect(transactionRepository.create).toHaveBeenCalledTimes(1);
    expect(stellarService.submitPayment).toHaveBeenCalledTimes(1);
  });

  it('stores the configured retention window as the record expiry', async () => {
    idempotencySettings.keyTtlMs = 3_600_000;
    const reserve = vi.spyOn(idempotencyService, 'reserve');
    const before = Date.now();

    await service.create('org_1', 'user_1', input, {
      principalId: 'principal_1',
      key: 'transaction-key-ttl',
    });

    const expiresAt = reserve.mock.calls[0][0].expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('ignores an expired key and processes a fresh transaction', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await service.create('org_1', 'user_1', input, {
        principalId: 'principal_1',
        key: 'transaction-key-expired',
      });

      // One millisecond past the 24h retention window.
      vi.setSystemTime(new Date('2026-01-02T00:00:00.001Z'));
      await service.create('org_1', 'user_1', input, {
        principalId: 'principal_1',
        key: 'transaction-key-expired',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(transactionRepository.create).toHaveBeenCalledTimes(2);
    expect(stellarService.submitPayment).toHaveBeenCalledTimes(2);
  });

  it('executes exactly once when concurrent requests share a key', async () => {
    const [first, second] = await Promise.all([
      service.create('org_1', 'user_1', input, {
        principalId: 'principal_1',
        key: 'transaction-key-concurrent',
      }),
      service.create('org_1', 'user_1', input, {
        principalId: 'principal_1',
        key: 'transaction-key-concurrent',
      }),
    ]);

    expect(second.transaction.id).toBe(first.transaction.id);
    expect(transactionRepository.create).toHaveBeenCalledTimes(1);
    expect(stellarService.submitPayment).toHaveBeenCalledTimes(1);
  });

  it('scopes the same key independently to each authenticated principal', async () => {
    await service.create('org_1', 'user_1', input, {
      principalId: 'principal_1',
      key: 'shared-key',
    });
    await service.create('org_1', 'user_2', input, {
      principalId: 'principal_2',
      key: 'shared-key',
    });

    expect(transactionRepository.create).toHaveBeenCalledTimes(2);
    expect(stellarService.submitPayment).toHaveBeenCalledTimes(2);
  });

  it('blocks a policy-violating transaction before submission', async () => {
    const blockedPolicy = {
      checkVelocityLimit: vi.fn().mockResolvedValue(undefined),
      evaluateIntent: vi.fn().mockResolvedValue({
        passed: false,
        requiresApproval: false,
        violations: [{ policyId: 'policy_1', reason: 'exceeds max amount' }],
        evaluatedPolicyIds: ['policy_1'],
      }),
    };
    const blockedModule: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        { provide: TransactionRepository, useValue: { create: vi.fn(), update: vi.fn() } },
        { provide: WalletService, useValue: { getOrThrow: vi.fn().mockResolvedValue(wallet) } },
        {
          provide: AgentService,
          useValue: { getOrThrow: vi.fn().mockResolvedValue({ id: 'agent_1', status: AgentStatus.ACTIVE }) },
        },
        { provide: PolicyService, useValue: blockedPolicy },
        { provide: RiskAggregatorService, useValue: { assess: vi.fn(), record: vi.fn() } },
        { provide: BudgetService, useValue: { assertWithinBudget: vi.fn(), consume: vi.fn() } },
        { provide: StellarService, useValue: { submitPayment: vi.fn() } },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: PrismaService,
          useValue: { proposal: { findUnique: vi.fn().mockResolvedValue(null) } },
        },
        { provide: PrismaTransactionService, useValue: passthroughTxService },
        {
          provide: SpendingLimitService,
          useValue: {
            aggregateSpend: vi.fn().mockResolvedValue({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 }),
            evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
            withSpendEnforcementLock: vi.fn(async (_agentId: string, fn: () => Promise<unknown>) => fn()),
          },
        },
      ],
    }).compile();
    const blockedService = blockedModule.get<TransactionService>(TransactionService);
    const blockedStellar = blockedModule.get<StellarService>(StellarService);

    const error = await blockedService.create('org_1', 'user_1', input).catch(
      (reason: unknown) => reason as DomainException,
    );

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ErrorCode.POLICY_VIOLATION);
    expect(blockedStellar.submitPayment).not.toHaveBeenCalled();
  });

  describe('budget reservation lifecycle', () => {
    const budgeted = { ...input, budgetId: 'budget_1' };
    let budgets: {
      reserveAtomic: ReturnType<typeof vi.fn>;
      settle: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
      withAgentBudgetLimit: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      budgets = (service as unknown as { budgets: typeof budgets }).budgets;
      // Mirror the real repository: the connected reservation is readable as
      // `budgetReservationId` on the stored row.
      const create = vi.mocked(transactionRepository.create);
      const original = create.getMockImplementation() as TransactionRepository['create'];
      create.mockImplementation((data) => {
        const connect = (data.budgetReservation as { connect?: { id: string } } | undefined)?.connect;
        return original({
          ...data,
          budgetId: 'budget_1',
          budgetReservationId: connect?.id ?? null,
        } as unknown as Parameters<TransactionRepository['create']>[0]);
      });
    });

    it('settles the reservation after a successful payment and never releases it', async () => {
      const result = await service.create('org_1', 'user_1', budgeted);

      expect(budgets.reserveAtomic).toHaveBeenCalledWith('org_1', 'budget_1', 50);
      expect(budgets.settle).toHaveBeenCalledWith('org_1', 'rsv_1', 50);
      expect(budgets.release).not.toHaveBeenCalled();
      expect(result.transaction.status).toBe(TransactionStatus.COMPLETED);
    });

    it('releases the reservation when the agent budget check rejects after it was taken', async () => {
      budgets.withAgentBudgetLimit.mockRejectedValueOnce(
        new ForbiddenException("Transaction would exceed the active budget 'Agent cap'"),
      );

      await expect(service.create('org_1', 'user_1', budgeted)).rejects.toBeInstanceOf(ForbiddenException);

      expect(budgets.release).toHaveBeenCalledTimes(1);
      expect(budgets.release).toHaveBeenCalledWith('rsv_1');
      expect(stellarService.submitPayment).not.toHaveBeenCalled();
    });

    it('releases the reservation when the transaction row cannot be persisted', async () => {
      vi.mocked(transactionRepository.create).mockRejectedValueOnce(new Error('insert failed'));

      await expect(service.create('org_1', 'user_1', budgeted)).rejects.toThrow('insert failed');

      expect(budgets.release).toHaveBeenCalledWith('rsv_1');
    });

    it('releases the reservation when the network rejects the payment without throwing', async () => {
      vi.mocked(stellarService.submitPayment).mockResolvedValueOnce({
        hash: 'stellar_hash_failed',
        ledger: 0,
        successful: false,
      } as Awaited<ReturnType<StellarService['submitPayment']>>);

      const result = await service.create('org_1', 'user_1', budgeted);

      expect(result.transaction.status).toBe(TransactionStatus.FAILED);
      expect(budgets.settle).not.toHaveBeenCalled();
      expect(budgets.release).toHaveBeenCalledTimes(1);
      expect(budgets.release).toHaveBeenCalledWith('rsv_1');
    });

    it('releases the reservation when the submission throws', async () => {
      vi.mocked(stellarService.submitPayment).mockRejectedValueOnce(new Error('horizon timeout'));

      await expect(service.create('org_1', 'user_1', budgeted)).rejects.toThrow('horizon timeout');

      expect(budgets.settle).not.toHaveBeenCalled();
      expect(budgets.release).toHaveBeenCalledTimes(1);
      expect(budgets.release).toHaveBeenCalledWith('rsv_1');
    });

    it('does not take a reservation for a transaction without a budget', async () => {
      await service.create('org_1', 'user_1', input);

      expect(budgets.reserveAtomic).not.toHaveBeenCalled();
      expect(budgets.release).not.toHaveBeenCalled();
    });
  });
});

describe('parseIdempotencyKey', () => {
  it('accepts an absent or correctly formatted key', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('key_01.A~b-2')).toBe('key_01.A~b-2');
  });

  it.each(['', 'white space', 'non-ascii-é', 'x'.repeat(129), ['duplicate', 'header']])(
    'rejects an invalid key format',
    (key) => {
      expect(() => parseIdempotencyKey(key)).toThrow(DomainException);
    },
  );
});
