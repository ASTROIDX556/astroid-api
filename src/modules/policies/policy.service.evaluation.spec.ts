import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Policy } from '@prisma/client';
import { PolicyService } from './policy.service';
import { PolicyEngine } from './policy.engine';
import { PriceOracleService, PriceUnavailableException } from './price-oracle.service';
import { AssetRegistryService } from './asset-registry.service';
import { SpendingPolicyService } from './spending-policy.service';
import { EventBusService } from '../../events/event-bus.service';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function policyRow(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'policy-1',
    organizationId: 'org-1',
    agentId: null,
    name: 'Spend policy',
    description: null,
    type: 'MAX_AMOUNT',
    configuration: {},
    priority: 100,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    overrideLimit: null,
    overrideUntil: null,
    originalLimit: null,
    ...overrides,
  } as unknown as Policy;
}

describe('PolicyService evaluation', () => {
  let service: PolicyService;
  let listActiveForEvaluation: ReturnType<typeof vi.fn>;
  let convert: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listActiveForEvaluation = vi.fn().mockResolvedValue([]);
    convert = vi.fn().mockImplementation(async (amount: number) => amount);
    emit = vi.fn().mockResolvedValue(undefined);

    service = new PolicyService(
      { listActiveForEvaluation } as unknown as SpendingPolicyService,
      new PolicyEngine(),
      { emit } as unknown as EventBusService,
      { convert } as unknown as PriceOracleService,
      { canonicalize: (asset: string) => asset } as unknown as AssetRegistryService,
    );
  });

  it('passes a valid single-asset intent when no policy applies', async () => {
    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 10,
      recipientAddress: 'GABC',
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('evaluates every leg of a multi-asset intent', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { assetLimits: { USDC: { maxAmount: 50 } } } }),
    ]);

    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 10,
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: 10 },
        { asset: 'USDC', amount: 100 },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
    expect(result.violations[0].asset).toBe('USDC');
  });

  it('converts the amounts when the policy denominates its limits in a base currency', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', maxAmount: 50 } }),
    ]);
    convert.mockImplementation(async (amount: number) => amount * 0.5);

    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 100,
      recipientAddress: 'GABC',
    });

    // 100 XLM → 50 USD, which is exactly at the limit and therefore allowed.
    expect(convert).toHaveBeenCalledWith(100, 'XLM', 'USD');
    expect(result.passed).toBe(true);
  });

  it('rejects a transfer whose converted amount exceeds the base-currency limit', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', maxAmount: 40 } }),
    ]);
    convert.mockImplementation(async (amount: number) => amount * 0.5);

    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 100,
      recipientAddress: 'GABC',
    });

    expect(result.passed).toBe(false);
    expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
    expect(result.violations[0].message).toContain('50 USD');
  });

  it('never converts an amount when no policy declares a base currency', async () => {
    listActiveForEvaluation.mockResolvedValue([policyRow({ configuration: { maxAmount: 50 } })]);

    await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 100,
      recipientAddress: 'GABC',
    });

    expect(convert).not.toHaveBeenCalled();
  });

  it('fails closed when the price required for a base-currency limit is unavailable', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', maxAmount: 50 } }),
    ]);
    convert.mockRejectedValue(
      new PriceUnavailableException('unavailable', 'XLM', 'USD', 'no quote'),
    );

    await expect(
      service.evaluateIntent({
        organizationId: 'org-1',
        asset: 'XLM',
        amount: 100,
        recipientAddress: 'GABC',
      }),
    ).rejects.toBeInstanceOf(PriceUnavailableException);
  });

  it('evaluates policies with different base currencies independently', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ id: 'policy-usd', configuration: { baseCurrency: 'USD', maxAmount: 10 } }),
      policyRow({ id: 'policy-xlm', configuration: { maxAmount: 1000 } }),
    ]);
    convert.mockImplementation(async (amount: number) => amount * 0.5);

    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 100,
      recipientAddress: 'GABC',
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].policyId).toBe('policy-usd');
    expect(result.evaluatedPolicyIds).toEqual(['policy-usd', 'policy-xlm']);
  });

  it('emits the policy evaluation event with the evaluated transfers', async () => {
    listActiveForEvaluation.mockResolvedValue([policyRow({ configuration: { maxAmount: 1000 } })]);

    await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 10,
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: 10 },
        { asset: `USDC:${ISSUER}`, amount: 20 },
      ],
    });

    expect(emit).toHaveBeenCalledWith(
      'policy.evaluated',
      expect.objectContaining({
        transfers: [
          { asset: 'XLM', amount: 10 },
          { asset: `USDC:${ISSUER}`, amount: 20 },
        ],
      }),
      expect.any(Object),
    );
  });

  it('converts every leg of a multi-asset transfer into the base currency', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', maxAmount: 1000 } }),
    ]);
    convert.mockImplementation(async (amount: number) => amount * 0.5);

    const result = await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 100,
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: 100 },
        { asset: 'USDC', amount: 200 },
      ],
    });

    expect(convert).toHaveBeenCalledWith(100, 'XLM', 'USD');
    expect(convert).toHaveBeenCalledWith(200, 'USDC', 'USD');
    expect(result.passed).toBe(true);
  });

  it('converts the spend already accumulated for every asset', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', dailyLimit: 1000 } }),
    ]);
    convert.mockImplementation(async (amount: number) => amount * 0.5);

    await service.evaluateIntent({
      organizationId: 'org-1',
      asset: 'XLM',
      amount: 10,
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: 10 },
        { asset: 'USDC', amount: 20 },
      ],
      spentByAsset: {
        XLM: { spentToday: 100, spentThisWeek: 100, spentThisMonth: 100 },
        USDC: { spentToday: 200, spentThisWeek: 200, spentThisMonth: 200 },
      },
    });

    expect(convert).toHaveBeenCalledWith(100, 'XLM', 'USD');
    expect(convert).toHaveBeenCalledWith(200, 'USDC', 'USD');
  });

  it('fails closed when the price of one leg of a multi-asset transfer is unavailable', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { baseCurrency: 'USD', maxAmount: 1000 } }),
    ]);
    convert.mockImplementation(async (amount: number, asset: string) => {
      if (asset === 'USDC') {
        throw new PriceUnavailableException('unavailable', 'USDC', 'USD', 'no quote');
      }
      return amount;
    });

    await expect(
      service.evaluateIntent({
        organizationId: 'org-1',
        asset: 'XLM',
        amount: 10,
        recipientAddress: 'GABC',
        transfers: [
          { asset: 'XLM', amount: 10 },
          { asset: 'USDC', amount: 20 },
        ],
      }),
    ).rejects.toBeInstanceOf(PriceUnavailableException);
  });
});

