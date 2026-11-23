import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKey,
  ApprovalDecision,
  Budget,
  BudgetPeriod,
  Policy,
  PolicyType,
  Prisma,
  Proposal,
  ProposalStatus,
} from '@prisma/client';
import { PolicyService } from '../modules/policies/policy.service';
import { PolicyRepository } from '../modules/policies/policy.repository';
import { PolicyEngine } from '../modules/policies/policy.engine';
import { BudgetService } from '../modules/budgets/budget.service';
import { BudgetRepository } from '../modules/budgets/budget.repository';
import { ApprovalService } from '../modules/approvals/approval.service';
import { ApprovalRepository } from '../modules/approvals/approval.repository';
import { TransactionService } from '../modules/transactions/transaction.service';
import { ApiKeyService } from '../modules/developer/api-key.service';
import { ApiKeyRepository } from '../modules/developer/api-key.repository';
import { EventBusService } from './event-bus.service';
import { DomainEventName } from './event-names';
import { TraceContext } from '../common/context/trace.context';
import { DomainException } from '../common/exceptions/domain.exception';
import { ErrorCode } from '../common/constants/error-codes';
import { API_KEY_SCOPES } from '../common/constants/api-key-scopes';
import { PrismaService } from '../database/prisma.service';

const ORG = 'org_1';
const ACTOR = 'user_1';

const policy = (overrides: Partial<Policy> = {}): Policy =>
  ({
    id: 'pol_1',
    organizationId: ORG,
    agentId: null,
    name: 'Max spend',
    description: null,
    type: PolicyType.MAX_AMOUNT,
    configuration: { maxAmount: 1000 },
    priority: 100,
    enabled: true,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    deletedAt: null,
    overrideLimit: null,
    overrideUntil: null,
    originalLimit: null,
    ...overrides,
  }) as Policy;

const budget = (overrides: Partial<Budget> = {}): Budget =>
  ({
    id: 'bud_1',
    organizationId: ORG,
    parentBudgetId: null,
    agentId: null,
    name: 'Q4 operations',
    currency: 'USDC',
    limitAmount: new Prisma.Decimal('10000'),
    spent: new Prisma.Decimal('0'),
    period: BudgetPeriod.MONTHLY,
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    rollover: false,
    enabled: true,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  }) as Budget;

const proposal = (): Proposal => ({
  id: 'prop_1',
  organizationId: ORG,
  transactionId: 'tx_1',
  title: 'Approval required',
  description: null,
  approvalType: 'DUAL',
  requiredApprovals: 2,
  status: ProposalStatus.PENDING,
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
});

const apiKey = (overrides: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 'key_1',
    organizationId: ORG,
    createdById: ACTOR,
    name: 'CI pipeline',
    prefix: 'ak_live_abcdef',
    hashedKey: 'hash_1',
    permissions: [],
    scopes: [API_KEY_SCOPES.WalletRead],
    allowedIps: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  }) as ApiKey;

let emit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emit = vi.fn().mockResolvedValue(undefined);
});

const eventBus = () => ({ emit } as unknown as EventBusService);

/** Asserts the service emitted `name` with exactly `payload` for the org/actor. */
const expectEmitted = (
  name: string,
  payload: Record<string, unknown>,
  aggregateType: string,
  aggregateId: string,
) => {
  expect(emit).toHaveBeenCalledWith(name, payload, {
    organizationId: ORG,
    actorId: ACTOR,
    aggregateType,
    aggregateId,
  });
};

