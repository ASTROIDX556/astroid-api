import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';

export interface QueueHealthReport {
  status: 'up' | 'down';
  timestamp: string;
  latencyMs: number;
  error?: string;
}

/**
 * Probes the BullMQ connection by issuing a `PING` on the client of a queue the
 * application has already registered (the dead-letter queue, which every worker
 * depends on). The queue keeps one long-lived connection, so a probe reuses it
 * instead of opening a new Redis connection per request, and it reports the
 * state of the connection jobs are actually enqueued through — not just that
 * Redis answers somewhere else.
 *
 * Like the other indicators the probe is bounded by a timeout and never throws.
 * Failure detail goes to the log only; the report carries a fixed message so a
 * public probe cannot leak hostnames or credentials.
 */
@Injectable()
export class QueueHealthIndicator {
  private readonly logger = new Logger(QueueHealthIndicator.name);

  /** Ceiling on a single probe, in ms. */
  static readonly DEFAULT_TIMEOUT_MS = 2_000;

  constructor(@InjectQueue(Queues.DeadLetter) private readonly queue: Queue) {}

  async checkHealth(
    timeoutMs: number = QueueHealthIndicator.DEFAULT_TIMEOUT_MS,
  ): Promise<QueueHealthReport> {
    const start = Date.now();
    try {
      const reply = await this.withTimeout(this.ping(), timeoutMs);
      if (reply !== 'PONG') {
        throw new Error(`Unexpected ping response: ${String(reply)}`);
      }
      return {
        status: 'up',
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Queue health check failed after ${latencyMs}ms: ${message}`);
      return {
        status: 'down',
        timestamp: new Date().toISOString(),
        latencyMs,
        error: /timed out after \d+ms$/.test(message)
          ? message
          : 'Queue connection unavailable',
      };
    }
  }

  private async ping(): Promise<string> {
    const client = await this.queue.client;
    return client.ping();
  }

  private withTimeout<T>(probe: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return probe;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Queue health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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
}
