import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { WalletStatus, AgentStatus, TransactionStatus, RiskBand } from '@prisma/client';

const VALID_RECIPIENT = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

const DECIMAL_50 = { toFixed: () => '50.0000000' };

describe('TransactionService - create pipeline', () => {
  let service: TransactionService;
  let policies: PolicyService;
  let eventBus: EventBusService;
  let prisma: PrismaService;

  let repositoryMock: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    hasPaidRecipient: ReturnType<typeof vi.fn>;
    recentCountForWallet: ReturnType<typeof vi.fn>;
  };
  let stellarMock: { submitPayment: ReturnType<typeof vi.fn> };

  /** Stateful in-memory transaction row so `execute()` can re-read it. */
  let row: Record<string, unknown>;

  const baseInput = {
    walletId: 'wallet_1',
    agentId: 'agent_1',
    recipientAddress: VALID_RECIPIENT,
    amount: '50.0',
    asset: 'XLM',
    metadata: {},
  };

  beforeEach(async () => {
    row = {
      id: 'tx_1',
      walletId: 'wallet_1',
      recipientAddress: VALID_RECIPIENT,
      asset: 'XLM',
      amount: DECIMAL_50,
      memo: null as string | null,
      budgetId: null as string | null,
      status: TransactionStatus.DRAFT,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    repositoryMock = {
      create: vi.fn().mockImplementation((data) => {
        row = { ...row, ...data, id: 'tx_1', createdAt: new Date(), updatedAt: new Date() };
        return Promise.resolve(row);
      }),
      update: vi.fn().mockImplementation((_id: string, data) => {
        row = { ...row, ...data, updatedAt: new Date() };
        return Promise.resolve(row);
      }),
      findById: vi.fn().mockImplementation(() => Promise.resolve(row)),
      hasPaidRecipient: vi.fn().mockResolvedValue(false),
      recentCountForWallet: vi.fn().mockResolvedValue(0),
    };
    stellarMock = {
      submitPayment: vi.fn().mockResolvedValue({
        hash: 'stellar-hash-1',
        successful: true,
        ledger: 1234,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TransactionRepository,
          useValue: repositoryMock,
        },
        {
          provide: WalletService,
          useValue: {
            getOrThrow: vi.fn().mockResolvedValue({
              id: 'wallet_1',
              status: WalletStatus.ACTIVE,
              stellarAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASUIYIC7FEM',
              network: 'TESTNET',
              createdAt: new Date('2024-01-01'),
            }),
          },
        },
        {
          provide: AgentService,
          useValue: {
            getOrThrow: vi.fn().mockResolvedValue({
              id: 'agent_1',
              status: AgentStatus.ACTIVE,
            }),
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
              matchedPolicyId: null,
              evaluatedPolicyIds: [],
            }),
          },
        },
        {
          provide: RiskService,
          useValue: {
            assess: vi.fn().mockReturnValue({
              score: 10,
              band: RiskBand.LOW,
              factors: [],
              canAutoExecute: true,
            }),
            evaluate: vi.fn().mockResolvedValue({
              score: 10,
              band: RiskBand.LOW,
              canAutoExecute: true,
            }),
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
          useValue: stellarMock,
        },
        {
          provide: EventBusService,
          useValue: {
            emit: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            proposal: {
              create: vi.fn().mockResolvedValue({
                id: 'proposal_1',
                status: 'PENDING',
                requiredApprovals: 1,
              }),
            },
          },
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
    policies = module.get<PolicyService>(PolicyService);
    eventBus = module.get<EventBusService>(EventBusService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('creates an auto-executed transaction when every governance check passes', async () => {
    const result = await service.create('org_1', 'user_1', { ...baseInput, memo: 'Test payment' });

    expect(result.requiresApproval).toBe(false);
    expect(result.transaction.status).toBe(TransactionStatus.COMPLETED);
    expect(stellarMock.submitPayment).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'transaction.completed',
      expect.objectContaining({ transactionId: 'tx_1' }),
      expect.anything(),
    );
  });

  it('simulates governance checks without persisting or submitting', async () => {
    const result = await service.simulate('org_1', baseInput);

    expect(result).toMatchObject({
      wouldPass: true,
      requiresApproval: false,
      policy: { passed: true, violations: [] },
      risk: { score: 10, band: RiskBand.LOW },
    });
    expect(repositoryMock.create).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(stellarMock.submitPayment).not.toHaveBeenCalled();
  });

  it('creates a pending proposal when approval is required', async () => {
    vi.mocked(policies.evaluateIntent).mockResolvedValueOnce({
      passed: true,
      requiresApproval: true,
      violations: [],
      matchedPolicyId: 'policy_1',
      evaluatedPolicyIds: ['policy_1'],
    });

    const result = await service.create('org_1', 'user_1', { ...baseInput });

    expect(result.requiresApproval).toBe(true);
    expect(result.transaction.status).toBe(TransactionStatus.PENDING);
    expect(prisma.proposal.create).toHaveBeenCalled();
    expect(stellarMock.submitPayment).not.toHaveBeenCalled();
  });

  it('throws a DomainException when a policy blocks the transaction', async () => {
    vi.mocked(policies.evaluateIntent).mockResolvedValueOnce({
      passed: false,
      requiresApproval: false,
      violations: [
        { policyId: 'policy_1', policyName: 'Daily Limit', code: 'LIMIT', message: 'Daily limit exceeded' },
      ],
      matchedPolicyId: 'policy_1',
      evaluatedPolicyIds: ['policy_1'],
    });

    await expect(service.create('org_1', 'user_1', { ...baseInput })).rejects.toMatchObject({
      code: ErrorCode.POLICY_VIOLATION,
    });
    expect(stellarMock.submitPayment).not.toHaveBeenCalled();
  });

  it('marks the transaction as failed and rethrows when the payment submission throws', async () => {
    stellarMock.submitPayment.mockRejectedValueOnce(
      new DomainException(ErrorCode.STELLAR_ERROR, 'Simulation failed: HostError'),
    );

    await expect(service.create('org_1', 'user_1', { ...baseInput })).rejects.toThrow(
      DomainException,
    );
    expect(repositoryMock.update).toHaveBeenCalledWith('tx_1', {
      status: TransactionStatus.FAILED,
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'transaction.failed',
      expect.objectContaining({ reason: 'Simulation failed: HostError' }),
      expect.anything(),
    );
  });
});
