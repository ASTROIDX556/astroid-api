import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createQueryMetricsExtension } from './query-metrics.extension';

describe('createQueryMetricsExtension', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let clockSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    clockSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  it('passes fast queries through without logging', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 250 });
    clockSpy.mockReturnValueOnce(0).mockReturnValueOnce(249);
    const resultValue = [{ id: '1' }];
    const fastQuery = vi.fn().mockResolvedValue(resultValue);

    const result = await ext.query.$allOperations({
      operation: 'findMany',
      model: 'User',
      args: {},
      query: fastQuery,
    });

    expect(result).toBe(resultValue);
    expect(fastQuery).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when duration is exactly the configured threshold', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 250 });
    clockSpy.mockReturnValueOnce(100).mockReturnValueOnce(350);

    await ext.query.$allOperations({
      operation: 'findMany',
      model: 'User',
      args: {},
      query: vi.fn().mockResolvedValue('ok'),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns above the threshold with model, operation, duration, and threshold metadata', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 250 });
    clockSpy.mockReturnValueOnce(100).mockReturnValueOnce(351);

    await ext.query.$allOperations({
      operation: 'findMany',
      model: 'Transaction',
      args: {},
      query: vi.fn().mockResolvedValue('ok'),
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(record).toMatchObject({
      event: 'slow_query',
      operation: 'findMany',
      model: 'Transaction',
      durationMs: 251,
      thresholdMs: 250,
    });
  });

  it('supports a custom threshold and raw operations without a model name', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 10 });
    clockSpy.mockReturnValueOnce(20).mockReturnValueOnce(31);

    await ext.query.$allOperations({
      operation: '$queryRaw',
      args: [],
      query: vi.fn().mockResolvedValue([]),
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(record).toMatchObject({
      event: 'slow_query',
      operation: '$queryRaw',
      durationMs: 11,
      thresholdMs: 10,
    });
    expect(record).not.toHaveProperty('model');
  });

  it('does not expose nested query arguments or error messages in warning logs', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 1 });
    clockSpy.mockReturnValueOnce(0).mockReturnValueOnce(2);
    const args = {
      data: {
        privateKey: 'private-value',
        nested: [{ secret: 'secret-value', password: 'password-value' }],
        token: 'token-value',
        seedPhrase: 'seed-value',
      },
    };
    const query = vi.fn().mockRejectedValue(new Error('sensitive database failure'));
    const extension = ext.query.$allOperations({
      operation: 'create',
      model: 'Wallet',
      args,
      query,
    });

    await expect(extension).rejects.toBeInstanceOf(Error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(args);
    const warning = String(warnSpy.mock.calls[0][0]);
    for (const secret of [
      'private-value',
      'secret-value',
      'password-value',
      'token-value',
      'seed-value',
      'sensitive database failure',
    ]) {
      expect(warning).not.toContain(secret);
    }
  });

  it('propagates database errors unchanged and times independent operations separately', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 100 });
    const boom = new Error('database unavailable');
    const failingQuery = vi.fn().mockRejectedValue(boom);
    clockSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(600);

    await expect(
      ext.query.$allOperations({
        operation: 'create',
        model: 'Organization',
        args: {},
        query: failingQuery,
      }),
    ).rejects.toBe(boom);
    await ext.query.$allOperations({
      operation: 'findMany',
      model: 'User',
      args: {},
      query: vi.fn().mockResolvedValue('unchanged'),
    });

    expect(failingQuery).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      operation: 'create',
      model: 'Organization',
      durationMs: 101,
    });
  });

  it('returns a successful result unchanged after a slow operation', async () => {
    const ext = createQueryMetricsExtension({ slowQueryThresholdMs: 5 });
    clockSpy.mockReturnValueOnce(0).mockReturnValueOnce(6);
    const value = { id: 'result' };
    const query = vi.fn().mockResolvedValue(value);

    await expect(
      ext.query.$allOperations({
        operation: 'findUnique',
        model: 'User',
        args: {},
        query,
      }),
    ).resolves.toBe(value);
    expect(query).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
