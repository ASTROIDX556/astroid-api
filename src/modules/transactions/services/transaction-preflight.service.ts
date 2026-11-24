import { Inject, Injectable } from '@nestjs/common';
import {
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import {
  SorobanRequestRejectedException,
  SorobanUnavailableException,
} from '../../../integrations/stellar/soroban.client';

export interface TransactionFootprintSummary {
  readOnlyCount: number;
  readWriteCount: number;
}

export type TransactionPreflightResult =
  | {
      kind: 'ok';
      simulatedAt: Date;
      minResourceFee: string;
      footprintSummary: TransactionFootprintSummary;
    }
  | {
      kind: 'retryable_error';
      code: string;
      message: string;
      error: Error;
    }
  | {
      kind: 'terminal_error';
      code: string;
      message: string;
      simulatedAt: Date;
    };

const MAX_SIMULATION_ATTEMPTS = 2;

/** Performs a bounded, typed Soroban preflight for a transaction envelope. */
@Injectable()
export class TransactionPreflightService {
  constructor(@Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient) {}

  async simulate(transactionXdr: string): Promise<TransactionPreflightResult> {
    for (let attempt = 1; attempt <= MAX_SIMULATION_ATTEMPTS; attempt += 1) {
      let simulation: SorobanSimulationResult;
      try {
        simulation = await this.sorobanClient.simulateTransaction({ transactionXdr });
      } catch (error) {
        return this.toErrorResult(error);
      }

      if (!simulation.success || simulation.error) {
        return {
          kind: 'terminal_error',
          code: simulation.error?.code || 'SIMULATION_FAILED',
          message: simulation.error?.message || 'Soroban simulation failed without error details',
          simulatedAt: new Date(),
        };
      }

      if (!isValidFee(simulation.minResourceFee)) {
        return {
          kind: 'terminal_error',
          code: 'INVALID_SIMULATION_RESULT',
          message: 'Soroban simulation returned an invalid minimum resource fee',
          simulatedAt: new Date(),
        };
      }
      if (
        typeof simulation.latestLedger !== 'number' ||
        !Number.isSafeInteger(simulation.latestLedger) ||
        simulation.latestLedger < 0
      ) {
        return {
          kind: 'terminal_error',
          code: 'INVALID_SIMULATION_RESULT',
          message: 'Soroban simulation did not return a valid latest ledger',
          simulatedAt: new Date(),
        };
      }
      if (!this.sorobanClient.getLatestLedger) {
        return {
          kind: 'terminal_error',
          code: 'STALE_CHECK_UNAVAILABLE',
          message: 'Soroban client cannot verify whether the simulation is stale',
          simulatedAt: new Date(),
        };
      }

      let currentLedger: number;
      try {
        currentLedger = await this.sorobanClient.getLatestLedger();
      } catch (error) {
        return this.toErrorResult(error);
      }
      if (!Number.isSafeInteger(currentLedger) || currentLedger < 0) {
        return {
          kind: 'terminal_error',
          code: 'INVALID_LATEST_LEDGER',
          message: 'Soroban RPC returned an invalid latest ledger sequence',
          simulatedAt: new Date(),
        };
      }

      if (simulation.latestLedger < currentLedger) {
        if (attempt < MAX_SIMULATION_ATTEMPTS) continue;
        return {
          kind: 'terminal_error',
          code: 'SIMULATION_STALE',
          message:
            `Soroban simulation ledger ${simulation.latestLedger} is older than ` +
            `the current ledger ${currentLedger} after one re-simulation`,
          simulatedAt: new Date(),
        };
      }

      return {
        kind: 'ok',
        simulatedAt: new Date(),
        minResourceFee: simulation.minResourceFee,
        footprintSummary: {
          readOnlyCount: simulation.footprint.readOnly.length,
          readWriteCount: simulation.footprint.readWrite.length,
        },
      };
    }

    throw new Error('Transaction preflight exceeded its bounded simulation attempts');
  }

  private toErrorResult(error: unknown): TransactionPreflightResult {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SorobanUnavailableException) {
      return {
        kind: 'retryable_error',
        code: error.code,
        message,
        error,
      };
    }

    if (error instanceof SorobanRequestRejectedException) {
      const rpcCode = error.details.rpcCode;
      return {
        kind: 'terminal_error',
        code: rpcCode === undefined ? error.code : String(rpcCode),
        message,
        simulatedAt: new Date(),
      };
    }

    const code = getErrorCode(error);
    if (isRetryableTransportCode(code)) {
      const retryable = error instanceof Error ? error : new Error(message);
      return { kind: 'retryable_error', code: code!, message, error: retryable };
    }

    return {
      kind: 'terminal_error',
      code: code ?? 'SIMULATION_FAILED',
      message,
      simulatedAt: new Date(),
    };
  }
}

function isValidFee(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && value.length <= 30;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isRetryableTransportCode(code: string | undefined): boolean {
  return (
    code === 'SOROBAN_UNAVAILABLE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH'
  );
}
