import { describe, expect, it } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskEngine } from './risk.engine';
import { RiskFactorsInput, RiskRuleContext, RiskRule } from './risk.types';

const lowRisk: RiskFactorsInput = {
  amount: 20,
  asset: 'USDC',
  knownRecipient: true,
  recentTransactionCount: 1,
  walletAgeDays: 365,
  policyViolations: 0,
  hourUtc: 12,
};

describe('RiskEngine', () => {
  const engine = new RiskEngine();

  // ── Built-in rule behaviour ──────────────────────────────────────────────

  it('scores a small, known, seasoned transaction as Low', () => {
    const result = engine.assess(lowRisk);
    expect(result.band).toBe(RiskBand.LOW);
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.canAutoExecute).toBe(true);
  });

  it('raises score for an unknown recipient', () => {
    const known = engine.assess(lowRisk);
    const unknown = engine.assess({ ...lowRisk, knownRecipient: false });
    expect(unknown.score).toBeGreaterThan(known.score);
  });

  it('raises score for a brand-new wallet', () => {
    const result = engine.assess({ ...lowRisk, walletAgeDays: 0 });
    expect(result.score).toBeGreaterThan(engine.assess(lowRisk).score);
  });

  it('raises score for high velocity', () => {
    const result = engine.assess({ ...lowRisk, recentTransactionCount: 20 });
    expect(result.score).toBeGreaterThan(engine.assess(lowRisk).score);
  });

  it('produces a Critical band for a large unknown high-violation transfer', () => {
    const result = engine.assess({
      amount: 50_000,
      asset: 'USDC',
      knownRecipient: false,
      recentTransactionCount: 20,
      walletAgeDays: 0,
      policyViolations: 3,
      hourUtc: 2,
    });
    expect(result.band).toBe(RiskBand.CRITICAL);
    expect(result.canAutoExecute).toBe(false);
  });

  it('never exceeds 100 or drops below 0', () => {
    const result = engine.assess({
      amount: 1_000_000,
      asset: 'USDC',
      knownRecipient: false,
      recentTransactionCount: 999,
      walletAgeDays: 0,
      policyViolations: 99,
      hourUtc: 1,
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('adds weight for suspicious overnight timing', () => {
    const day = engine.assess({ ...lowRisk, knownRecipient: false, hourUtc: 12 });
    const night = engine.assess({ ...lowRisk, knownRecipient: false, hourUtc: 2 });
    expect(night.score).toBeGreaterThan(day.score);
  });

  it('returns a factor breakdown for every rule', () => {
    const result = engine.assess(lowRisk);
    expect(result.factors.length).toBe(6);
    const names = result.factors.map((f) => f.factor);
    expect(names).toContain('amount');
    expect(names).toContain('unknownRecipient');
    expect(names).toContain('velocity');
    expect(names).toContain('walletAge');
    expect(names).toContain('policyViolations');
    expect(names).toContain('suspiciousTiming');
  });

  // ── Configurable band thresholds ─────────────────────────────────────────

  it('maps score thresholds to the default bands', () => {
    expect(engine.toBand(0)).toBe(RiskBand.LOW);
    expect(engine.toBand(20)).toBe(RiskBand.LOW);
    expect(engine.toBand(21)).toBe(RiskBand.MEDIUM);
    expect(engine.toBand(50)).toBe(RiskBand.MEDIUM);
    expect(engine.toBand(51)).toBe(RiskBand.HIGH);
    expect(engine.toBand(80)).toBe(RiskBand.HIGH);
    expect(engine.toBand(81)).toBe(RiskBand.CRITICAL);
    expect(engine.toBand(100)).toBe(RiskBand.CRITICAL);
  });

  it('respects custom band thresholds from config', () => {
    const custom = { bandThresholds: { lowMax: 30, medMax: 60, highMax: 90 } };
    expect(engine.toBand(30, custom)).toBe(RiskBand.LOW);
    expect(engine.toBand(31, custom)).toBe(RiskBand.MEDIUM);
    expect(engine.toBand(60, custom)).toBe(RiskBand.MEDIUM);
    expect(engine.toBand(61, custom)).toBe(RiskBand.HIGH);
    expect(engine.toBand(90, custom)).toBe(RiskBand.HIGH);
    expect(engine.toBand(91, custom)).toBe(RiskBand.CRITICAL);
  });

  // ── Configurable saturation thresholds ───────────────────────────────────

  it('uses config to override amount saturation', () => {
    const config = { amountSaturation: 100 };
    // amount=100 with saturation=100 → ratio=1 → full weight (30)
    const result = engine.assess(
      { ...lowRisk, amount: 100 },
      config,
    );
    // Should have a high amount contribution
    const amountFactor = result.factors.find((f) => f.factor === 'amount');
    expect(amountFactor!.contribution).toBe(30);
  });

  it('uses config to override velocity saturation', () => {
    const config = { velocitySaturation: 5 };
    // 5 recent txns with saturation=5 → ratio=1 → full weight (15)
    const result = engine.assess(
      { ...lowRisk, recentTransactionCount: 5 },
      config,
    );
    const velocityFactor = result.factors.find((f) => f.factor === 'velocity');
    expect(velocityFactor!.contribution).toBe(15);
  });

  it('uses config to override wallet seasoned days', () => {
    const config = { walletSeasonedDays: 30 };
    // 30 days old with seasoned=30 → ratio=1 → contribution=0 (fully seasoned)
    const result = engine.assess(
      { ...lowRisk, walletAgeDays: 30 },
      config,
    );
    const walletFactor = result.factors.find((f) => f.factor === 'walletAge');
    expect(walletFactor!.contribution).toBe(0);
  });

  it('uses config to override suspicious hour window', () => {
    const config = { suspiciousHourStart: 6, suspiciousHourEnd: 10 };
    // hourUtc=7 falls in the custom suspicious window
    const result = engine.assess(
      { ...lowRisk, hourUtc: 7 },
      config,
    );
    const timingFactor = result.factors.find((f) => f.factor === 'suspiciousTiming');
    expect(timingFactor!.contribution).toBe(timingFactor!.weight);
  });

  // ── Configurable weights ─────────────────────────────────────────────────

  it('uses config weights to override default rule weights', () => {
    const config = { weights: { amount: 50 } };
    const result = engine.assess(
      { ...lowRisk, amount: 10_000 },
      config,
    );
    const amountFactor = result.factors.find((f) => f.factor === 'amount');
    expect(amountFactor!.weight).toBe(50);
    expect(amountFactor!.contribution).toBe(50);
  });

  // ── Pluggable rules ─────────────────────────────────────────────────────

  it('accepts custom rules alongside built-in rules', () => {
    const customRule: RiskRule = {
      name: 'customFlag',
      defaultWeight: 10,
      evaluate({ input }: RiskRuleContext) {
        return {
          factor: 'customFlag',
          weight: 10,
          contribution: input.asset === 'SCAM' ? 10 : 0,
          detail: input.asset === 'SCAM' ? 'Scam asset detected' : 'Normal asset',
        };
      },
    };

    const result = engine.assess(lowRisk, undefined, [customRule]);
    expect(result.factors.length).toBe(1);
    expect(result.factors[0].factor).toBe('customFlag');
    expect(result.factors[0].contribution).toBe(0);
  });

  it('custom rules can push score to Critical', () => {
    const heavyRule: RiskRule = {
      name: 'heavyPenalty',
      defaultWeight: 100,
      evaluate() {
        return {
          factor: 'heavyPenalty',
          weight: 100,
          contribution: 100,
          detail: 'Automatic critical',
        };
      },
    };

    const result = engine.assess(lowRisk, undefined, [heavyRule]);
    expect(result.band).toBe(RiskBand.CRITICAL);
    expect(result.canAutoExecute).toBe(false);
  });

  it('replaces built-in rules when custom rules array is provided', () => {
    // Only one rule → only that rule's factor appears
    const soloRule: RiskRule = {
      name: 'solo',
      defaultWeight: 42,
      evaluate() {
        return { factor: 'solo', weight: 42, contribution: 42, detail: 'Solo rule' };
      },
    };

    const result = engine.assess(lowRisk, undefined, [soloRule]);
    expect(result.factors.length).toBe(1);
    expect(result.factors[0].factor).toBe('solo');
    expect(result.score).toBe(42);
  });
});
