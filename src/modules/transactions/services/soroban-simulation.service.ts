import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SOROBAN_CLIENT,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { RiskEngine } from '../../risk/risk.engine';
import { RiskAssessment, RiskFactorsInput } from '../../risk/risk.types';
import { ErrorCode } from '../../../common/constants/error-codes';
import {
  DomainException,
  RiskTooHighException,
} from '../../../common/exceptions/domain.exception';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';

export interface SimulationInput {
  /** The base64-encoded transaction envelope XDR. */
  transactionXdr: string;
  /** Organization ID for risk context. */
  organizationId: string;
  /** Optional actor ID for audit context. */
  actorId?: string;
  /** Optional risk factors for scoring (if not provided, uses defaults). */
  riskFactors?: RiskFactorsInput;
  /** Maximum allowed risk score before simulation is rejected. */
  maxRiskScore?: number;
}

export interface SimulationOutput {
  /** Whether the simulation succeeded. */
  success: boolean;
  /** Fee estimate in stroops. */
  feeEstimate: string;
  /** Resource cost analysis. */
  cost: {
    cpuInstructions: number;
    memoryBytes: number;
  };
  /** Footprint data from the simulation. */
  footprint: SorobanSimulationResult['footprint'];
  /** Events emitted during simulation. */
  events: SorobanSimulationResult['events'];
  /** Risk assessment of the simulated transaction. */
  risk: RiskAssessment;
  /** Whether the transaction requires approval based on risk. */
  requiresApproval: boolean;
  /** Error details if simulation failed. */
  error?: SorobanSimulationResult['error'];
  /** Transaction hash from simulation. */
  transactionHash?: string;
}

/**
 * Executes Soroban transaction simulations with integrated risk scoring.
 *
 * Pipeline:
 *   1. Validate the transaction XDR
 *   2. Delegate to the Soroban RPC client for simulation
 *   3. Extract footprint, fee, and event data
 *   4. Run risk scoring heuristics against the simulation result
 *   5. Flag anomalous or high-risk calls before queueing for broadcast
 *
 * @throws DomainException if the simulation fails or risk score exceeds thresholds.
 */
@Injectable()
export class SorobanSimulationService {
  private readonly logger = new Logger(SorobanSimulationService.name);

  constructor(
    @Inject(SOROBAN_CLIENT) private readonly sorobanClient: SorobanClient,
    private readonly riskEngine: RiskEngine,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Simulates a Soroban transaction and evaluates its risk profile.
   *
   * @throws DomainException if the XDR is invalid or simulation fails
   * @throws RiskTooHighException if the risk score exceeds the allowed threshold
   */
  async simulate(input: SimulationInput): Promise<SimulationOutput> {
    this.validateXdr(input.transactionXdr);

    let result: SorobanSimulationResult;
    try {
      result = await this.sorobanClient.simulateTransaction({
        transactionXdr: input.transactionXdr,
      });
    } catch (error) {
      this.logger.warn(
        `Soroban simulation failed: ${(error as Error).message}`,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Soroban simulation failed: ${(error as Error).message}`,
      );
    }

    if (!result.success) {
      this.logger.warn(
        `Soroban simulation returned error: ${result.error?.code} - ${result.error?.message}`,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Soroban simulation failed: ${result.error?.message ?? 'Unknown error'}`,
        result.error,
      );
    }

    // Risk scoring
    const riskInput = input.riskFactors ?? this.buildDefaultRiskFactors(result);
    const risk = this.riskEngine.assess(riskInput);
    const maxRiskScore = input.maxRiskScore ?? 80;
    const requiresApproval = risk.score > 20 || risk.band !== 'LOW';

    if (risk.score > maxRiskScore) {
      throw new RiskTooHighException(
        `Risk score ${risk.score} exceeds maximum allowed threshold of ${maxRiskScore}`,
        { score: risk.score, band: risk.band, maxRiskScore },
      );
    }

    // Emit simulation event for telemetry
    await this.eventBus.emit(
      DomainEventName.RiskEvaluated,
      {
        score: risk.score,
        band: risk.band,
        simulationSuccess: true,
        feeEstimate: result.minResourceFee,
        transactionHash: result.transactionHash,
      },
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        aggregateType: 'transaction',
      },
    );

    return {
      success: true,
      feeEstimate: result.minResourceFee,
      cost: result.cost,
      footprint: result.footprint,
      events: result.events,
      risk,
      requiresApproval,
      transactionHash: result.transactionHash,
    };
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

  private buildDefaultRiskFactors(result: SorobanSimulationResult): RiskFactorsInput {
    // Build risk factors from simulation result when not explicitly provided
    const eventCount = result.events.length;
    const hasWriteFootprint = result.footprint.readWrite.length > 0;
    const feeStroops = parseInt(result.minResourceFee, 10);

    // Heuristic: higher resource usage correlates with higher risk
    const normalizedFee = Math.min(feeStroops / 10_000_000, 1);
    const amountEstimate = normalizedFee * 10_000;

    return {
      amount: amountEstimate,
      asset: 'XLM',
      knownRecipient: !hasWriteFootprint,
      recentTransactionCount: eventCount,
      walletAgeDays: 90,
      policyViolations: 0,
      hourUtc: new Date().getUTCHours(),
    };
  }
}
