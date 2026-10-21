import {
  AgentRole,
  AgentStatus,
  BudgetPeriod,
  OrganizationStatus,
  Prisma,
  PrismaClient,
  PolicyType,
  StellarNetwork,
  UserRole,
  UserStatus,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import { StrKey } from '@stellar/stellar-sdk';
import * as argon2 from 'argon2';

const DEMO_PASSWORD = 'Astroid!Demo123';

export const SEED_FIXTURES = {
  organization: {
    id: '00000000-0000-4000-8000-000000000090',
    name: 'Astroid Labs',
    slug: 'astroid-labs',
    description: 'Financial operating system for autonomous AI agents.',
    plan: 'GROWTH',
  },
  users: [
    { id: '00000000-0000-4000-8000-000000000091', name: 'Ava Owner', email: 'owner@astroid.dev', role: UserRole.OWNER },
    {
      id: '00000000-0000-4000-8000-000000000092',
      name: 'Finn Finance',
      email: 'finance@astroid.dev',
      role: UserRole.FINANCE,
    },
  ],
  agents: [
    {
      id: '00000000-0000-4000-8000-000000000093',
      walletId: '00000000-0000-4000-8000-000000000100',
      name: 'Treasury Agent',
      role: AgentRole.FINANCE,
      description: 'Manages recurring vendor settlements within budget guardrails.',
      address: 'GCHRJZC7Z3VBM6S2G3PN2S7KEVB5TN7RETY6PPFYCQIIYL3KROOACSQZ',
    },
    {
      id: '00000000-0000-4000-8000-000000000094',
      walletId: '00000000-0000-4000-8000-000000000101',
      name: 'Procurement Agent',
      role: AgentRole.PROCUREMENT,
      description: 'Sources and pays for compute and data subscriptions.',
      address: 'GDE7B6EV7OMKXEKZ6UP5AKL6ENWWGSSOPSPSP6HQUQGUUVGSFDALFQVR',
    },
  ],
  policies: [
    {
      id: '00000000-0000-4000-8000-000000000097',
      name: 'Per-transaction ceiling',
      type: PolicyType.MAX_AMOUNT,
      configuration: { maxAmount: '5000', asset: 'USDC' },
      priority: 10,
    },
    {
      id: '00000000-0000-4000-8000-000000000098',
      name: 'Allowed assets',
      type: PolicyType.ALLOWED_ASSETS,
      configuration: { assets: ['USDC', 'XLM'] },
      priority: 20,
    },
    {
      id: '00000000-0000-4000-8000-000000000099',
      name: 'Large payments need review',
      type: PolicyType.AGENT_RULE,
      configuration: { requiresApprovalAbove: '1000', asset: 'USDC' },
      priority: 30,
    },
  ],
  rootBudgetId: '00000000-0000-4000-8000-000000000102',
  childBudgetId: '00000000-0000-4000-8000-000000000103',
  webhookId: '00000000-0000-4000-8000-000000000104',
} as const;

const FIXTURE_DATE = new Date('2026-01-01T00:00:00.000Z');
const TEST_WEBHOOK_URL = 'https://example.com/astroid/webhook';
const TEST_WEBHOOK_SECRET = 'development-fixture-only-not-a-secret';

export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(`Fixture validation failed: ${message}`);
    this.name = 'FixtureValidationError';
  }
}

export class SeedEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedEnvironmentError';
  }
}

export function assertSafeSeedEnvironment(env: NodeJS.ProcessEnv): void {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new SeedEnvironmentError(
      'Database fixtures may only be seeded in development or test environments.',
    );
  }
  if (!env.DATABASE_URL) {
    throw new SeedEnvironmentError('DATABASE_URL is required to seed or verify database fixtures.');
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new SeedEnvironmentError('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
    throw new SeedEnvironmentError('DATABASE_URL must use PostgreSQL.');
  }

  const hostname = databaseUrl.hostname.toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'postgres']);
  if (!localHosts.has(hostname) && env.ALLOW_REMOTE_DB_SEED !== 'true') {
    throw new SeedEnvironmentError('Remote database fixtures require ALLOW_REMOTE_DB_SEED=true.');
  }
}

