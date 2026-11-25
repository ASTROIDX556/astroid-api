import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessCheck, ReadinessRunner } from './readiness-runner';

const up = (latencyMs = 3) => ({
  status: 'up',
  latencyMs,
  timestamp: '2026-01-01T00:00:00.000Z',
});

const config = (overrides: Partial<{ checkTimeoutMs: number; readinessCacheTtlMs: number }> = {}) => ({
  checkTimeoutMs: 1_000,
  readinessCacheTtlMs: 0,
  ...overrides,
});

describe('ReadinessRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports up with per-check latency when every check passes', async () => {
    const runner = new ReadinessRunner(config());

    const report = await runner.run([
      { name: 'database', run: async () => up(5) },
      { name: 'cache', run: async () => up(2) },
    ]);

    expect(report.status).toBe('up');
    expect(report.checks).toEqual([
      expect.objectContaining({ name: 'database', status: 'up', latencyMs: 5, required: true }),
      expect.objectContaining({ name: 'cache', status: 'up', latencyMs: 2, required: true }),
    ]);
  });

  it('reports down when the database check fails but still reports the cache', async () => {
    const runner = new ReadinessRunner(config());

    const report = await runner.run([
      {
        name: 'database',
        run: async () => ({ ...up(), status: 'down', error: 'connect ECONNREFUSED 10.0.0.5:5432' }),
      },
      { name: 'cache', run: async () => up() },
    ]);

    expect(report.status).toBe('down');
    expect(report.checks[0]).toMatchObject({ name: 'database', status: 'down', error: 'unavailable' });
    expect(report.checks[1]).toMatchObject({ name: 'cache', status: 'up' });
  });

  it('reports down when the cache check fails but still reports the database', async () => {
    const runner = new ReadinessRunner(config());

    const report = await runner.run([
      { name: 'database', run: async () => up() },
      {
        name: 'cache',
        run: async () => ({ ...up(), status: 'down', error: 'Redis connection is closed' }),
      },
    ]);

    expect(report.status).toBe('down');
    expect(report.checks.map((c) => [c.name, c.status])).toEqual([
      ['database', 'up'],
      ['cache', 'down'],
    ]);
  });

  it('converts a throwing check into down/unavailable without leaking the message', async () => {
    const runner = new ReadinessRunner(config());

    const report = await runner.run([
      {
        name: 'database',
        run: async () => {
          throw new Error('password authentication failed for user "astroid" at db.internal:5432');
        },
      },
    ]);

    expect(report.status).toBe('down');
    expect(report.checks[0]).toMatchObject({ status: 'down', error: 'unavailable' });
    expect(JSON.stringify(report)).not.toMatch(/astroid|db\.internal|5432|password/);
  });

  it('enforces the per-check timeout on a check that never settles', async () => {
    vi.useFakeTimers();
    const runner = new ReadinessRunner(config({ checkTimeoutMs: 1_000 }));

    const pending = runner.run([
      { name: 'database', run: () => new Promise<never>(() => undefined) },
      { name: 'cache', run: async () => up() },
    ]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;

    expect(report.status).toBe('down');
    expect(report.checks[0]).toMatchObject({
      name: 'database',
      status: 'down',
      error: 'timeout',
      latencyMs: 1_000,
    });
    expect(report.checks[1]).toMatchObject({ name: 'cache', status: 'up' });
  });

  it('passes the configured timeout to each check', async () => {
    const run = vi.fn().mockResolvedValue(up());
    await new ReadinessRunner(config({ checkTimeoutMs: 750 })).run([{ name: 'database', run }]);

    expect(run).toHaveBeenCalledWith(750);
  });

  it('classifies an indicator-side timeout message as timeout', async () => {
    const report = await new ReadinessRunner(config()).run([
      {
        name: 'cache',
        run: async () => ({ ...up(), status: 'down', error: 'Redis health check timed out after 1000ms' }),
      },
    ]);

    expect(report.checks[0]).toMatchObject({ status: 'down', error: 'timeout' });
  });

  it('lets an optional check fail without failing readiness', async () => {
    const report = await new ReadinessRunner(config()).run([
      { name: 'database', run: async () => up() },
      { name: 'soroban', required: false, run: async () => ({ ...up(), status: 'down' }) },
    ]);

    expect(report.status).toBe('up');
    expect(report.checks[1]).toMatchObject({ name: 'soroban', status: 'down', required: false });
  });

  it('runs a newly added check without any other change', async () => {
    const extra: ReadinessCheck = { name: 'queue', run: async () => up(9) };

    const report = await new ReadinessRunner(config()).run([
      { name: 'database', run: async () => up() },
      extra,
    ]);

    expect(report.checks.map((c) => c.name)).toEqual(['database', 'queue']);
  });

  it('reports an empty check list as up', async () => {
    expect(await new ReadinessRunner(config()).run([])).toEqual({ status: 'up', checks: [] });
  });

  describe('result caching', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('does not cache when the TTL is 0', async () => {
      const run = vi.fn().mockResolvedValue(up());
      const runner = new ReadinessRunner(config({ readinessCacheTtlMs: 0 }));

      await runner.run([{ name: 'database', run }]);
      await runner.run([{ name: 'database', run }]);

      expect(run).toHaveBeenCalledTimes(2);
    });

    it('reuses a result within the TTL and probes again after it expires', async () => {
      const run = vi.fn().mockResolvedValue(up());
      const runner = new ReadinessRunner(config({ readinessCacheTtlMs: 1_500 }));
      const checks: ReadinessCheck[] = [{ name: 'database', run }];

      await runner.run(checks);
      await runner.run(checks);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_501);
      await runner.run(checks);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight run between concurrent callers', async () => {
      const run = vi.fn().mockResolvedValue(up());
      const runner = new ReadinessRunner(config({ readinessCacheTtlMs: 1_000 }));
      const checks: ReadinessCheck[] = [{ name: 'database', run }];

      await Promise.all([runner.run(checks), runner.run(checks), runner.run(checks)]);

      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
