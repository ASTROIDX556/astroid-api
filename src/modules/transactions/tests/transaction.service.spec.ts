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
import { WalletStatus, RiskBand } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { CreateTransactionInput } from '../transaction.dto';

describe('TransactionService', () => {
  describe('Governance simulation', () => {
    let service: TransactionService;
    let repository: {
      hasPaidRecipient: ReturnType<typeof vi.fn>;
      recentCountForWallet: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    let policyService: { evaluateIntent: ReturnType<typeof vi.fn> };
    let riskService: { assess: ReturnType<typeof vi.fn> };
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
        hasPaidRecipient: vi.fn().mockResolvedValue(false),
        recentCountForWallet: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
      };
      policyService = {
        evaluateIntent: vi.fn().mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
        }),
      };
      riskService = {
        assess: vi.fn().mockReturnValue({
          score: 10,
          band: RiskBand.LOW,
          factors: [],
          canAutoExecute: true,
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
        riskService as unknown as RiskService,
        {} as BudgetService,
        stellarService as unknown as StellarService,
        eventBus as unknown as EventBusService,
        {} as PrismaService,
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
      expect(repository.hasPaidRecipient).toHaveBeenCalledWith('org_1', input.recipientAddress);
      expect(repository.recentCountForWallet).toHaveBeenCalledWith('wallet_1');
      expect(repository.create).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(stellarService.submitPayment).not.toHaveBeenCalled();
    });

    it('flags high-risk assessments for approval during a dry run', async () => {
      riskService.assess.mockReturnValueOnce({
        score: 45,
        band: RiskBand.MEDIUM,
        factors: [],
        canAutoExecute: false,
      });

      const result = await service.simulate('org_1', input);

      expect(result.wouldPass).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(repository.create).not.toHaveBeenCalled();
      expect(stellarService.submitPayment).not.toHaveBeenCalled();
    });
  });
});