async function upsertUser(
  tx: Prisma.TransactionClient,
  organizationId: string,
  user: (typeof SEED_FIXTURES.users)[number],
  passwordHash: string,
): Promise<void> {
  const existing = await tx.user.findUnique({ where: { email: user.email } });
  if (existing && existing.organizationId !== organizationId) {
    throw new Error('A fixture user email is already assigned to another organization.');
  }
  if (existing) {
    if (existing.name !== user.name || existing.role !== user.role) {
      throw new Error('A fixture user email conflicts with an existing user record.');
    }
    return;
  }

  await tx.user.upsert({
    where: { email: user.email },
    update: {},
    create: {
      id: user.id,
      organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
      status: UserStatus.ACTIVE,
      passwordHash,
    },
  });
}

async function upsertAgent(
  tx: Prisma.TransactionClient,
  organizationId: string,
  fixture: (typeof SEED_FIXTURES.agents)[number],
): Promise<{ id: string; primaryWalletId: string | null }> {
  const data = {
    organizationId,
    name: fixture.name,
    description: fixture.description,
    provider: 'local-fixture',
    model: 'disabled',
    role: fixture.role,
    status: AgentStatus.PAUSED,
    capabilities: ['payments', 'analysis'],
    deletedAt: null,
  };
  const existing = await tx.agent.findFirst({
    where: { organizationId, name: fixture.name, deletedAt: null },
  });
  if (existing) {
    const isFixture =
      existing.id === fixture.id ||
      (existing.description === fixture.description &&
        existing.role === fixture.role &&
        ((existing.provider === 'anthropic' && existing.model === 'claude-opus-4') ||
          (existing.provider === 'local-fixture' && existing.model === 'disabled')));
    if (!isFixture) {
      throw new Error(`Agent name conflicts with the ${fixture.name} fixture.`);
    }
    return tx.agent.update({ where: { id: existing.id }, data });
  }
  return tx.agent.create({ data: { id: fixture.id, ...data } });
}

async function upsertWallet(
  tx: Prisma.TransactionClient,
  organizationId: string,
  agent: { id: string; primaryWalletId: string | null },
  fixture: (typeof SEED_FIXTURES.agents)[number],
): Promise<void> {
  const existing = await tx.wallet.findFirst({
    where: { agentId: agent.id, label: `${fixture.name} operating wallet` },
  });
  const wallet = existing
    ? await tx.wallet.update({
        where: { id: existing.id },
        data: {
          organizationId,
          agentId: agent.id,
          walletType: WalletType.AGENT,
          network: StellarNetwork.TESTNET,
          status: WalletStatus.PAUSED,
          deletedAt: null,
        },
      })
    : await tx.wallet.create({
        data: {
          id: fixture.walletId,
          organizationId,
          agentId: agent.id,
          stellarAddress: fixture.address,
          label: `${fixture.name} operating wallet`,
          walletType: WalletType.AGENT,
          network: StellarNetwork.TESTNET,
          status: WalletStatus.PAUSED,
          deletedAt: null,
        },
      });

  if (agent.primaryWalletId !== wallet.id) {
    await tx.agent.update({ where: { id: agent.id }, data: { primaryWalletId: wallet.id } });
  }
}

async function upsertPolicy(
  tx: Prisma.TransactionClient,
  organizationId: string,
  fixture: (typeof SEED_FIXTURES.policies)[number],
): Promise<void> {
  const data = {
    organizationId,
    name: fixture.name,
    type: fixture.type,
    configuration: fixture.configuration,
    priority: fixture.priority,
    enabled: true,
    deletedAt: null,
  };
  const existing = await tx.policy.findFirst({
    where: { organizationId, name: fixture.name },
  });
  if (existing) {
    if (
      existing.type !== fixture.type ||
      existing.priority !== fixture.priority ||
      !configMatches(existing.configuration, fixture.configuration)
    ) {
      throw new Error(`Policy name conflicts with the ${fixture.name} fixture.`);
    }
    return;
  }
  await tx.policy.create({ data: { id: fixture.id, ...data } });
}

async function upsertBudget(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
  data: Prisma.BudgetUncheckedCreateInput,
): Promise<{ id: string }> {
  const existing = await tx.budget.findFirst({
    where: {
      organizationId,
      name: data.name,
      parentBudgetId: data.parentBudgetId ?? null,
    },
  });
  if (existing) {
    return { id: existing.id };
  }
  return tx.budget.create({ data: { id, ...data } });
}

