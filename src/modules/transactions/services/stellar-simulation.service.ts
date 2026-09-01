import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
  STELLAR_CLIENT,
  StellarClient,
} from '../../../integrations/stellar';
import {
  ClassicPreFlightSummary,
  StellarSimulationReport,
  StellarSimulationRequest,
} from './stellar-simulation.dto';
import { ErrorCode } from '../../../common/constants/error-codes';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { CircuitBreaker, isRpcFailure } from '../../../common/circuit-breaker/circuit-breaker';

/** Consecutive failures before the simulation circuit trips OPEN. */
const SIMULATION_FAILURE_THRESHOLD = 5;
/** Time the simulation circuit stays OPEN before a HALF_OPEN trial call. */
const SIMULATION_RESET_TIMEOUT_MS = 30_000;
/** Default maximum acceptable resource fee in stroops (~200x base fee). */
const DEFAULT_MAX_FEE_STROOPS = 200_000;
/** Base native (XLM) network fee in stroops used for classic payment estimates. */
const BASE_FEE_STROOPS = 100;

/**
 * Pre-flight transaction simulation for Stellar and Soroban.
 *
 * Evaluates a transaction before submission to protect autonomous agents from
 * submitting failing transactions that would waste fees or violate smart
 * contract constraints. Two modes are supported:
 *
 *   1. Soroban / contract simulation — a base64 `transactionXdr` is run through
 *      the Soroban RPC `simulateTransaction` endpoint to recover the estimated
 *      resource fee, execution cost, ledger footprint and emitted events.
 *   2. Classic payment pre-flight — for a plain payment (source, destination,
 *      amount, asset) the source account's native balance and the fee bound are
 *      assessed without consuming any network resources.
 *
 * Both paths produce a structured {@link StellarSimulationReport} carrying a
 * success probability, fee estimate, fee-bound check, warnings and any hard
 * failure reasons. Network errors and timeouts are handled by an internal
 * circuit breaker whose fallback returns a degraded (but structured) report so
 * callers never observe a hard failure when only the RPC is temporarily down.
 */
@Injectable()
export class StellarSimulationService {
  private readonly logger = new Logger(StellarSimulationService.name);
  private readonly breaker = new CircuitBreaker({
    name: 'stellar-simulation',
    failureThreshold: SIMULATION_FAILURE_THRESHOLD,
    resetTimeoutMs: SIMULATION_RESET_TIMEOUT_MS,
    isFailure: isRpcFailure,
  });

  constructor(
    @Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient,
    @Inject(STELLAR_CLIENT) private readonly stellarClient: StellarClient,
  ) {}

  /**
   * Runs a pre-flight simulation and returns a structured validation report.
   *
   * Never throws for a failed network simulation — it degrades into a fallback
   * report. Throws only when the request itself is malformed or the XDR is
   * invalid (client errors the caller must fix).
   */
  async preflight(input: StellarSimulationRequest): Promise<StellarSimulationReport> {
    const maxFeeStroops = input.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;

    if (input.transactionXdr) {
      return this.simulateContract(input, maxFeeStroops);
    }

    const hasPaymentParams =
      Boolean(input.source) && Boolean(input.destination) && Boolean(input.amount);
    if (!hasPaymentParams) {
      throw new DomainException(
        ErrorCode.VALIDATION_ERROR,
        'Provide either a transactionXdr (Soroban simulation) or source, destination and amount (classic payment pre-flight)',
      );
    }

    return this.preflightClassicPayment(input, maxFeeStroops);
  }

  // ── Soroban / contract simulation ───────────────────────────────────────

  private async simulateContract(
    input: StellarSimulationRequest,
    maxFeeStroops: number,
  ): Promise<StellarSimulationReport> {
    this.validateXdr(input.transactionXdr!);

    let result: SorobanSimulationResult;
    try {
      result = await this.breaker.execute(() =>
        this.sorobanClient.simulateTransaction({
          transactionXdr: input.transactionXdr!,
        }),
      );
    } catch (error) {
      if (error instanceof DomainException) {
        return this.buildFallbackReport(maxFeeStroops, (error as DomainException).message);
      }
      this.logger.warn(`Soroban simulation failed: ${(error as Error).message}`);
      return this.buildFallbackReport(maxFeeStroops, (error as Error).message);
    }

    if (!result.success) {
      return this.buildFailureReport(
        maxFeeStroops,
        `Simulation failed: ${result.error?.message ?? 'Unknown contract error'}`,
      );
    }

    const feeStroops = this.parseStroops(result.minResourceFee ?? '0', maxFeeStroops);
    const feeWithinBound = feeStroops <= maxFeeStroops;

    const warnings: string[] = [];
    if (!feeWithinBound) {
      warnings.push(
        `Estimated resource fee ${feeStroops} stroops exceeds the maximum bound of ${maxFeeStroops}`,
      );
    }
    if (result.footprint.readWrite.length > 0) {
      warnings.push(
        `Simulation writes to ${result.footprint.readWrite.length} ledger keys`,
      );
    }

    const cost = result.cost ?? { cpuInstructions: 0, memoryBytes: 0 };
    const failureReasons: string[] = [];
    if (!feeWithinBound) {
      failureReasons.push('fee exceedance');
    }

    return {
      isSafeToSubmit: feeWithinBound && failureReasons.length === 0,
      successProbability: this.computeConfidence(true, feeWithinBound, result.events.length),
      feeEstimateStroops: String(feeStroops),
      feeWithinBound,
      confidence: this.computeConfidence(true, feeWithinBound, result.events.length),
      cost,
      footprint: result.footprint,
      events: result.events,
      warnings,
      failureReasons,
      isFallback: false,
      transactionHash: result.transactionHash,
      maxFeeStroops,
    };
  }

