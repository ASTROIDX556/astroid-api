import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { StellarConfig } from '../../../config/stellar.config';
import { CircuitBreaker, isRpcFailure } from '../../../common/circuit-breaker/circuit-breaker';

/** Consecutive failures before the gas-estimation circuit trips OPEN. */
const FAILURE_THRESHOLD = 5;
/** Time the circuit stays OPEN before a HALF_OPEN trial call. */
const RESET_TIMEOUT_MS = 30_000;

/** Upper bound for an override buffer: a 100% buffer at most doubles the estimate. */
const MAX_SAFETY_BUFFER_PERCENT = 100;

const DEFAULT_SAFETY_BUFFER_PERCENT = 25;
/** Soroban's per-transaction CPU instruction ceiling. */
const DEFAULT_MAX_GAS_LIMIT = 100_000_000;
const DEFAULT_FALLBACK_GAS_LIMIT = 1_000_000;
const DEFAULT_FALLBACK_FEE_STROOPS = 100_000;

export interface GasEstimationOptions {
  /** Per-call override for the configured safety buffer (0–100). */
  safetyBufferPercent?: number;
  /** Per-call gas ceiling, e.g. a limit supplied by the caller. */
  gasLimit?: number;
}

export interface GasEstimationInput extends GasEstimationOptions {
  /** Base64-encoded transaction envelope to simulate. */
  transactionXdr: string;
}

export interface GasEstimate {
  /** Fee limit in stroops, buffered and ready to attach to the transaction. */
  fee: string;
  /** CPU instruction limit (Soroban's gas), buffered and capped. */
  gasLimit: number;
  /** Whether the estimate came from simulation or the static fallback. */
  source: 'simulated' | 'fallback';
  /** Whether the network block gas limit lowered the estimate. */
  capped: boolean;
  /** Buffer percentage that was applied to the raw estimate. */
  safetyBufferPercent: number;
}

interface GasSettings {
  safetyBufferPercent: number;
  maxGasLimit: number;
  fallbackGasLimit: number;
  fallbackFeeStroops: number;
}

/**
 * Estimates the gas (fee limit + CPU instruction limit) for a Soroban
 * transaction under congested network conditions.
 *
 * Every estimate is:
 *   1. multiplied by a configurable safety buffer, so a simulation that slightly
 *      underestimates real usage does not revert with out-of-gas;
 *   2. capped at the network block gas limit, so a runaway estimate is never
 *      accepted by the network;
 *   3. replaced by static fallback limits when the provider throws, returns no
 *      result, or omits the simulated gas estimate.
 */
@Injectable()
export class GasEstimationService {
  private readonly logger = new Logger(GasEstimationService.name);
  private readonly breaker = new CircuitBreaker({
    name: 'gas-estimation',
    failureThreshold: FAILURE_THRESHOLD,
    resetTimeoutMs: RESET_TIMEOUT_MS,
    isFailure: isRpcFailure,
  });
  private readonly settings: GasSettings;

  constructor(
    @Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient,
    config: ConfigService,
  ) {
    this.settings = readGasSettings(config);
  }