describe('governance audit event contract (#547)', () => {
  describe('spending policies', () => {
    it('policy.created emits the exact payload', async () => {
      const created = policy();
      const repository = {
        create: vi.fn().mockResolvedValue(created),
      } as unknown as PolicyRepository;
      const service = new PolicyService(
        repository,
        {} as PolicyEngine,
        eventBus(),
        {} as PrismaService,
      );

      await service.create(ORG, ACTOR, {
        name: 'Max spend',
        type: PolicyType.MAX_AMOUNT,
        configuration: { maxAmount: 1000 },
        priority: 100,
        enabled: true,
      });

      expectEmitted(
        DomainEventName.PolicyCreated,
        {
          action: 'policy.created',
          resourceType: 'policy',
          resourceId: 'pol_1',
          summary: "Created spending policy 'Max spend'",
          before: null,
          after: {
            name: 'Max spend',
            type: PolicyType.MAX_AMOUNT,
            priority: 100,
            enabled: true,
            agentId: null,
          },
          requestId: null,
        },
        'policy',
        'pol_1',
      );
    });

    it('policy.updated carries before and after snapshots', async () => {
      const existing = policy({ name: 'Old name', priority: 10 });
      const updated = policy({ name: 'Max spend', priority: 50 });
      const repository = {
        findById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      } as unknown as PolicyRepository;
      const service = new PolicyService(
        repository,
        {} as PolicyEngine,
        eventBus(),
        {} as PrismaService,
      );

      await service.update(ORG, ACTOR, 'pol_1', { name: 'Max spend', priority: 50 });

      expectEmitted(
        DomainEventName.PolicyUpdated,
        {
          action: 'policy.updated',
          resourceType: 'policy',
          resourceId: 'pol_1',
          summary: "Updated spending policy 'Max spend'",
          before: {
            name: 'Old name',
            type: PolicyType.MAX_AMOUNT,
            priority: 10,
            enabled: true,
            agentId: null,
          },
          after: {
            name: 'Max spend',
            type: PolicyType.MAX_AMOUNT,
            priority: 50,
            enabled: true,
            agentId: null,
          },
          requestId: null,
        },
        'policy',
        'pol_1',
      );
    });

    it('policy.deleted emits the before snapshot', async () => {
      const existing = policy();
      const repository = {
        findById: vi.fn().mockResolvedValue(existing),
        softDelete: vi.fn().mockResolvedValue(existing),
      } as unknown as PolicyRepository;
      const service = new PolicyService(
        repository,
        {} as PolicyEngine,
        eventBus(),
        {} as PrismaService,
      );

      await service.remove(ORG, ACTOR, 'pol_1');

      expectEmitted(
        DomainEventName.PolicyDeleted,
        expect.objectContaining({
          action: 'policy.deleted',
          resourceType: 'policy',
          resourceId: 'pol_1',
          before: expect.objectContaining({ name: 'Max spend' }),
          after: null,
        }) as unknown as Record<string, unknown>,
        'policy',
        'pol_1',
      );
    });

    it('does not emit when validation fails before persistence', async () => {
      const repository = { create: vi.fn() } as unknown as PolicyRepository;
      const service = new PolicyService(
        repository,
        {} as PolicyEngine,
        eventBus(),
        {} as PrismaService,
      );

      await expect(
        service.create(ORG, ACTOR, {
          name: 'Bad',
          type: PolicyType.MAX_AMOUNT,
          configuration: { maxAmount: 10, minAmount: 100 },
          priority: 100,
          enabled: true,
        }),
      ).rejects.toBeInstanceOf(DomainException);

      expect(repository.create).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('budgets', () => {
    it('budget.created emits the exact payload', async () => {
      const created = budget();
      const repository = { create: vi.fn().mockResolvedValue(created) } as unknown as BudgetRepository;
      const service = new BudgetService(repository, eventBus());

      await service.create(ORG, ACTOR, {
        name: 'Q4 operations',
        currency: 'USDC',
        limitAmount: '10000',
        period: BudgetPeriod.MONTHLY,
        rollover: false,
        enabled: true,
      });

      expectEmitted(
        DomainEventName.BudgetCreated,
        {
          action: 'budget.created',
          resourceType: 'budget',
          resourceId: 'bud_1',
          summary: "Created budget 'Q4 operations'",
          before: null,
          after: {
            name: 'Q4 operations',
            currency: 'USDC',
            limitAmount: '10000.0000000',
            spent: '0.0000000',
            period: BudgetPeriod.MONTHLY,
            enabled: true,
            parentBudgetId: null,
            agentId: null,
          },
          requestId: null,
        },
        'budget',
        'bud_1',
      );
    });

    it('budget.updated emits before and after snapshots', async () => {
      const existing = budget({ limitAmount: new Prisma.Decimal('10000') });
      const updated = budget({ limitAmount: new Prisma.Decimal('25000') });
      const repository = {
        findById: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      } as unknown as BudgetRepository;
      const service = new BudgetService(repository, eventBus());

      await service.update(ORG, ACTOR, 'bud_1', { limitAmount: '25000' });

      expectEmitted(
        DomainEventName.BudgetUpdated,
        expect.objectContaining({
          action: 'budget.updated',
          resourceType: 'budget',
          resourceId: 'bud_1',
          before: expect.objectContaining({ limitAmount: '10000.0000000' }),
          after: expect.objectContaining({ limitAmount: '25000.0000000' }),
          requestId: null,
        }) as unknown as Record<string, unknown>,
        'budget',
        'bud_1',
      );
    });

    it('budget.deleted emits the before snapshot', async () => {
      const existing = budget();
      const repository = {
        findById: vi.fn().mockResolvedValue(existing),
        findChildren: vi.fn().mockResolvedValue([]),
        softDelete: vi.fn().mockResolvedValue(existing),
      } as unknown as BudgetRepository;
      const service = new BudgetService(repository, eventBus());

      await service.remove(ORG, ACTOR, 'bud_1');

      expectEmitted(
        DomainEventName.BudgetDeleted,
        expect.objectContaining({
          action: 'budget.deleted',
          resourceType: 'budget',
          resourceId: 'bud_1',
          after: null,
        }) as unknown as Record<string, unknown>,
        'budget',
        'bud_1',
      );
    });

    it('does not emit when the budget does not exist', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      } as unknown as BudgetRepository;
      const service = new BudgetService(repository, eventBus());

      await expect(service.update(ORG, ACTOR, 'missing', {})).rejects.toBeInstanceOf(
        DomainException,
      );
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('approval decisions', () => {
    it('approval.decided emits the exact payload for a vote below the threshold', async () => {
      const pending = proposal();
      const repository = {
        findById: vi.fn().mockResolvedValue(pending),
        findApprovalByUser: vi.fn().mockResolvedValue(null),
        createApproval: vi.fn().mockResolvedValue({ id: 'appr_1' }),
        countApprovals: vi.fn().mockResolvedValue(1),
      } as unknown as ApprovalRepository;
      const service = new ApprovalService(
        repository,
        {} as TransactionService,
        eventBus(),
      );

      await service.decide(ORG, ACTOR, 'prop_1', {
        decision: ApprovalDecision.APPROVED,
        comment: 'Looks fine',
      });

      expectEmitted(
        DomainEventName.ApprovalDecided,
        {
          action: 'approval.decided',
          resourceType: 'proposal',
          resourceId: 'prop_1',
          summary: 'Recorded APPROVED decision on proposal prop_1',
          before: null,
          after: {
            decision: ApprovalDecision.APPROVED,
            comment: 'Looks fine',
            approvedCount: 1,
            requiredApprovals: 2,
            transactionId: 'tx_1',
          },
          requestId: null,
        },
        'proposal',
        'prop_1',
      );
      expect(repository.createApproval).toHaveBeenCalledOnce();
    });

    it('does not emit when the reviewer already voted', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(proposal()),
        findApprovalByUser: vi.fn().mockResolvedValue({ id: 'appr_1' }),
        createApproval: vi.fn(),
      } as unknown as ApprovalRepository;
      const service = new ApprovalService(repository, {} as TransactionService, eventBus());

      await expect(
        service.decide(ORG, ACTOR, 'prop_1', { decision: ApprovalDecision.APPROVED }),
      ).rejects.toBeInstanceOf(DomainException);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('API keys', () => {
    it('api_key.created emits the exact payload and never leaks the hash', async () => {
      const created = apiKey({ scopes: [API_KEY_SCOPES.WalletRead, API_KEY_SCOPES.ApiKeyManage] });
      const repository = {
        create: vi.fn().mockResolvedValue(created),
      } as unknown as ApiKeyRepository;
      const service = new ApiKeyService(repository, eventBus());

      const result = await service.create(ORG, ACTOR, {
        name: created.name,
        scopes: [API_KEY_SCOPES.ApiKeyManage, API_KEY_SCOPES.WalletRead],
        permissions: [],
        allowedIps: [],
      });

      expect(result.key).toMatch(/^ak_live_/);
      expectEmitted(
        DomainEventName.ApiKeyCreated,
        {
          action: 'api_key.created',
          resourceType: 'api_key',
          resourceId: 'key_1',
          summary: "Created API key 'CI pipeline'",
          before: null,
          after: {
            name: 'CI pipeline',
            prefix: 'ak_live_abcdef',
            scopes: `${API_KEY_SCOPES.WalletRead},${API_KEY_SCOPES.ApiKeyManage}`,
            allowedIps: '',
            expiresAt: null,
            revokedAt: null,
          },
          requestId: null,
        },
        'api_key',
        'key_1',
      );
      expect(JSON.stringify(emit.mock.calls)).not.toContain('hash_1');
    });

    it('rejects an unknown scope with a 400 listing the allowed set', async () => {
      const repository = { create: vi.fn() } as unknown as ApiKeyRepository;
      const service = new ApiKeyService(repository, eventBus());

      try {
        await service.create(ORG, ACTOR, {
          name: 'Bad scopes',
          scopes: ['wallet:teleport'],
          permissions: [],
          allowedIps: [],
        });
        throw new Error('expected create to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainException);
        const domain = error as DomainException;
        expect(domain.code).toBe(ErrorCode.BAD_REQUEST);
        expect(domain.getStatus()).toBe(400);
        expect(domain.details).toMatchObject({
          unknown: ['wallet:teleport'],
          allowed: expect.arrayContaining([API_KEY_SCOPES.WalletRead]),
        });
      }

      expect(repository.create).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('api_key.revoked emits the exact payload', async () => {
      const existing = apiKey();
      const revoked = apiKey({ revokedAt: new Date('2026-11-23T00:00:00.000Z') });
      const repository = {
        findById: vi.fn().mockResolvedValue(existing),
        revoke: vi.fn().mockResolvedValue(revoked),
      } as unknown as ApiKeyRepository;
      const service = new ApiKeyService(repository, eventBus());

      await service.revoke(ORG, ACTOR, 'key_1');

      expectEmitted(
        DomainEventName.ApiKeyRevoked,
        {
          action: 'api_key.revoked',
          resourceType: 'api_key',
          resourceId: 'key_1',
          summary: "Revoked API key 'CI pipeline'",
          before: null,
          after: {
            name: 'CI pipeline',
            prefix: 'ak_live_abcdef',
            scopes: API_KEY_SCOPES.WalletRead,
            allowedIps: '',
            expiresAt: null,
            revokedAt: '2026-11-23T00:00:00.000Z',
          },
          requestId: null,
        },
        'api_key',
        'key_1',
      );
    });

    it('stamps the active request id onto the audit payload', async () => {
      const created = apiKey();
      const repository = {
        create: vi.fn().mockResolvedValue(created),
      } as unknown as ApiKeyRepository;
      const service = new ApiKeyService(repository, eventBus());

      await TraceContext.run({ traceId: 'req_42' }, () =>
        service.create(ORG, ACTOR, {
          name: 'CI pipeline',
          scopes: [],
          permissions: [],
          allowedIps: [],
        }),
      );

      const payload = emit.mock.calls[0][1] as { requestId: string | null };
      expect(payload.requestId).toBe('req_42');
    });
  });
});
