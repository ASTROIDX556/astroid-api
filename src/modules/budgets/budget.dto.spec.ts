import { describe, expect, it } from 'vitest';
import { createBudgetSchema, updateBudgetSchema } from './budget.dto';

const base = { name: 'Q3 Marketing', limitAmount: '10000.0000000' };

describe('budget alertThresholds validation', () => {
  it('accepts a strictly ascending list within 1..100', () => {
    expect(createBudgetSchema.parse({ ...base, alertThresholds: [50, 80, 100] }).alertThresholds).toEqual([
      50, 80, 100,
    ]);
  });

  it('accepts an omitted list, meaning the global defaults apply', () => {
    expect(createBudgetSchema.parse(base).alertThresholds).toBeUndefined();
  });

  it('accepts an empty list, meaning the global defaults apply', () => {
    expect(createBudgetSchema.parse({ ...base, alertThresholds: [] }).alertThresholds).toEqual([]);
  });

  it.each([
    ['zero', [0]],
    ['above 100', [80, 101]],
    ['negative', [-5]],
    ['non-integer', [79.5]],
    ['descending', [90, 80]],
    ['duplicated', [80, 80]],
    ['more than 20 entries', Array.from({ length: 21 }, (_, i) => i + 1)],
  ])('rejects a %s list', (_label, alertThresholds) => {
    expect(createBudgetSchema.safeParse({ ...base, alertThresholds }).success).toBe(false);
  });

  it('applies the same rules to updates', () => {
    expect(
      updateBudgetSchema.parse({ alertThresholds: [50, 90] }).alertThresholds,
    ).toEqual([50, 90]);
    expect(updateBudgetSchema.safeParse({ alertThresholds: [90, 50] }).success).toBe(false);
    expect(updateBudgetSchema.safeParse({ alertThresholds: [0, 100] }).success).toBe(false);
  });
});
