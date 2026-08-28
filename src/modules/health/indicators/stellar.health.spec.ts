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
});