async function upsertWebhook(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  const data = {
    organizationId,
    url: TEST_WEBHOOK_URL,
    secret: TEST_WEBHOOK_SECRET,
    events: ['transaction.completed', 'proposal.created', 'budget.exceeded'],
    enabled: false,
  };
  const existing = await tx.webhook.findFirst({ where: { organizationId, url: TEST_WEBHOOK_URL } });
  if (existing) {
    await tx.webhook.update({ where: { id: existing.id }, data });
    return;
  }
  await tx.webhook.create({ data: { id: SEED_FIXTURES.webhookId, ...data } });
}

export async function seedFixtureRecords(prisma: PrismaClient): Promise<void> {
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  await prisma.$transaction(async (tx) => {
    const existingOrganization = await tx.organization.findUnique({
      where: { slug: SEED_FIXTURES.organization.slug },
    });
    if (
      existingOrganization &&
      (existingOrganization.name !== SEED_FIXTURES.organization.name ||
        existingOrganization.deletedAt ||
        existingOrganization.status !== OrganizationStatus.ACTIVE)
    ) {
      throw new Error('Organization slug conflicts with the astroid-labs fixture.');
    }
    const organization =
      existingOrganization ??
      (await tx.organization.create({ data: SEED_FIXTURES.organization }));

    for (const user of SEED_FIXTURES.users) {
      await upsertUser(tx, organization.id, user, passwordHash);
    }

    const agents = new Map<string, { id: string; primaryWalletId: string | null }>();
    for (const fixture of SEED_FIXTURES.agents) {
      const agent = await upsertAgent(tx, organization.id, fixture);
      agents.set(fixture.name, agent);
      await upsertWallet(tx, organization.id, agent, fixture);
    }

    for (const fixture of SEED_FIXTURES.policies) {
      await upsertPolicy(tx, organization.id, fixture);
    }

    const treasury = agents.get('Treasury Agent');
    if (!treasury) throw new Error('Treasury fixture was not created.');
    const rootBudget = await upsertBudget(
      tx,
      organization.id,
      SEED_FIXTURES.rootBudgetId,
      {
        organizationId: organization.id,
        parentBudgetId: null,
        name: 'Q3 Operations',
        currency: 'USDC',
        limitAmount: new Prisma.Decimal('50000'),
        period: BudgetPeriod.QUARTERLY,
        periodStart: FIXTURE_DATE,
        enabled: true,
      },
    );
    await upsertBudget(tx, organization.id, SEED_FIXTURES.childBudgetId, {
      organizationId: organization.id,
      parentBudgetId: rootBudget.id,
      agentId: treasury.id,
      name: 'Treasury monthly',
      currency: 'USDC',
      limitAmount: new Prisma.Decimal('10000'),
      period: BudgetPeriod.MONTHLY,
      periodStart: FIXTURE_DATE,
      enabled: true,
    });

    await upsertWebhook(tx, organization.id);
  });
}

function failIfInvalid(condition: boolean, fixture: string, detail: string): asserts condition {
  if (!condition) throw new FixtureValidationError(`${fixture}: ${detail}`);
}

