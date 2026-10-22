import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GasEstimationService } from './gas-estimation.service';
import {
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { StellarConfig } from '../../../config/stellar.config';

const SETTINGS: Partial<StellarConfig> = {
  gasSafetyBufferPercent: 25,
  maxGasLimit: 100_000_000,
  fallbackGasLimit: 1_000_000,
  fallbackFeeStroops: 100_000,
};

function buildConfig(overrides: Partial<StellarConfig> = {}): ConfigService {
  return {
    get: vi.fn((key: string) =>
      key === 'stellar' ? { ...SETTINGS, ...overrides } : undefined,
    ),
  } as unknown as ConfigService;
}

function buildSimulation(
  overrides: Partial<SorobanSimulationResult> = {},
): SorobanSimulationResult {
  return {
    success: true,
    minResourceFee: '100000',
    cost: { cpuInstructions: 200_000, memoryBytes: 4096 },
    footprint: { readOnly: [], readWrite: [] },
    events: [],
    ...overrides,
  } as SorobanSimulationResult;
}

function buildClient(
  implementation: () => Promise<SorobanSimulationResult>,
): SorobanClient {
  return { simulateTransaction: vi.fn(implementation) };
}

describe('GasEstimationService', () => {
  let client: SorobanClient;
  let service: GasEstimationService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = buildClient(async () => buildSimulation());
    service = new GasEstimationService(client, buildConfig());
  });

  describe('safety buffer', () => {
    it('applies the configured buffer to both the fee and the gas limit', async () => {
      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate).toEqual({
        fee: '125000',
        gasLimit: 250_000,
        source: 'simulated',
        capped: false,
        safetyBufferPercent: 25,
      });
    });

    it('honours a per-call buffer override', async () => {
      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        safetyBufferPercent: 10,
      });

      expect(estimate.fee).toBe('110000');
      expect(estimate.gasLimit).toBe(220_000);
      expect(estimate.safetyBufferPercent).toBe(10);
    });

    it('leaves estimates untouched when the buffer is zero', async () => {
      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        safetyBufferPercent: 0,
      });

      expect(estimate.fee).toBe('100000');
      expect(estimate.gasLimit).toBe(200_000);
      expect(estimate.safetyBufferPercent).toBe(0);
    });

    it('rounds buffered stroops up so the limit is never below the estimate', async () => {
      client = buildClient(async () =>
        buildSimulation({ minResourceFee: '7', cost: { cpuInstructions: 3, memoryBytes: 0 } }),
      );
      service = new GasEstimationService(client, buildConfig({ gasSafetyBufferPercent: 15 }));

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.fee).toBe('9'); // ceil(7 * 1.15) = 9
      expect(estimate.gasLimit).toBe(4); // ceil(3 * 1.15) = 4
    });

    it('clamps an oversized buffer override at 100%', async () => {
      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        safetyBufferPercent: 5000,
      });

      expect(estimate.safetyBufferPercent).toBe(100);
      expect(estimate.gasLimit).toBe(400_000);
    });
  });

  describe('network block gas limit', () => {
    it('caps the buffered gas limit at the configured block limit', async () => {
      service = new GasEstimationService(client, buildConfig({ maxGasLimit: 210_000 }));

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.gasLimit).toBe(210_000);
      expect(estimate.capped).toBe(true);
      // The fee is not a gas limit; it keeps the buffered value.
      expect(estimate.fee).toBe('125000');
    });

    it('does not flag capping when the estimate fits under the block limit', async () => {
      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.capped).toBe(false);
    });

    it('tightens the block limit with a caller-supplied gas limit', async () => {
      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        gasLimit: 150_000,
      });

      expect(estimate.gasLimit).toBe(150_000);
      expect(estimate.capped).toBe(true);
    });

    it('never lets a caller-supplied limit exceed the network block limit', async () => {
      service = new GasEstimationService(client, buildConfig({ maxGasLimit: 300_000 }));

      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        gasLimit: 900_000_000,
      });

      expect(estimate.gasLimit).toBe(250_000);
      expect(estimate.capped).toBe(false);
    });

    it('ignores a non-positive caller-supplied gas limit', async () => {
      const estimate = await service.estimate({
        transactionXdr: 'AAAA',
        gasLimit: 0,
      });

      expect(estimate.gasLimit).toBe(250_000);
    });
  });

  describe('static fallback', () => {
    it('falls back when the provider rejects the call', async () => {
      client = buildClient(async () => {
        throw Object.assign(new Error('Soroban RPC unavailable'), { code: 'ECONNREFUSED' });
      });
      service = new GasEstimationService(client, buildConfig());

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate).toEqual({
        fee: '125000',
        gasLimit: 1_250_000,
        source: 'fallback',
        capped: false,
        safetyBufferPercent: 25,
      });
    });

    it('falls back when the provider returns no result', async () => {
      client = buildClient(async () => null as unknown as SorobanSimulationResult);
      service = new GasEstimationService(client, buildConfig());

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.source).toBe('fallback');
      expect(estimate.gasLimit).toBe(1_250_000);
    });

    it('falls back when the provider returns a null gas estimate', async () => {
      client = buildClient(async () =>
        buildSimulation({ cost: { cpuInstructions: null as unknown as number, memoryBytes: 0 } }),
      );
      service = new GasEstimationService(client, buildConfig());

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.source).toBe('fallback');
      expect(estimate.gasLimit).toBe(1_250_000);
      expect(estimate.fee).toBe('125000');
    });

    it('falls back when the simulation reports an error', async () => {
      client = buildClient(async () =>
        buildSimulation({ success: false, error: { code: 'txFailed', message: 'boom' } }),
      );
      service = new GasEstimationService(client, buildConfig());

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.source).toBe('fallback');
      expect(estimate.gasLimit).toBe(1_250_000);
    });

    it('falls back when the fee estimate is missing or malformed', async () => {
      for (const minResourceFee of [undefined, '', 'not-a-number', '-5']) {
        client = buildClient(async () =>
          buildSimulation({ minResourceFee: minResourceFee as unknown as string }),
        );
        service = new GasEstimationService(client, buildConfig());

        const estimate = await service.estimate({ transactionXdr: 'AAAA' });

        expect(estimate.source).toBe('fallback');
      }
    });

    it('caps the buffered fallback gas limit at the block limit', async () => {
      client = buildClient(async () => {
        throw new Error('timeout');
      });
      service = new GasEstimationService(client, buildConfig({ maxGasLimit: 500_000 }));

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.gasLimit).toBe(500_000);
      expect(estimate.capped).toBe(true);
      expect(estimate.source).toBe('fallback');
    });

    it('applies the safety buffer to the static fallback limits', async () => {
      client = buildClient(async () => {
        throw new Error('timeout');
      });
      service = new GasEstimationService(client, buildConfig({ gasSafetyBufferPercent: 50 }));

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.fee).toBe('150000');
      expect(estimate.gasLimit).toBe(1_500_000);
    });

    it('falls back to defaults when the stellar config slice is absent', async () => {
      client = buildClient(async () => {
        throw new Error('timeout');
      });
      service = new GasEstimationService(client, {
        get: vi.fn().mockReturnValue(undefined),
      } as unknown as ConfigService);

      const estimate = await service.estimate({ transactionXdr: 'AAAA' });

      expect(estimate.fee).toBe('125000');
      expect(estimate.gasLimit).toBe(1_250_000);
      expect(estimate.safetyBufferPercent).toBe(25);
    });
  });

  describe('fromSimulation', () => {
    it('transforms an existing simulation result without calling the provider', () => {
      const estimate = service.fromSimulation(buildSimulation());

      expect(estimate.fee).toBe('125000');
      expect(estimate.gasLimit).toBe(250_000);
      expect(client.simulateTransaction).not.toHaveBeenCalled();
    });

    it('accepts numeric fee values returned by legacy providers', () => {
      const estimate = service.fromSimulation(
        buildSimulation({ minResourceFee: 80_000 as unknown as string }),
      );

      expect(estimate.fee).toBe('100000');
    });
  });
});
