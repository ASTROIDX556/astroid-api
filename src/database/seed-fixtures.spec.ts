import { AgentRole, AgentStatus, BudgetPeriod, OrganizationStatus, Prisma, PrismaClient, PolicyType, StellarNetwork, UserRole, UserStatus, WalletStatus, WalletType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeSeedEnvironment,
  runFixtureVerification,
  runSeedCommand,
  seedFixtureRecords,
  verifyFixtureRecords,
} from './seed-fixtures';

vi.mock('argon2', () => ({
  argon2id: 2,
  hash: vi.fn().mockResolvedValue('fixture-password-hash'),
}));

const organization = {
  id: 'organization-id',
  name: 'Astroid Labs',
  status: OrganizationStatus.ACTIVE,
  deletedAt: null,
};

function createValidPrismaMock(): PrismaClient {
  const agents = [
    {
      id: 'treasury-id',
      name: 'Treasury Agent',
      role: AgentRole.FINANCE,
      status: AgentStatus.PAUSED,
      provider: 'local-fixture',
      model: 'disabled',
      primaryWalletId: 'treasury-wallet-id',
      deletedAt: null,
    },
    {
      id: 'procurement-id',
      name: 'Procurement Agent',
      role: AgentRole.PROCUREMENT,
      status: AgentStatus.PAUSED,
      provider: 'local-fixture',
      model: 'disabled',
      primaryWalletId: 'procurement-wallet-id',
      deletedAt: null,
    },
  ];
  const wallets = [
    {
      id: 'treasury-wallet-id',
      agentId: 'treasury-id',
      organizationId: organization.id,
      stellarAddress: 'GCHRJZC7Z3VBM6S2G3PN2S7KEVB5TN7RETY6PPFYCQIIYL3KROOACSQZ',
      network: StellarNetwork.TESTNET,
      walletType: WalletType.AGENT,
      status: WalletStatus.PAUSED,
    },
    {
      id: 'procurement-wallet-id',
      agentId: 'procurement-id',
      organizationId: organization.id,
      stellarAddress: 'GDE7B6EV7OMKXEKZ6UP5AKL6ENWWGSSOPSPSP6HQUQGUUVGSFDALFQVR',
      network: StellarNetwork.TESTNET,
      walletType: WalletType.AGENT,
      status: WalletStatus.PAUSED,
    },
  ];
  const policies = [
    { name: 'Per-transaction ceiling', type: PolicyType.MAX_AMOUNT, configuration: { maxAmount: '5000', asset: 'USDC' }, priority: 10, enabled: true, deletedAt: null },
    { name: 'Allowed assets', type: PolicyType.ALLOWED_ASSETS, configuration: { assets: ['USDC', 'XLM'] }, priority: 20, enabled: true, deletedAt: null },
    { name: 'Large payments need review', type: PolicyType.AGENT_RULE, configuration: { requiresApprovalAbove: '1000', asset: 'USDC' }, priority: 30, enabled: true, deletedAt: null },
  ];
  const budgets = [
    { id: 'root-budget-id', name: 'Q3 Operations', parentBudgetId: null, currency: 'USDC', limitAmount: new Prisma.Decimal('50000'), period: BudgetPeriod.QUARTERLY, enabled: true },
    { name: 'Treasury monthly', parentBudgetId: 'root-budget-id', agentId: 'treasury-id', currency: 'USDC', limitAmount: new Prisma.Decimal('10000'), period: BudgetPeriod.MONTHLY, enabled: true },
  ];
  const fixtureWebhook = {
    enabled: false,
    secret: 'development-fixture-only-not-a-secret',
    events: ['transaction.completed', 'proposal.created', 'budget.exceeded'],
  };

  const prisma = {
    organization: { findUnique: vi.fn().mockResolvedValue(organization) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => ({
        organizationId: organization.id,
        role: where.email === 'owner@astroid.dev' ? UserRole.OWNER : UserRole.FINANCE,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      })),
    },
    agent: {
      findMany: vi.fn(async ({ where }: { where: { name: string } }) =>
        agents.filter((agent) => agent.name === where.name),
      ),
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        agents.find((agent) => agent.name === where.name) ?? null,
      ),
    },
    wallet: {
      findFirst: vi.fn(async ({ where }: { where: { agentId: string } }) =>
        wallets.find((wallet) => wallet.agentId === where.agentId) ?? null,
      ),
    },
    policy: {
      findMany: vi.fn(async ({ where }: { where: { name: string } }) =>
        policies.filter((policy) => policy.name === where.name),
      ),
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        policies.find((policy) => policy.name === where.name) ?? null,
      ),
    },
    budget: {
      findMany: vi.fn(async ({ where }: { where: { name: string } }) =>
        [where.name === 'Q3 Operations' ? budgets[0] : budgets[1]].filter(Boolean),
      ),
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        (where.name === 'Q3 Operations' ? budgets[0] : budgets[1]) ?? null,
      ),
    },
    webhook: { findMany: vi.fn().mockResolvedValue([fixtureWebhook]) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return prisma as unknown as PrismaClient;
}

const localEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/astroid_test',
};

describe('database fixtures', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates fixture fields and relationships', async () => {
    await expect(verifyFixtureRecords(createValidPrismaMock())).resolves.toBeUndefined();
  });

  it('fails validation when a required fixture is missing', async () => {
    const prisma = createValidPrismaMock();
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    await expect(verifyFixtureRecords(prisma)).rejects.toThrow('organization astroid-labs');
  });

  it('fails validation when the primary wallet relationship is invalid', async () => {
    const prisma = createValidPrismaMock();
    vi.mocked(prisma.wallet.findFirst).mockResolvedValue({
      id: 'wrong-wallet',
      organizationId: organization.id,
      agentId: 'treasury-id',
      stellarAddress: 'GCHRJZC7Z3VBM6S2G3PN2S7KEVB5TN7RETY6PPFYCQIIYL3KROOACSQZ',
      network: StellarNetwork.TESTNET,
      walletType: WalletType.AGENT,
      status: WalletStatus.PAUSED,
    } as never);
    await expect(verifyFixtureRecords(prisma)).rejects.toThrow('wallet for Treasury Agent');
  });

  it('fails validation when a spending rule configuration is invalid', async () => {
    const prisma = createValidPrismaMock();
    vi.mocked(prisma.policy.findMany).mockResolvedValue([{
      type: PolicyType.MAX_AMOUNT,
      configuration: { maxAmount: '0', asset: 'USDC' },
      priority: 10,
      enabled: true,
      deletedAt: null,
    } as never]);

    await expect(verifyFixtureRecords(prisma)).rejects.toThrow('policy Per-transaction ceiling');
  });

  it('fails validation when a baseline policy is duplicated', async () => {
    const prisma = createValidPrismaMock();
    const duplicate = {
      type: PolicyType.MAX_AMOUNT,
      configuration: { maxAmount: '5000', asset: 'USDC' },
      priority: 10,
      enabled: true,
      deletedAt: null,
    };
    vi.mocked(prisma.policy.findMany).mockResolvedValue([duplicate, duplicate] as never);

    await expect(verifyFixtureRecords(prisma)).rejects.toThrow('policy Per-transaction ceiling');
  });

  it('runs seed writes in a transaction using stable fixture IDs', async () => {
    const tx = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(organization),
        create: vi.fn().mockResolvedValue(organization),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      agent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: { id: string } }) => ({ ...data, primaryWalletId: null })),
        update: vi.fn().mockResolvedValue({}),
      },
      wallet: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: { id: string } }) => data),
      },
      policy: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      budget: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: { id: string } }) => data),
      },
      webhook: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: Prisma.TransactionClient) => Promise<void>) =>
        callback(tx as unknown as Prisma.TransactionClient),
      ),
    } as unknown as PrismaClient;

    await seedFixtureRecords(prisma);
    await seedFixtureRecords(prisma);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.organization.findUnique).toHaveBeenCalledTimes(2);
    expect(tx.organization.create).not.toHaveBeenCalled();
    expect(tx.agent.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ id: '00000000-0000-4000-8000-000000000093' }) }),
    );
    expect(tx.wallet.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ id: '00000000-0000-4000-8000-000000000100' }) }),
    );
  });

  it('blocks production fixture commands and always disconnects', async () => {
    const prisma = {
      $transaction: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrismaClient;

    await expect(
      runSeedCommand(prisma, { ...localEnvironment, NODE_ENV: 'production' }),
    ).rejects.toThrow('only be seeded in development or test');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it('requires explicit opt-in before using a remote database host', () => {
    const remoteEnvironment = {
      ...localEnvironment,
      DATABASE_URL: 'postgresql://postgres:password@db.example.test:5432/astroid_test',
    };

    expect(() => assertSafeSeedEnvironment(remoteEnvironment)).toThrow(
      'Remote database fixtures require ALLOW_REMOTE_DB_SEED=true',
    );
    expect(() =>
      assertSafeSeedEnvironment({ ...remoteEnvironment, ALLOW_REMOTE_DB_SEED: 'true' }),
    ).not.toThrow();
  });

  it('propagates database errors and disconnects', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(new Error('database unavailable')),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrismaClient;

    await expect(runSeedCommand(prisma, localEnvironment)).rejects.toThrow('database unavailable');
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects after fixture verification', async () => {
    const prisma = createValidPrismaMock();
    await runFixtureVerification(prisma, localEnvironment);
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });
});