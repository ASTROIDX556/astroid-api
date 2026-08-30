import { Injectable, Logger } from '@nestjs/common';
import {
  SorobanClient,
  SorobanSimulationOptions,
  SorobanSimulationResult,
} from './soroban.interface';

/**
 * Deterministic mock Soroban RPC client for local development and testing.
 * Simulates successful transaction execution with realistic cost estimates.
 */
@Injectable()
export class MockSorobanClient implements SorobanClient {
  private readonly logger = new Logger(MockSorobanClient.name);

  private readonly defaultResult: SorobanSimulationResult = {
    success: true,
    minResourceFee: '100000',
    cost: {
      cpuInstructions: 200_000,
      memoryBytes: 4096,
    },
    footprint: {
      readOnly: [],
      readWrite: [],
    },
    events: [],
    result: undefined,
    transactionHash: undefined,
  };

  async simulateTransaction(options: SorobanSimulationOptions): Promise<SorobanSimulationResult> {
    this.logger.debug(`Mock Soroban simulation for XDR length: ${options.transactionXdr.length}`);

    // Decode XDR to extract basic info (mock always succeeds)
    try {
      const decoded = Buffer.from(options.transactionXdr, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;

      return {
        ...this.defaultResult,
        transactionHash: `mock-tx-${Date.now()}`,
        footprint: {
          readOnly: parsed.source
            ? [{ contractId: 'mock-contract-1', key: { symbol: 'Balance' } }]
            : [],
          readWrite: [],
        },
        events: [
          {
            type: 'contract',
            contractId: 'mock-contract-1',
            topic: ['transfer'],
            value: {
              from: parsed.source,
              to: parsed.destination,
              amount: parsed.amount,
            },
          },
        ],
      };
    } catch {
      return this.defaultResult;
    }
  }
}
