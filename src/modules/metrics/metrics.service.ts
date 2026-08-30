import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { redisConfig } from '../../config/redis.config';
import { Queues } from '../../queues/queues.constants';

/** Job-count states BullMQ reports per queue via `Queue#getJobCounts`. */
const QUEUE_JOB_STATES = [
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'paused',
] as const;

/**
 * Owns the Prometheus metrics registry: HTTP request duration/count
 * (recorded by `RequestMetricsMiddleware`) and BullMQ queue depth gauges
 * (sampled on demand at scrape time so counts are always current).
 *
 * Read-only `Queue` handles are opened here purely to poll job counts —
 * no jobs are ever added or processed through them.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();

  private readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  private readonly httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;
  private readonly queueJobsGauge: Gauge<'queue' | 'state'>;
  private readonly queueHandles: Map<string, Queue>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.queueHandles = this.createQueueHandles();

    this.queueJobsGauge = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'Number of BullMQ jobs per queue, broken down by state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
      collect: async () => {
        await this.sampleQueueDepths();
      },
    });
  }

  /** Records one completed HTTP request against the duration/count metrics. */
  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  /** Renders the registry in Prometheus text exposition format. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private createQueueHandles(): Map<string, Queue> {
    const handles = new Map<string, Queue>();
    const { host, port, password, db } = redisConfig();

    for (const queueName of Object.values(Queues)) {
      handles.set(
        queueName,
        new Queue(queueName, {
          connection: { host, port, password: password || undefined, db },
        }),
      );
    }

    return handles;
  }

  private async sampleQueueDepths(): Promise<void> {
    await Promise.all(
      Array.from(this.queueHandles.entries()).map(async ([queueName, queue]) => {
        try {
          const counts = await queue.getJobCounts(...QUEUE_JOB_STATES);
          for (const state of QUEUE_JOB_STATES) {
            this.queueJobsGauge.set({ queue: queueName, state }, counts[state] ?? 0);
          }
        } catch (err) {
          this.logger.warn(
            `Failed to sample queue depth for "${queueName}": ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(Array.from(this.queueHandles.values()).map((queue) => queue.close()));
  }
}
