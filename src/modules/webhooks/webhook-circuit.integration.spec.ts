import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelayedError, Job } from 'bullmq';
import { WebhookCircuitStatus } from '@prisma/client';

import { WebhooksProcessor } from './webhooks.processor';
import { WebhookCircuitService } from './services/webhook-circuit.service';
import { WebhookJobData } from './types/webhook-job.types';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { EventBusService } from '../../events/event-bus.service';

/**
 * Integration tests for the per-endpoint circuit breaker inside the BullMQ
 * worker: the breaker must stop a failing endpoint from being hammered, defer
 * the delivery without consuming an attempt, and recover once the endpoint
 * answers again.
 */
describe('WebhooksProcessor — circuit breaker', () => {
  const WEBHOOK_SECRET = 'whsec_test-secret-key';
  const WEBHOOK_URL = 'https://example.com/webhook';
  const WEBHOOK_ID = 'wh-123';
  const ORG_ID = 'org-456';
  const EVENT_ID = 'txn-789-2024-01-01';
  const THRESHOLD = 3;
  const COOLDOWN_MS = 300_000;

  let processor: WebhooksProcessor;
  let circuit: WebhookCircuitService;
  let post: ReturnType<typeof vi.fn>;
  let moveToDelayed: ReturnType<typeof vi.fn>;
  let upsert: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let circuitRows: Map<string, Record<string, unknown>>;

  const createJobData = (overrides: Partial<WebhookJobData> = {}): WebhookJobData => ({
    webhookId: WEBHOOK_ID,
    organizationId: ORG_ID,
    url: WEBHOOK_URL,
    eventName: 'transaction.completed',
    payload: { event: 'transaction.completed' },
    eventId: EVENT_ID,
    ...overrides,
  });

  const createMockJob = (overrides: Partial<Job<WebhookJobData>> = {}): Job<WebhookJobData> =>
    ({
      id: 'job-1',
      name: 'webhook-delivery',
      data: createJobData(),
      attemptsMade: 0,
      token: 'lock-token',
      ...overrides,
    }) as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    circuitRows = new Map();
    post = vi.fn().mockResolvedValue({ status: 200 });
    moveToDelayed = vi.fn().mockResolvedValue(undefined);
    upsert = vi.fn().mockResolvedValue({});
    emit = vi.fn().mockResolvedValue(undefined);

    const mockPrisma = {
      webhook: { findFirst: vi.fn().mockResolvedValue({ secret: WEBHOOK_SECRET }) },
      webhookDelivery: { upsert },
    };

    const store = {
      findUnique: vi.fn(async ({ where }: { where: { webhookId: string } }) => {
        const row = circuitRows.get(where.webhookId);
        return row ? { ...row } : null;
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const entry of data) {
          const id = entry.webhookId as string;
          if (circuitRows.has(id)) continue;
          circuitRows.set(id, {
            webhookId: id,
            organizationId: entry.organizationId,
            status: WebhookCircuitStatus.CLOSED,
            consecutiveFailures: 0,
            totalFailures: 0,
            openedAt: null,
            cooldownEndsAt: null,
            lastFailureAt: null,
            lastFailureCode: null,
            lastFailureReason: null,
            lastSuccessAt: null,
            ...entry,
          });
        }
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { webhookId: string }; data: Record<string, unknown> }) => {
        const row = circuitRows.get(where.webhookId) as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            row[key] = (row[key] as number) + (value as { increment: number }).increment;
          } else {
            row[key] = value;
          }
        }
        return { ...row };
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const statuses = (where.status as { in?: WebhookCircuitStatus[] } | undefined)?.in;
          let count = 0;
          for (const row of circuitRows.values()) {
            if (where.webhookId !== undefined && row.webhookId !== where.webhookId) continue;
            if (statuses && !statuses.includes(row.status as WebhookCircuitStatus)) continue;
            if (
              statuses === undefined &&
              where.status !== undefined &&
              row.status !== where.status
            ) {
              continue;
            }
            if (
              where.cooldownEndsAt !== undefined &&
              (row.cooldownEndsAt as Date | null)?.getTime() !==
                (where.cooldownEndsAt as Date).getTime()
            ) {
              continue;
            }
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      ),
    };

    const config = {
      get: vi.fn().mockReturnValue({
        maxAttempts: 5,
        backoffBaseDelayMs: 2_000,
        backoffMaxDelayMs: 60_000,
        requestTimeoutMs: 5_000,
        circuitEnabled: true,
        circuitFailureThreshold: THRESHOLD,
        circuitCooldownMs: COOLDOWN_MS,
      }),
    } as unknown as ConfigService;

    circuit = new WebhookCircuitService(
      { webhookCircuitState: store } as unknown as PrismaService,
      config,
      { emit } as unknown as EventBusService,
      undefined,
    );

    processor = new WebhooksProcessor(
      mockPrisma as never,
      undefined,
      undefined,
      { post } as never,
      circuit,
      config,
      { emit } as unknown as EventBusService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a failed attempt against the endpoint circuit', async () => {
    post.mockResolvedValue({ status: 503 });

    await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 503');

    const row = circuitRows.get(WEBHOOK_ID);
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.status).toBe(WebhookCircuitStatus.CLOSED);
    expect(row?.lastFailureCode).toBe('HTTP_503');
  });

  it('writes the structured failure metadata into the delivery log', async () => {
    post.mockResolvedValue({ status: 503 });

    await expect(processor.process(createMockJob())).rejects.toThrow('HTTP 503');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'RETRYING',
          attempts: 1,
          lastError: 'HTTP 503',
          responseStatus: 503,
          failureCategory: 'transient',
          failureCode: 'HTTP_503',
          lastAttemptAt: expect.any(Date),
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });

  it('opens the circuit after the configured threshold of failures', async () => {
    post.mockResolvedValue({ status: 503 });

    for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
      await expect(
        processor.process(createMockJob({ attemptsMade: attempt } as Partial<Job<WebhookJobData>>)),
      ).rejects.toThrow('HTTP 503');
    }

    const row = circuitRows.get(WEBHOOK_ID);
    expect(row?.status).toBe(WebhookCircuitStatus.OPEN);
    expect(row?.consecutiveFailures).toBe(THRESHOLD);
    expect(row?.cooldownEndsAt).toBeInstanceOf(Date);
  });

  it('defers the delivery while the circuit is open instead of calling the endpoint', async () => {
    post.mockResolvedValue({ status: 503 });
    for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
      await expect(
        processor.process(createMockJob({ attemptsMade: attempt } as Partial<Job<WebhookJobData>>)),
      ).rejects.toThrow('HTTP 503');
    }
    post.mockClear();

    const job = createMockJob();
    Object.assign(job, { moveToDelayed });

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    // The endpoint was never touched again.
    expect(post).not.toHaveBeenCalled();
    // The job is rescheduled instead of being failed, so no attempt is used.
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('falls back to a retryable error when the job cannot be rescheduled', async () => {
    await openCircuit();

    // A job without the BullMQ rescheduling API falls back to the regular
    // retry mechanism, which keeps the delivery alive.
    await expect(processor.process(createMockJob())).rejects.toThrow(/circuit/i);

    expect(post).not.toHaveBeenCalled();
  });

  it('moves the job into the delayed set when the circuit is open', async () => {
    await openCircuit();

    const job = createMockJob();
    Object.assign(job, { moveToDelayed });

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp] = moveToDelayed.mock.calls[0] as [number, string];
    expect(timestamp).toBeGreaterThan(Date.now());
    expect(post).not.toHaveBeenCalled();
  });

  it('falls back to a retryable error when the job cannot be moved', async () => {
    await openCircuit();

    const job = createMockJob();
    Object.assign(job, { moveToDelayed: vi.fn().mockRejectedValue(new Error('missing lock')) });

    await expect(processor.process(job)).rejects.toThrow(/circuit/i);

    expect(post).not.toHaveBeenCalled();
  });

  it('records the deferred delivery in the delivery log', async () => {
    await openCircuit();
    upsert.mockClear();

    const job = createMockJob();
    Object.assign(job, { moveToDelayed });

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'RETRYING',
          failureCategory: 'circuit-open',
          failureCode: 'CIRCUIT_OPEN',
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not consume an attempt when the delivery is deferred', async () => {
    await openCircuit();
    upsert.mockClear();

    const job = createMockJob({ attemptsMade: 2 } as Partial<Job<WebhookJobData>>);
    Object.assign(job, { moveToDelayed });

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    // The delivery was never sent, so the attempt counter stays where it was.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ attempts: 2 }),
      }),
    );
  });

  it('allows a probe delivery after the cooldown and closes the circuit on success', async () => {
    await openCircuit();
    post.mockResolvedValue({ status: 200 });

    // The cooldown elapsed: the breaker moves to half-open.
    vi.setSystemTime(new Date(Date.now() + COOLDOWN_MS + 1));
    try {
      const result = await processor.process(createMockJob());
      expect(result).toEqual({ success: true, statusCode: 200 });
    } finally {
      vi.useRealTimers();
    }

    const row = circuitRows.get(WEBHOOK_ID);
    expect(row?.status).toBe(WebhookCircuitStatus.CLOSED);
    expect(row?.consecutiveFailures).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      'webhook.circuit_closed',
      expect.objectContaining({ webhookId: WEBHOOK_ID }),
      expect.any(Object),
    );
  });

  it('emits the terminal delivery-failure event when the retries are exhausted', async () => {
    post.mockResolvedValue({ status: 503 });

    await expect(
      processor.process(createMockJob({ attemptsMade: 4 } as Partial<Job<WebhookJobData>>)),
    ).rejects.toThrow('HTTP 503');

    expect(emit).toHaveBeenCalledWith(
      'webhook.delivery_failed',
      expect.objectContaining({
        webhookId: WEBHOOK_ID,
        attemptsMade: 5,
        failedReason: 'HTTP 503',
        responseStatus: 503,
        failureCategory: 'transient',
        failureCode: 'HTTP_503',
        circuitStatus: WebhookCircuitStatus.CLOSED,
      }),
      expect.objectContaining({ organizationId: ORG_ID, persist: false }),
    );
  });

  it('keeps the circuit state across worker restarts', async () => {
    post.mockResolvedValue({ status: 503 });
    for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
      await expect(
        processor.process(createMockJob({ attemptsMade: attempt } as Partial<Job<WebhookJobData>>)),
      ).rejects.toThrow('HTTP 503');
    }

    // A fresh processor reads the persisted state and still refuses to deliver.
    const restarted = new WebhooksProcessor(
      {
        webhook: { findFirst: vi.fn().mockResolvedValue({ secret: WEBHOOK_SECRET }) },
        webhookDelivery: { upsert },
      } as never,
      undefined,
      undefined,
      { post } as never,
      circuit,
      undefined,
      undefined,
    );
    post.mockClear();

    const job = createMockJob();
    Object.assign(job, { moveToDelayed });

    await expect(restarted.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not open a circuit when the breaker is disabled', async () => {
    const disabledConfig = {
      get: vi.fn().mockReturnValue({
        maxAttempts: 5,
        backoffBaseDelayMs: 2_000,
        backoffMaxDelayMs: 60_000,
        requestTimeoutMs: 5_000,
        circuitEnabled: false,
        circuitFailureThreshold: THRESHOLD,
        circuitCooldownMs: COOLDOWN_MS,
      }),
    } as unknown as ConfigService;
    const withoutCircuit = new WebhooksProcessor(
      {
        webhook: { findFirst: vi.fn().mockResolvedValue({ secret: WEBHOOK_SECRET }) },
        webhookDelivery: { upsert },
      } as never,
      undefined,
      undefined,
      { post } as never,
      undefined,
      disabledConfig,
      undefined,
    );

    post.mockResolvedValue({ status: 503 });
    for (let attempt = 0; attempt < THRESHOLD + 2; attempt += 1) {
      await expect(
        withoutCircuit.process(
          createMockJob({ attemptsMade: attempt } as Partial<Job<WebhookJobData>>),
        ),
      ).rejects.toThrow('HTTP 503');
    }

    expect(circuitRows.size).toBe(0);
    expect(post).toHaveBeenCalledTimes(THRESHOLD + 2);
  });

  /** Drives the endpoint's circuit into the open state. */
  async function openCircuit(): Promise<void> {
    post.mockResolvedValue({ status: 503 });
    for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
      await expect(
        processor.process(createMockJob({ attemptsMade: attempt } as Partial<Job<WebhookJobData>>)),
      ).rejects.toThrow('HTTP 503');
    }
    post.mockClear();
  }
});
