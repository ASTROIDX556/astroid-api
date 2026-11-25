import { Logger } from '@nestjs/common';
import type { HealthProbeConfig } from '../../config/health.config';

/** Why a dependency is reported down. Deliberately coarse: the probe is public. */
export type ReadinessFailureReason = 'timeout' | 'unavailable';

/** What a check function resolves with (the shape every health indicator already returns). */
export interface ReadinessCheckReport {
  status: string;
  timestamp?: string;
  latencyMs?: unknown;
  error?: unknown;
}

/**
 * One named dependency check. Add a Soroban RPC (or any future dependency) by
 * appending an entry to the list; the runner and controller do not change.
 */
export interface ReadinessCheck {
  name: string;
  /** Required checks decide the overall status. Defaults to `true`. */
  required?: boolean;
  /** Runs the check. Receives the timeout so the underlying client can honour it too. */
  run: (timeoutMs: number) => Promise<ReadinessCheckReport>;
}

/** Sanitised outcome of one check. Never carries a driver message. */
export interface ReadinessCheckOutcome {
  name: string;
  required: boolean;
  status: 'up' | 'down';
  latencyMs: number;
  timestamp: string;
  error?: ReadinessFailureReason;
}

export interface ReadinessReport {
  status: 'up' | 'down';
  checks: ReadinessCheckOutcome[];
}

/** Matches the messages the indicators produce when their own timeout fires. */
const TIMEOUT_MESSAGE = /timed out/i;

class ReadinessTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Readiness check "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

function withTimeout<T>(name: string, probe: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadinessTimeoutError(name, timeoutMs)), timeoutMs);
    probe.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Runs readiness checks in parallel, each bounded by a hard timeout, and reduces
 * the results to what a public probe may show. A check that throws, hangs or
 * reports `down` becomes `down`; the detail is logged server-side only.
 *
 * Optionally reuses a result for `readinessCacheTtlMs` (concurrent callers share
 * one in-flight run), so aggressive polling cannot hammer the dependencies.
 */
export class ReadinessRunner {
  private readonly logger = new Logger(ReadinessRunner.name);
  private cached: { key: string; expiresAt: number; result: Promise<ReadinessReport> } | null = null;

  constructor(private readonly config: HealthProbeConfig) {}

  run(checks: readonly ReadinessCheck[]): Promise<ReadinessReport> {
    const ttl = this.config.readinessCacheTtlMs;
    if (ttl <= 0) return this.execute(checks);

    const key = checks.map((check) => check.name).join(',');
    const now = Date.now();
    if (this.cached && this.cached.key === key && this.cached.expiresAt > now) {
      return this.cached.result;
    }

    const result = this.execute(checks);
    this.cached = { key, expiresAt: now + ttl, result };
    return result;
  }

  private async execute(checks: readonly ReadinessCheck[]): Promise<ReadinessReport> {
    const outcomes = await Promise.all(checks.map((check) => this.runOne(check)));
    const status = outcomes.every((outcome) => !outcome.required || outcome.status === 'up')
      ? 'up'
      : 'down';
    return { status, checks: outcomes };
  }

  private async runOne(check: ReadinessCheck): Promise<ReadinessCheckOutcome> {
    const timeoutMs = this.config.checkTimeoutMs;
    const required = check.required ?? true;
    const startedAt = Date.now();

    try {
      const report = await withTimeout(check.name, check.run(timeoutMs), timeoutMs);
      const latencyMs =
        typeof report.latencyMs === 'number' ? report.latencyMs : Date.now() - startedAt;
      const timestamp = report.timestamp ?? new Date().toISOString();

      if (report.status === 'up') {
        return { name: check.name, required, status: 'up', latencyMs, timestamp };
      }

      const detail = String(report.error ?? '');
      return {
        name: check.name,
        required,
        status: 'down',
        latencyMs,
        timestamp,
        error: TIMEOUT_MESSAGE.test(detail) ? 'timeout' : 'unavailable',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Readiness check "${check.name}" failed: ${message}`);
      return {
        name: check.name,
        required,
        status: 'down',
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        error: error instanceof ReadinessTimeoutError ? 'timeout' : 'unavailable',
      };
    }
  }
}
