import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Queue } from 'bullmq';
import { redisConfig } from '../../config/redis.config';
import { Queues } from '../../queues/queues.constants';

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly registry = new Registry();
  private readonly queues: Map<string, Queue> = new Map();

  private readonly httpRequestTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  private readonly httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  private readonly queueJobsGauge = new Gauge({
    name: 'bullmq_queue_jobs',
    help: 'Number of jobs in BullMQ queues by state',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });

  private readonly workerJobsTotal = new Counter({
    name: 'worker_jobs_total',
    help: 'Total processed worker jobs',
    labelNames: ['queue', 'job_name', 'result'],
    registers: [this.registry],
  });

  private readonly workerJobDurationSeconds = new Histogram({
    name: 'worker_job_duration_seconds',
    help: 'Worker job duration in seconds',
    labelNames: ['queue', 'job_name', 'result'],
    registers: [this.registry],
  });

  constructor() {
    const rConfig = redisConfig();
    const connection = {
      host: rConfig.host,
      port: rConfig.port,
      password: rConfig.password,
      db: rConfig.db,
    };

    const queueValues = Object.values(Queues);
    for (const qName of queueValues) {
      try {
        const queue = new Queue(qName, { connection });
        this.queues.set(qName, queue);
      } catch {
        // Ignore queue initialization errors gracefully
      }
    }
  }

  public get contentType(): string {
    return this.registry.contentType;
  }

  public observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestTotal.inc(labels);
    this.httpRequestDurationSeconds.observe(labels, durationSeconds);
  }

  public recordJobCompletion(queue: string, jobName: string, durationSeconds: number, result: 'success' | 'failure'): void {
    const labels = { queue, job_name: jobName, result };
    this.workerJobsTotal.inc(labels);
    this.workerJobDurationSeconds.observe(labels, durationSeconds);
  }

  private async collectQueueMetrics(): Promise<void> {
    for (const [qName, queue] of this.queues.entries()) {
      try {
        const counts = await queue.getJobCounts();
        this.queueJobsGauge.set({ queue: qName, state: 'waiting' }, counts.waiting ?? 0);
        this.queueJobsGauge.set({ queue: qName, state: 'active' }, counts.active ?? 0);
        this.queueJobsGauge.set({ queue: qName, state: 'completed' }, counts.completed ?? 0);
        this.queueJobsGauge.set({ queue: qName, state: 'failed' }, counts.failed ?? 0);
        this.queueJobsGauge.set({ queue: qName, state: 'delayed' }, counts.delayed ?? 0);
        this.queueJobsGauge.set({ queue: qName, state: 'paused' }, counts.paused ?? 0);
      } catch {
        // Handle Redis connection hiccups gracefully without crashing metrics collection
      }
    }
  }

  public async getMetrics(): Promise<string> {
    await this.collectQueueMetrics();
    return this.registry.metrics();
  }

  public async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) {
      try {
        await queue.close();
      } catch {
        // Ignore closing errors
      }
    }
    this.queues.clear();
  }
}
