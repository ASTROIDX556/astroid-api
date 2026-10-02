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

describe('TransactionService - create', () => {
  let service: TransactionService;
  let stellarService: StellarService;

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
              hasPaidRecipient: vi.fn().mockResolvedValue(false),
              recentCountForWallet: vi.fn().mockResolvedValue(0),
            };
          })(),
        },
        {
          provide: WalletService,
          useValue: {
            getOrThrow: vi.fn().mockResolvedValue(wallet),
          },
        },
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
          provide: RiskService,
          useValue: {
            evaluate: vi.fn().mockResolvedValue({
              score: 10,
              band: RiskBand.LOW,
              factors: [],
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
          useValue: {
            submitPayment: vi.fn().mockResolvedValue({ hash: 'stellar_hash_1', ledger: 100, successful: true }),
          },
        },
        {
          provide: EventBusService,
          useValue: {
            emit: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PrismaService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
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

  it('auto-executes and submits on-chain when risk and policy both clear the transaction', async () => {
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

  it('throws a DomainException and never reaches submission when a policy blocks the transaction', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TransactionRepository,
          useValue: { create: vi.fn(), update: vi.fn() },
        },
        { provide: WalletService, useValue: { getOrThrow: vi.fn().mockResolvedValue(wallet) } },
        { provide: AgentService, useValue: { getOrThrow: vi.fn().mockResolvedValue({ id: 'agent_1', status: AgentStatus.ACTIVE }) } },
        {
          provide: PolicyService,
          useValue: {
            checkVelocityLimit: vi.fn().mockResolvedValue(undefined),
            evaluateIntent: vi.fn().mockResolvedValue({
              passed: false,
              requiresApproval: false,
              violations: [{ policyId: 'policy_1', reason: 'exceeds max amount' }],
              evaluatedPolicyIds: ['policy_1'],
            }),
          },
        },
        { provide: RiskService, useValue: { evaluate: vi.fn() } },
        { provide: BudgetService, useValue: { assertWithinBudget: vi.fn(), consume: vi.fn() } },
        { provide: StellarService, useValue: { submitPayment: vi.fn() } },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    const blockedService = module.get<TransactionService>(TransactionService);
    const blockedStellar = module.get<StellarService>(StellarService);

    await expect(blockedService.create('org_1', 'user_1', input)).rejects.toThrow(DomainException);
    try {
      await blockedService.create('org_1', 'user_1', input);
    } catch (e: unknown) {
      const err = e as DomainException;
      expect(err.code).toBe(ErrorCode.POLICY_VIOLATION);
    }
    expect(blockedStellar.submitPayment).not.toHaveBeenCalled();
  });
});
