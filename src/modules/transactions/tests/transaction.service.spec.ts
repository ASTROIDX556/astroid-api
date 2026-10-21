import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
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
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { parseIdempotencyKey } from '../transaction.dto';

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
        {} as PrismaService,
        {
          aggregateSpend: vi.fn().mockResolvedValue({
            spentToday: 0,
            spentThisWeek: 0,
            spentThisMonth: 0,
          }),
          evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpendingLimitService,
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

  const wallet = {
    id: 'wallet_1',
    status: WalletStatus.ACTIVE,
    stellarAddress: 'GDWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'TESTNET',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TransactionRepository,
          useValue: (() => {
            let stored: Record<string, unknown> | undefined;
            const idempotencyRecords = new Map<string, Record<string, unknown>>();
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
              reserveIdempotencyKey: vi.fn().mockImplementation((input: Record<string, unknown>) => {
                const recordKey = `${input.principalId}:${input.operation}:${input.keyHash}`;
                const existing = idempotencyRecords.get(recordKey);
                if (existing) return Promise.resolve({ record: existing, created: false });
                const record = {
                  id: `idempotency_${idempotencyRecords.size + 1}`,
                  ...input,
                  status: 'PROCESSING',
                  transactionId: null,
                  response: null,
                };
                idempotencyRecords.set(recordKey, record);
                return Promise.resolve({ record, created: true });
              }),
              attachIdempotencyTransaction: vi.fn().mockImplementation((id: string, transactionId: string) => {
                const record = [...idempotencyRecords.values()].find((item) => item.id === id);
                if (record) record.transactionId = transactionId;
                return Promise.resolve(record);
              }),
              completeIdempotencyKey: vi.fn().mockImplementation((id: string, transactionId: string, response: unknown) => {
                const record = [...idempotencyRecords.values()].find((item) => item.id === id);
                if (record) Object.assign(record, { transactionId, response, status: 'COMPLETED' });
                return Promise.resolve(record);
              }),
              releaseIdempotencyKey: vi.fn().mockImplementation((id: string) => {
                for (const [recordKey, record] of idempotencyRecords) {
                  if (record.id === id) idempotencyRecords.delete(recordKey);
                }
                return Promise.resolve({ count: 1 });
              }),
            };
          })(),
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
            assertWithinBudget: vi.fn().mockResolvedValue(undefined),
            consume: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StellarService,
          useValue: {
            submitPayment: vi.fn().mockResolvedValue({
              hash: 'stellar_hash_1',
              ledger: 100,
              successful: true,
            }),
          },
        },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        { provide: PrismaService, useValue: {} },
        {
          provide: SpendingLimitService,
          useValue: {
            aggregateSpend: vi.fn().mockResolvedValue({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 }),
            evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
    transactionRepository = module.get<TransactionRepository>(TransactionRepository);
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
        { provide: BudgetService, useValue: { assertWithinBudget: vi.fn(), consume: vi.fn() } },
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

  it('rejects reuse of a key with a different payload', async () => {
    await service.create('org_1', 'user_1', input, {
      principalId: 'principal_1',
      key: 'transaction-key-2',
    });

    await expect(
      service.create('org_1', 'user_1', { ...input, amount: '51.0' }, {
        principalId: 'principal_1',
        key: 'transaction-key-2',
      }),
    ).rejects.toMatchObject({ status: 409 });
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
        { provide: PrismaService, useValue: {} },
        {
          provide: SpendingLimitService,
          useValue: {
            aggregateSpend: vi.fn().mockResolvedValue({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 }),
            evaluateSpendingLimits: vi.fn().mockResolvedValue(undefined),
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