function configMatches(actual: Prisma.JsonValue, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

function validPublicAddress(address: string): boolean {
  try {
    StrKey.decodeEd25519PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function verifyFixtureRecords(prisma: PrismaClient): Promise<void> {
  const organization = await prisma.organization.findUnique({
    where: { slug: SEED_FIXTURES.organization.slug },
  });
  failIfInvalid(
    Boolean(
      organization &&
        organization.name === SEED_FIXTURES.organization.name &&
        organization.status === OrganizationStatus.ACTIVE &&
        !organization.deletedAt,
    ),
    'organization astroid-labs',
    'missing or has an unexpected name/status',
  );
  if (!organization) return;

  for (const fixture of SEED_FIXTURES.users) {
    const user = await prisma.user.findUnique({ where: { email: fixture.email } });
    failIfInvalid(
      Boolean(
        user &&
          user.organizationId === organization.id &&
          user.role === fixture.role &&
          user.status === UserStatus.ACTIVE &&
          !user.deletedAt,
      ),
      `user ${fixture.email}`,
      'missing or has an invalid organization, role, or status',
    );
  }

  const agents = new Map<string, { id: string; primaryWalletId: string | null }>();
  for (const fixture of SEED_FIXTURES.agents) {
    const matchingAgents = await prisma.agent.findMany({
      where: { organizationId: organization.id, name: fixture.name, deletedAt: null },
    });
    const agent = matchingAgents[0];
    failIfInvalid(
      Boolean(
        matchingAgents.length === 1 &&
        agent &&
          agent.role === fixture.role &&
          agent.status === AgentStatus.PAUSED &&
          agent.provider === 'local-fixture' &&
          agent.model === 'disabled',
      ),
      `agent ${fixture.name}`,
      'missing or has an invalid role, status, or disabled provider configuration',
    );
    if (!agent) continue;
    agents.set(fixture.name, agent);

    const wallet = await prisma.wallet.findFirst({ where: { agentId: agent.id } });
    failIfInvalid(
      Boolean(
        wallet &&
          wallet.organizationId === organization.id &&
          wallet.network === StellarNetwork.TESTNET &&
          wallet.walletType === WalletType.AGENT &&
          wallet.status === WalletStatus.PAUSED &&
          agent.primaryWalletId === wallet.id &&
          validPublicAddress(wallet.stellarAddress),
      ),
      `wallet for ${fixture.name}`,
      'missing or has an invalid agent link, public address, test network, or paused status',
    );
  }

  for (const fixture of SEED_FIXTURES.policies) {
    const matchingPolicies = await prisma.policy.findMany({
      where: { organizationId: organization.id, name: fixture.name },
    });
    const policy = matchingPolicies[0];
    failIfInvalid(
      Boolean(
        matchingPolicies.length === 1 &&
        policy &&
          policy.type === fixture.type &&
          policy.priority === fixture.priority &&
          policy.enabled &&
          !policy.deletedAt &&
          configMatches(policy.configuration, fixture.configuration),
      ),
      `policy ${fixture.name}`,
      'missing or has an invalid type, configuration, priority, or enabled status',
    );
  }

  const matchingRootBudgets = await prisma.budget.findMany({
    where: { organizationId: organization.id, name: 'Q3 Operations', parentBudgetId: null },
  });
  const rootBudget = matchingRootBudgets[0];
  failIfInvalid(
    Boolean(
      matchingRootBudgets.length === 1 &&
      rootBudget &&
        rootBudget.currency === 'USDC' &&
        rootBudget.limitAmount.equals('50000') &&
        rootBudget.period === BudgetPeriod.QUARTERLY &&
        rootBudget.enabled,
    ),
    'budget Q3 Operations',
    'missing or has an invalid currency, limit, period, or enabled status',
  );
  if (!rootBudget) return;

  const treasury = agents.get('Treasury Agent');
  const matchingChildBudgets = await prisma.budget.findMany({
    where: {
      organizationId: organization.id,
      name: 'Treasury monthly',
      parentBudgetId: rootBudget.id,
    },
  });
  const childBudget = matchingChildBudgets[0];
  failIfInvalid(
    Boolean(
      matchingChildBudgets.length === 1 &&
      childBudget &&
        childBudget.agentId === treasury?.id &&
        childBudget.currency === 'USDC' &&
        childBudget.limitAmount.equals('10000') &&
        childBudget.period === BudgetPeriod.MONTHLY &&
        childBudget.enabled,
    ),
    'budget Treasury monthly',
    'missing or has an invalid parent, agent, currency, limit, period, or enabled status',
  );

  const matchingWebhooks = await prisma.webhook.findMany({
    where: { organizationId: organization.id, url: TEST_WEBHOOK_URL },
  });
  const webhook = matchingWebhooks[0];
  failIfInvalid(
    Boolean(
      matchingWebhooks.length === 1 &&
      webhook &&
        !webhook.enabled &&
        webhook.secret === TEST_WEBHOOK_SECRET &&
        ['transaction.completed', 'proposal.created', 'budget.exceeded'].every((event) =>
          webhook.events.includes(event),
        ),
    ),
    'webhook development fixture',
    'missing or enabled unexpectedly, or has invalid events/configuration',
  );
}

export async function runSeedCommand(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    assertSafeSeedEnvironment(env);
    await seedFixtureRecords(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

export async function runFixtureVerification(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    assertSafeSeedEnvironment(env);
    await verifyFixtureRecords(prisma);
  } finally {
    await prisma.$disconnect();
  }
}