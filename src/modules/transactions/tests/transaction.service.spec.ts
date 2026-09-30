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

describe('TransactionService - Simulation Integration', () => {
  let service: TransactionService;
  let stellarService: StellarService;
  let walletService: WalletService;
  let agentService: AgentService;
  let policyService: PolicyService;
  let riskService: RiskService;
  let budgetService: BudgetService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: TransactionRepository,
          useValue: {
            create: vi.fn().mockImplementation((data) => Promise.resolve({ id: 'tx_1', ...data.data, status: data.data.status || TransactionStatus.PENDING })),
          },
        },
        {
          provide: WalletService,
          useValue: {
            findById: vi.fn().mockResolvedValue({
              id: 'wallet_1',
              status: WalletStatus.ACTIVE,
              encryptedSecret: 'SCK...',
              network: 'TESTNET',
            }),
          },
        },
        {
          provide: AgentService,
          useValue: {
            findById: vi.fn().mockResolvedValue({
              id: 'agent_1',
              status: AgentStatus.ACTIVE,
            }),
          },
        },
        {
          provide: PolicyService,
          useValue: {
            evaluate: vi.fn().mockResolvedValue({ allowed: true }),
          },
        },
        {
          provide: RiskService,
          useValue: {
            evaluate: vi.fn().mockResolvedValue({ score: 10, band: RiskBand.LOW }),
          },
        },
        {
          provide: BudgetService,
          useValue: {
            checkHeadroom: vi.fn().mockResolvedValue({ hasHeadroom: true }),
          },
        },
        {
          provide: StellarService,
          useValue: {
            buildPaymentXdr: vi.fn().mockResolvedValue('AAAA...xdr'),
            simulateTransaction: vi.fn().mockResolvedValue({ id: 'sim_1', results: [], minResourceFee: '100' }),
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
    walletService = module.get<WalletService>(WalletService);
    agentService = module.get<AgentService>(AgentService);
    policyService = module.get<PolicyService>(PolicyService);
    riskService = module.get<RiskService>(RiskService);
    budgetService = module.get<BudgetService>(BudgetService);
  });

  it('should run simulation prior to broadcast and create transaction successfully', async () => {
    const input = {
      walletId: 'wallet_1',
      agentId: 'agent_1',
      recipientAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASUIYIC7FEM',
      amount: '50.0',
      assetCode: 'XLM',
      memo: 'Test payment',
    };

    const tx = await service.create('org_1', 'user_1', input);

    expect(stellarService.buildPaymentXdr).toHaveBeenCalled();
    expect(stellarService.simulateTransaction).toHaveBeenCalledWith('AAAA...xdr');
    expect(tx).toBeDefined();
    expect(tx.status).toBe(TransactionStatus.PENDING);
  });

  it('should abort transaction and throw DomainException if simulation fails', async () => {
    vi.spyOn(stellarService, 'simulateTransaction').mockRejectedValueOnce(
      new DomainException(ErrorCode.STELLAR_ERROR, 'Simulation failed: HostError')
    );

    const input = {
      walletId: 'wallet_1',
      agentId: 'agent_1',
      recipientAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASUIYIC7FEM',
      amount: '50.0',
      assetCode: 'XLM',
    };

    await expect(service.create('org_1', 'user_1', input)).rejects.toThrow(DomainException);
    try {
      await service.create('org_1', 'user_1', input);
    } catch (e: unknown) {
      const err = e as DomainException;
      expect(err.code).toBe(ErrorCode.STELLAR_ERROR);
      expect(err.message).toContain('Simulation failed');
    }
  });
});
