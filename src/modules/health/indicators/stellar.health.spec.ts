import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { StellarHealthIndicator } from './stellar.health';

describe('StellarHealthIndicator', () => {
  const mockConfigService = {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'stellar') {
        return {
          network: 'testnet',
          horizonUrl: 'https://horizon-testnet.stellar.org',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          registryContractId: 'CC...',
          useMock: false,
        };
      }
      return null;
    }),
  } as unknown as ConfigService;

  let indicator: StellarHealthIndicator;

  beforeEach(() => {
    indicator = new StellarHealthIndicator(mockConfigService);
    vi.restoreAllMocks();
  });

  it('should return UP when both Horizon and Soroban endpoints are healthy', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('horizon')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              history_latest_ledger: 54321,
              protocol_version: 21,
            }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            result: {
              status: 'healthy',
              latestLedger: 54321,
            },
          }),
      } as unknown as Response);
    });

    const report = await indicator.checkHealth();

    expect(report.status).toBe('up');
    expect(report.network).toBe('testnet');
    expect(report.horizon.status).toBe('up');
    expect(report.horizon.ledgerSequence).toBe(54321);
    expect(report.sorobanRpc.status).toBe('up');
    expect(report.sorobanRpc.ledgerSequence).toBe(54321);
  });

  it('should report DOWN if an endpoint fails to connect or throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network connection refused'));

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.horizon.status).toBe('down');
    expect(report.horizon.error).toContain('Network connection refused');
    expect(report.sorobanRpc.status).toBe('down');
  });

  it('should report DEGRADED if response is not ok (non-200)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      return Promise.resolve({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as unknown as Response);
    });

    const report = await indicator.checkHealth();

    expect(report.status).toBe('degraded');
    expect(report.horizon.status).toBe('degraded');
    expect(report.horizon.error).toBe('HTTP 503 Service Unavailable');
  });

  it('reports DEGRADED when an endpoint answers but needs more than half of the budget', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ history_latest_ledger: 1, protocol_version: 21 }),
      } as unknown as Response;
    });

    // A 50 ms budget is exhausted at 25 ms, so the 40 ms answer is degraded.
    const report = await indicator.checkHealth(50);

    expect(report.status).toBe('degraded');
    expect(report.horizon.status).toBe('degraded');
    expect(report.horizon.latencyMs).toBeGreaterThanOrEqual(25);
  });

  it('aborts a hanging endpoint and reports it as DOWN within the budget', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    );

    const started = Date.now();
    const report = await indicator.checkHealth(30);
    const elapsed = Date.now() - started;

    expect(report.status).toBe('down');
    expect(report.horizon.status).toBe('down');
    expect(report.sorobanRpc.status).toBe('down');
    expect(elapsed).toBeLessThan(1_000);
  });

  describe('checkSorobanRpcReadiness', () => {
    const healthyRpc = () =>
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { status: 'healthy', latestLedger: 9 } }),
      } as unknown as Response);

    it('reports up without exposing the RPC endpoint URL', async () => {
      healthyRpc();

      const report = await indicator.checkSorobanRpcReadiness();

      expect(report).toMatchObject({ status: 'up', latencyMs: expect.any(Number) });
      expect(report).not.toHaveProperty('url');
      expect(JSON.stringify(report)).not.toContain('soroban-testnet');
    });

    it('reports down when the RPC answers with a non-2xx status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as unknown as Response);

      const report = await indicator.checkSorobanRpcReadiness();

      expect(report.status).toBe('down');
      expect(report).not.toHaveProperty('url');
    });

    it('bounds the probe by the configured RPC timeout', async () => {
      const config = {
        getOrThrow: () => ({
          network: 'testnet',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          sorobanRpc: { timeoutMs: 20 },
        }),
      } as unknown as ConfigService;
      const fastIndicator = new StellarHealthIndicator(config);
      vi.spyOn(global, 'fetch').mockImplementation(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            );
          }),
      );

      const started = Date.now();
      const report = await fastIndicator.checkSorobanRpcReadiness();

      expect(report.status).toBe('down');
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it('falls back to the default budget when a non-positive timeout is given', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('horizon')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ history_latest_ledger: 7 }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { status: 'healthy', latestLedger: 7 } }),
      } as unknown as Response);
    });

    const report = await indicator.checkHealth(0);

    expect(report.status).toBe('up');
  });
});
