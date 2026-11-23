/**
 * Astroid API — database seed.
 *
 * Provisions a realistic demo organization so a fresh database is immediately
 * explorable: an owner + finance user, a couple of AI agents each with a
 * non-custodial Stellar wallet, guardrail policies, a monthly budget hierarchy
 * and a webhook subscription. It is idempotent — re-running upserts by natural
 * keys and never duplicates rows.
 *
 * Secrets are handled the same way the running API handles them: the seed
 * generates Stellar keypairs, persists only the public address, and prints the
 * secret keys to stdout exactly once for local funding. Nothing secret is stored.
 */
import {
  PrismaClient,
  UserRole,
  AgentRole,
  WalletType,
  StellarNetwork,
  PolicyType,
  BudgetPeriod,
  Prisma,
} from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

/** Deterministic demo password so the seeded accounts can be logged into. */
const DEMO_PASSWORD = 'Astroid!Demo123';

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  // --- Organization ---------------------------------------------------------
  const org = await prisma.organization.upsert({
    where: { slug: 'astroid-labs' },
    update: {},
    create: {
      name: 'Astroid Labs',
      slug: 'astroid-labs',
      description: 'Financial operating system for autonomous AI agents.',
      plan: 'GROWTH',
    },
  });

  // --- Users ----------------------------------------------------------------
  const owner = await prisma.user.upsert({
    where: { email: 'owner@astroid.dev' },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Ava Owner',
      email: 'owner@astroid.dev',
      role: UserRole.OWNER,
      passwordHash,
    },
  });

  await prisma.user.upsert({
    where: { email: 'finance@astroid.dev' },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Finn Finance',
      email: 'finance@astroid.dev',
      role: UserRole.FINANCE,
      passwordHash,
    },
  });

  // --- Agents + non-custodial wallets ---------------------------------------
  const generatedSecrets: Array<{ agent: string; address: string; secret: string }> = [];

  async function provisionAgent(
    name: string,
    role: AgentRole,
    description: string,
  ): Promise<{ agentId: string; walletId: string }> {
    const existingAgent = await prisma.agent.findFirst({
      where: { organizationId: org.id, name },
    });

    const keypair = Keypair.random();
    const address = keypair.publicKey();

    if (existingAgent) {
      const wallet = await prisma.wallet.findFirst({
        where: { agentId: existingAgent.id },
      });
      return {
        agentId: existingAgent.id,
        walletId: wallet?.id ?? '',
      };
    }

    const agent = await prisma.agent.create({
      data: {
        organizationId: org.id,
        name,
        role,
        description,
        provider: 'anthropic',
        model: 'claude-opus-4',
        capabilities: ['payments', 'analysis'],
      },
    });

    const wallet = await prisma.wallet.create({
      data: {
        organizationId: org.id,
        agentId: agent.id,
        stellarAddress: address,
        label: `${name} operating wallet`,
        walletType: WalletType.AGENT,
        network: StellarNetwork.TESTNET,
      },
    });

    // Link the wallet as the agent's primary wallet.
    await prisma.agent.update({
      where: { id: agent.id },
      data: { primaryWalletId: wallet.id },
    });

    generatedSecrets.push({ agent: name, address, secret: keypair.secret() });

    return { agentId: agent.id, walletId: wallet.id };
  }

  const treasury = await provisionAgent(
    'Treasury Agent',
    AgentRole.FINANCE,
    'Manages recurring vendor settlements within budget guardrails.',
  );
  await provisionAgent(
    'Procurement Agent',
    AgentRole.PROCUREMENT,
    'Sources and pays for compute and data subscriptions.',
  );

  // --- Policies -------------------------------------------------------------
  async function ensurePolicy(
    name: string,
    type: PolicyType,
    configuration: Prisma.InputJsonValue,
    priority: number,
  ): Promise<void> {
    const existing = await prisma.policy.findFirst({
      where: { organizationId: org.id, name },
    });
    if (existing) return;
    await prisma.policy.create({
      data: { organizationId: org.id, name, type, configuration, priority },
    });
  }

  await ensurePolicy(
    'Per-transaction ceiling',
    PolicyType.MAX_AMOUNT,
    { maxAmount: '5000', asset: 'USDC' },
    10,
  );
  await ensurePolicy(
    'Allowed assets',
    PolicyType.ALLOWED_ASSETS,
    { assets: ['USDC', 'XLM'] },
    20,
  );
  await ensurePolicy(
    'Large payments need review',
    PolicyType.AGENT_RULE,
    { requiresApprovalAbove: '1000', asset: 'USDC' },
    30,
  );

  // --- Budgets (org -> agent) ----------------------------------------------
  let rootBudget = await prisma.budget.findFirst({
    where: { organizationId: org.id, name: 'Q3 Operations', parentBudgetId: null },
  });
  if (!rootBudget) {
    rootBudget = await prisma.budget.create({
      data: {
        organizationId: org.id,
        name: 'Q3 Operations',
        currency: 'USDC',
        limitAmount: new Prisma.Decimal('50000'),
        period: BudgetPeriod.QUARTERLY,
      },
    });
  }

  const childBudgetExists = await prisma.budget.findFirst({
    where: { organizationId: org.id, name: 'Treasury monthly', parentBudgetId: rootBudget.id },
  });
  if (!childBudgetExists) {
    await prisma.budget.create({
      data: {
        organizationId: org.id,
        parentBudgetId: rootBudget.id,
        agentId: treasury.agentId,
        name: 'Treasury monthly',
        currency: 'USDC',
        limitAmount: new Prisma.Decimal('10000'),
        period: BudgetPeriod.MONTHLY,
      },
    });
  }

  // --- Webhook subscription -------------------------------------------------
  const webhookExists = await prisma.webhook.findFirst({
    where: { organizationId: org.id, url: 'https://example.com/astroid/webhook' },
  });
  if (!webhookExists) {
    await prisma.webhook.create({
      data: {
        organizationId: org.id,
        url: 'https://example.com/astroid/webhook',
        secret: `whsec_${Keypair.random().secret().slice(1, 25)}`,
        events: ['transaction.completed', 'proposal.created', 'budget.exceeded'],
      },
    });
  }

  // --- Scoped API key (read-only integration) -------------------------------
  // Demonstrates the scope model: this key can read wallets and transactions
  // but is rejected by every write route.
  const demoApiKey = 'ak_test_seeded_readonly_integration_key';
  const demoApiKeyHash = createHash('sha256').update(demoApiKey).digest('hex');
  const existingApiKey = await prisma.apiKey.findUnique({
    where: { hashedKey: demoApiKeyHash },
  });
  if (!existingApiKey) {
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        createdById: owner.id,
        name: 'Seeded read-only integration',
        prefix: demoApiKey.slice(0, 14),
        hashedKey: demoApiKeyHash,
        permissions: [],
        scopes: ['wallet:read', 'transaction:read'],
      },
    });
  }

  // --- Summary --------------------------------------------------------------
  // eslint-disable-next-line no-console
  console.log('Seed complete:');
  // eslint-disable-next-line no-console
  console.log(`  organization : ${org.name} (${org.slug})`);
  // eslint-disable-next-line no-console
  console.log(`  owner login  : ${owner.email} / ${DEMO_PASSWORD}`);
  // eslint-disable-next-line no-console
  console.log(`  readonly key : ${demoApiKey} (scopes: wallet:read, transaction:read)`);
  if (generatedSecrets.length > 0) {
    // eslint-disable-next-line no-console
    console.log('  wallet secrets (shown once — fund on testnet, never stored):');
    for (const s of generatedSecrets) {
      // eslint-disable-next-line no-console
      console.log(`    ${s.agent}: ${s.address}  secret=${s.secret}`);
    }
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