  // ── Classic payment pre-flight ──────────────────────────────────────────

  private async preflightClassicPayment(
    input: StellarSimulationRequest,
    maxFeeStroops: number,
  ): Promise<StellarSimulationReport> {
    const summary = await this.checkAccountHealth(
      input.source!,
      input.network,
      input.amount!,
      maxFeeStroops,
    );

    const feeStroops = BASE_FEE_STROOPS;
    const feeWithinBound = feeStroops <= maxFeeStroops;

    const warnings: string[] = [];
    const failureReasons: string[] = [];

    let balanceConfirmedSufficient = true;
    if (!summary.accountExists) {
      failureReasons.push(`Source account ${input.source} does not exist on ${input.network}`);
    }
    if (summary.sufficientForFeeAndAmount === false) {
      warnings.push(
        `Source account native balance may be insufficient to cover the payment plus fee`,
      );
      balanceConfirmedSufficient = false;
    }
    if (summary.sufficientForFeeAndAmount === undefined) {
      warnings.push(`Unable to confirm source account balance (network returned no result)`);
      balanceConfirmedSufficient = false;
    }
    if (!feeWithinBound) {
      warnings.push(
        `Base fee ${feeStroops} stroops exceeds the maximum bound of ${maxFeeStroops}`,
      );
    }

    return {
      isSafeToSubmit:
        summary.accountExists &&
        balanceConfirmedSufficient &&
        failureReasons.length === 0 &&
        feeWithinBound,
      successProbability: this.computeConfidence(
        summary.accountExists,
        feeWithinBound,
        balanceConfirmedSufficient ? 1 : 0,
      ),
      feeEstimateStroops: String(feeStroops),
      feeWithinBound,
      confidence: this.computeConfidence(
        summary.accountExists,
        feeWithinBound,
        balanceConfirmedSufficient ? 1 : 0,
      ),
      warnings,
      failureReasons,
      isFallback: false,
      maxFeeStroops,
    };
  }

  private async checkAccountHealth(
    source: string,
    network: StellarSimulationRequest['network'],
    amount: string,
    maxFeeStroops: number,
  ): Promise<ClassicPreFlightSummary> {
    const accountExists = this.stellarClient.isValidAddress(source);
    let nativeBalance: string | undefined;

    if (accountExists) {
      try {
        nativeBalance = await this.breaker.execute(() =>
          this.stellarClient.getNativeBalance(source, network ?? 'testnet'),
        );
      } catch (error) {
        this.logger.warn(
          `Failed to fetch native balance for ${source}: ${(error as Error).message}`,
        );
      }
    }

    const balanceStroops = this.parseStroops(nativeBalance ?? '0', maxFeeStroops);
    const amountStroops = this.parseStroops(amount, maxFeeStroops);
    const sufficient =
      nativeBalance === undefined
        ? undefined
        : balanceStroops >= amountStroops + BASE_FEE_STROOPS;

    return {
      accountExists,
      nativeBalanceStroops: nativeBalance,
      sufficientForFeeAndAmount: sufficient,
    };
  }

  // ── Fallback / degraded reports ─────────────────────────────────────────

  private buildFallbackReport(maxFeeStroops: number, reason: string): StellarSimulationReport {
    return {
      isSafeToSubmit: false,
      successProbability: 0,
      feeEstimateStroops: '0',
      feeWithinBound: true,
      confidence: 0,
      warnings: ['Pre-flight simulation unavailable; falling back to degraded report'],
      failureReasons: [`simulation unavailable: ${reason}`],
      isFallback: true,
      maxFeeStroops,
    };
  }

  private buildFailureReport(maxFeeStroops: number, reason: string): StellarSimulationReport {
    return {
      isSafeToSubmit: false,
      successProbability: 0,
      feeEstimateStroops: '0',
      feeWithinBound: false,
      confidence: 0,
      warnings: [],
      failureReasons: [reason],
      isFallback: false,
      maxFeeStroops,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private computeConfidence(
    simulationSucceeded: boolean,
    feeWithinBound: boolean,
    eventIndicator: number,
  ): number {
    let confidence = 50;
    if (simulationSucceeded) confidence += 30;
    if (feeWithinBound) confidence += 10;
    confidence += Math.min(eventIndicator > 0 ? 10 : 0, 10);
    return Math.max(0, Math.min(100, confidence));
  }

  private parseStroops(value: string, maxFeeStroops: number): number {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return maxFeeStroops + 1;
    }
    return parsed;
  }

  private validateXdr(xdr: string): void {
    if (!xdr || typeof xdr !== 'string') {
      throw new DomainException(
        ErrorCode.VALIDATION_ERROR,
        'Transaction XDR is required',
      );
    }
    // Validate base64url/base64 format
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(xdr)) {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_TRANSACTION,
        'Transaction XDR is not valid base64',
      );
    }
    try {
      Buffer.from(xdr, 'base64');
    } catch {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_TRANSACTION,
        'Transaction XDR is not valid base64',
      );
    }
  }
}