  /**
   * Simulates `transactionXdr` and returns a buffered, capped gas estimate.
   * Provider failures never propagate: the static fallback limits are used
   * instead, keeping transaction preparation available during RPC outages.
   */
  async estimate(input: GasEstimationInput): Promise<GasEstimate> {
    try {
      const result = await this.breaker.execute(() =>
        this.sorobanClient.simulateTransaction({
          transactionXdr: input.transactionXdr,
        }),
      );

      const estimate = this.fromSimulation(result, input);
      if (estimate.source === 'fallback') {
        this.logger.warn(
          'Gas simulation returned no usable estimate; using static fallback limits',
        );
      }
      return estimate;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Gas estimation failed (${message}); using static fallback limits`,
      );
      return this.fallback(input);
    }
  }

  /**
   * Applies the safety buffer and block cap to an already-obtained simulation
   * result. Falls back to the static limits when the result is missing, reports
   * a failure, or does not contain a usable fee/gas estimate.
   */
  fromSimulation(
    result: SorobanSimulationResult | null | undefined,
    options: GasEstimationOptions = {},
  ): GasEstimate {
    const safetyBufferPercent = this.resolveBuffer(options.safetyBufferPercent);
    const blockLimit = this.resolveBlockLimit(options.gasLimit);
    const simulated = readSimulatedEstimate(result);

    if (!simulated) {
      return this.buildFallback(safetyBufferPercent, blockLimit);
    }

    const bufferedGas = applySafetyBuffer(simulated.gasLimit, safetyBufferPercent);
    return {
      fee: String(applySafetyBuffer(simulated.fee, safetyBufferPercent)),
      gasLimit: Math.min(bufferedGas, blockLimit),
      source: 'simulated',
      capped: bufferedGas > blockLimit,
      safetyBufferPercent,
    };
  }

  /** Static limits for when dynamic estimation is unavailable. */
  private fallback(options: GasEstimationOptions): GasEstimate {
    return this.buildFallback(
      this.resolveBuffer(options.safetyBufferPercent),
      this.resolveBlockLimit(options.gasLimit),
    );
  }

  private buildFallback(safetyBufferPercent: number, blockLimit: number): GasEstimate {
    const bufferedGas = applySafetyBuffer(
      this.settings.fallbackGasLimit,
      safetyBufferPercent,
    );
    return {
      fee: String(applySafetyBuffer(this.settings.fallbackFeeStroops, safetyBufferPercent)),
      gasLimit: Math.min(bufferedGas, blockLimit),
      source: 'fallback',
      capped: bufferedGas > blockLimit,
      safetyBufferPercent,
    };
  }

  private resolveBuffer(override?: number): number {
    const value = override ?? this.settings.safetyBufferPercent;
    if (!Number.isFinite(value) || value < 0) {
      return this.settings.safetyBufferPercent;
    }
    return Math.min(Math.floor(value), MAX_SAFETY_BUFFER_PERCENT);
  }

  private resolveBlockLimit(override?: number): number {
    const configured = this.settings.maxGasLimit;
    if (override === undefined || !Number.isFinite(override) || override <= 0) {
      return configured;
    }
    // A caller-provided limit may only tighten the network ceiling, never raise it.
    return Math.min(configured, Math.floor(override));
  }
}

function readGasSettings(config: ConfigService): GasSettings {
  const stellar = config.get<Partial<StellarConfig>>('stellar');
  return {
    safetyBufferPercent: positiveOr(
      stellar?.gasSafetyBufferPercent,
      DEFAULT_SAFETY_BUFFER_PERCENT,
      0,
    ),
    maxGasLimit: positiveOr(stellar?.maxGasLimit, DEFAULT_MAX_GAS_LIMIT),
    fallbackGasLimit: positiveOr(stellar?.fallbackGasLimit, DEFAULT_FALLBACK_GAS_LIMIT),
    fallbackFeeStroops: positiveOr(
      stellar?.fallbackFeeStroops,
      DEFAULT_FALLBACK_FEE_STROOPS,
      0,
    ),
  };
}

function positiveOr(value: number | undefined, fallback: number, minimum = 1): number {
  return Number.isFinite(value) && (value as number) >= minimum && (value as number) > 0
    ? Math.floor(value as number)
    : fallback;
}

/** Extracts the fee (stroops) and gas (CPU instructions) from a simulation. */
function readSimulatedEstimate(
  result: SorobanSimulationResult | null | undefined,
): { fee: number; gasLimit: number } | null {
  if (!result || result.success !== true || result.error) {
    return null;
  }

  const fee = toNonNegativeInteger(result.minResourceFee);
  const gasLimit = toNonNegativeInteger(result.cost?.cpuInstructions);
  if (fee === null || gasLimit === null || gasLimit === 0) {
    return null;
  }
  return { fee, gasLimit };
}

/** Accepts the string (or legacy numeric) forms returned by Soroban providers. */
function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Rounds up so a buffered limit is never truncated below the raw estimate.
 * Integer math avoids float drift on values like 100000 * 1.1.
 */
function applySafetyBuffer(value: number, percent: number): number {
  if (percent <= 0) {
    return value;
  }
  const scaled = value * (100 + percent);
  if (!Number.isSafeInteger(scaled)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.ceil(scaled / 100);
}
