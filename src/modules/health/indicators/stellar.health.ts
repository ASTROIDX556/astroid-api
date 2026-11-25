import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../../config/stellar.config';

export interface EndpointHealthStatus {
  status: 'up' | 'down' | 'degraded';
  latencyMs: number;
  url: string;
  ledgerSequence?: number;
  protocolVersion?: number;
  error?: string;
}

export interface StellarHealthReport {
  status: 'up' | 'down' | 'degraded';
  timestamp: string;
  network: string;
  horizon: EndpointHealthStatus;
  sorobanRpc: EndpointHealthStatus;
}

/** The subset of Horizon's root document this indicator reads. */
interface HorizonRoot {
  history_latest_ledger?: number;
  core_latest_ledger?: number;
  protocol_version?: number;
}

/** The subset of a Soroban RPC `getHealth` response this indicator reads. */
interface SorobanHealthResponse {
  result?: { status?: string; latestLedger?: number };
}

@Injectable()
export class StellarHealthIndicator {
  private readonly logger = new Logger(StellarHealthIndicator.name);

  /** Ceiling on a single endpoint probe, in ms. */
  static readonly DEFAULT_TIMEOUT_MS = 2_000;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Probes Horizon and the Soroban RPC in parallel.
   *
   * Every probe is bounded by `timeoutMs`: the request is aborted when the
   * budget is spent, so an unresponsive node can never stall the event loop
   * or the health endpoint. An endpoint that answers but needs more than half
   * of the budget is reported as `degraded` rather than `up`.
   */
  async checkHealth(
    timeoutMs: number = StellarHealthIndicator.DEFAULT_TIMEOUT_MS,
  ): Promise<StellarHealthReport> {
    const stellar = this.configService.getOrThrow<StellarConfig>('stellar');
    const budget = this.resolveTimeout(timeoutMs);

    const [horizonHealth, sorobanHealth] = await Promise.all([
      this.checkHorizonEndpoint(stellar.horizonUrl, budget),
      this.checkSorobanRpcEndpoint(stellar.sorobanRpcUrl, budget),
    ]);

    let overallStatus: 'up' | 'down' | 'degraded' = 'up';
    if (horizonHealth.status === 'down' || sorobanHealth.status === 'down') {
      overallStatus = 'down';
    } else if (
      horizonHealth.status === 'degraded' ||
      sorobanHealth.status === 'degraded'
    ) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      network: stellar.network,
      horizon: horizonHealth,
      sorobanRpc: sorobanHealth,
    };
  }

  async checkHorizonEndpoint(
    url: string,
    timeoutMs: number = StellarHealthIndicator.DEFAULT_TIMEOUT_MS,
  ): Promise<EndpointHealthStatus> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          status: 'degraded',
          latencyMs,
          url,
          error: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      const data = (await response.json()) as HorizonRoot;
      const status: 'up' | 'degraded' =
        latencyMs > this.degradedLatencyThreshold(timeoutMs) ? 'degraded' : 'up';

      return {
        status,
        latencyMs,
        url,
        ledgerSequence: data.history_latest_ledger || data.core_latest_ledger || undefined,
        protocolVersion: data.protocol_version || undefined,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Horizon health check failed for ${url}: ${message}`);
      return {
        status: 'down',
        latencyMs,
        url,
        error: message || 'Connection failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkSorobanRpcEndpoint(
    url: string,
    timeoutMs: number = StellarHealthIndicator.DEFAULT_TIMEOUT_MS,
  ): Promise<EndpointHealthStatus> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
        }),
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          status: 'degraded',
          latencyMs,
          url,
          error: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      const data = (await response.json()) as SorobanHealthResponse;
      const status: 'up' | 'degraded' =
        latencyMs > this.degradedLatencyThreshold(timeoutMs) || data.result?.status !== 'healthy'
          ? 'degraded'
          : 'up';

      return {
        status,
        latencyMs,
        url,
        ledgerSequence: data.result?.latestLedger || undefined,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Soroban RPC health check failed for ${url}: ${message}`);
      return {
        status: 'down',
        latencyMs,
        url,
        error: message || 'Connection failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A non-positive timeout would disable the budget, so the default is used. */
  private resolveTimeout(timeoutMs: number): number {
    return Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : StellarHealthIndicator.DEFAULT_TIMEOUT_MS;
  }

  /**
   * Latency above which an endpoint that still answered is reported as
   * `degraded`: it used more than half of the probe budget.
   */
  private degradedLatencyThreshold(timeoutMs: number): number {
    return this.resolveTimeout(timeoutMs) / 2;
  }
}