describe('PolicyService simulate', () => {
  let service: PolicyService;
  let listActiveForEvaluation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listActiveForEvaluation = vi.fn().mockResolvedValue([]);
    service = new PolicyService(
      { listActiveForEvaluation } as unknown as SpendingPolicyService,
      new PolicyEngine(),
      { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService,
      { convert: vi.fn(async (amount: number) => amount) } as unknown as PriceOracleService,
      {
        canonicalize: (asset: string) => (asset === 'USDC' ? `USDC:${ISSUER}` : asset),
      } as unknown as AssetRegistryService,
    );
  });

  it('canonicalizes every leg of a multi-asset payload', async () => {
    const result = await service.simulate('org-1', {
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: '10' },
        { asset: 'USDC', amount: '20' },
      ],
    });

    expect(result.passed).toBe(true);
    expect(listActiveForEvaluation).toHaveBeenCalled();
  });

  it('falls back to the first leg when the payload has no top-level amount', async () => {
    const result = await service.simulate('org-1', {
      recipientAddress: 'GABC',
      transfers: [{ asset: 'USDC', amount: '20' }],
    });

    expect(result.passed).toBe(true);
  });

  it('reports the violations of the simulated policies', async () => {
    listActiveForEvaluation.mockResolvedValue([
      policyRow({ configuration: { assetLimits: { USDC: { maxAmount: 10 } } } }),
    ]);

    const result = await service.simulate('org-1', {
      recipientAddress: 'GABC',
      transfers: [
        { asset: 'XLM', amount: '5' },
        { asset: 'USDC', amount: '50' },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
    expect(result.violations[0].asset).toBe('USDC');
  });
});
