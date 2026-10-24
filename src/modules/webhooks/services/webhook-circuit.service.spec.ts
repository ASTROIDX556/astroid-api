import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { WebhookCircuitStatus } from '@prisma/client';

import {
  WebhookCircuitService,
  WebhookCircuitSnapshot,
} from './webhook-circuit.service';
import { PrismaService } from '../../../database/prisma.service';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { EventBusService } from '../../../events/event-bus.service';
import { WebhookFailureCategory } from '../utils/failure-classification';

/** A persisted circuit row. */
interface CircuitRow extends WebhookCircuitSnapshot {
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory stand-in for the `webhookCircuitState` Prisma delegate.
 *
 * It reproduces the semantics the service relies on: atomic counter
 * increments and conditional (`updateMany`) transitions, so the tests exercise
 * the real state machine instead of a set of recorded calls.
 */
class FakeCircuitStore {
  readonly rows = new Map<string, CircuitRow>();
  /** Hook that runs before every `updateMany`, used to simulate a concurrent write. */
  beforeUpdateMany: ((row: CircuitRow) => void) | null = null;

  findUnique = vi.fn(async ({ where }: { where: { webhookId: string } }) => {
    const row = this.rows.get(where.webhookId);
    return row ? { ...row } : null;
  });

  createMany = vi.fn(async ({ data }: { data: Array<Partial<CircuitRow>> }) => {
    let count = 0;
    for (const entry of data) {
      const webhookId = entry.webhookId as string;
      if (this.rows.has(webhookId)) continue;
      this.rows.set(webhookId, {
        webhookId,
        organizationId: entry.organizationId ?? 'org-1',
        status: entry.status ?? WebhookCircuitStatus.CLOSED,
        consecutiveFailures: entry.consecutiveFailures ?? 0,
        totalFailures: entry.totalFailures ?? 0,
        openedAt: entry.openedAt ?? null,
        cooldownEndsAt: entry.cooldownEndsAt ?? null,
        lastFailureAt: entry.lastFailureAt ?? null,
        lastFailureCode: entry.lastFailureCode ?? null,
        lastFailureReason: entry.lastFailureReason ?? null,
        lastSuccessAt: entry.lastSuccessAt ?? null,
        createdAt: entry.createdAt ?? new Date(),
        updatedAt: entry.updatedAt ?? new Date(),
      });
      count += 1;
    }
    return { count };
  });

  update = vi.fn(async ({ where, data }: { where: { webhookId: string }; data: Record<string, unknown> }) => {
    const row = this.rows.get(where.webhookId);
    if (!row) throw new Error(`Unknown circuit ${where.webhookId}`);
    const updated = { ...row } as CircuitRow;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        const increment = (value as { increment: number }).increment;
        (updated as unknown as Record<string, number>)[key] += increment;
      } else {
        (updated as unknown as Record<string, unknown>)[key] = value;
      }
    }
    this.rows.set(where.webhookId, updated);
    return { ...updated };
  });

  updateMany = vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const statuses = (where.status as { in?: WebhookCircuitStatus[] } | undefined)?.in;
      let count = 0;
      for (const row of this.rows.values()) {
        // The hook simulates a concurrent write that lands between the read
        // and the conditional update.
        this.beforeUpdateMany?.(row);
        if (where.webhookId !== undefined && row.webhookId !== where.webhookId) continue;
        if (statuses && !statuses.includes(row.status)) continue;
        if (statuses === undefined && where.status !== undefined && row.status !== where.status) {
          continue;
        }
        if (
          where.cooldownEndsAt !== undefined &&
          row.cooldownEndsAt?.getTime() !== (where.cooldownEndsAt as Date).getTime()
        ) {
          continue;
        }
        for (const [key, value] of Object.entries(data)) {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
        count += 1;
      }
      return { count };
    },
  );

  get(webhookId: string): CircuitRow | undefined {
    return this.rows.get(webhookId);
  }
}

const NOW = new Date('2026-10-20T12:00:00.000Z');

function failure(code = 'HTTP_503', reason = 'HTTP 503') {
  return {
    code,
    category: WebhookFailureCategory.Transient,
    reason,
    responseStatus: 503,
  };
}

describe('WebhookCircuitService', () => {
  let store: FakeCircuitStore;
  let emit: ReturnType<typeof vi.fn>;
  let service: WebhookCircuitService;

  function build(overrides: Partial<{ circuitEnabled: boolean; circuitFailureThreshold: number; circuitCooldownMs: number }> = {}, lock?: RedisLock): void {
    store = new FakeCircuitStore();
    emit = vi.fn().mockResolvedValue(undefined);
    const config = {
      get: vi.fn().mockReturnValue({
        maxAttempts: 5,
        backoffBaseDelayMs: 2_000,
        backoffMaxDelayMs: 60_000,
        requestTimeoutMs: 5_000,
        circuitEnabled: true,
        circuitFailureThreshold: 3,
        circuitCooldownMs: 300_000,
        ...overrides,
      }),
    } as unknown as ConfigService;

    service = new WebhookCircuitService(
      { webhookCircuitState: store } as unknown as PrismaService,
      config,
      { emit } as unknown as EventBusService,
      lock,
    );
  }

  beforeEach(() => {
    build();
  });

  describe('beforeAttempt', () => {
    it('allows the delivery when no state was recorded yet', async () => {
      const decision = await service.beforeAttempt('wh-1', NOW);

      expect(decision).toEqual({
        allowed: true,
        status: WebhookCircuitStatus.CLOSED,
        consecutiveFailures: 0,
      });
    });

    it('allows the delivery while the circuit is closed', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), 'https://example.com/hook', NOW);

      const decision = await service.beforeAttempt('wh-1', NOW);

      expect(decision.allowed).toBe(true);
      expect(decision.status).toBe(WebhookCircuitStatus.CLOSED);
    });

    it('blocks the delivery while the circuit is open', async () => {
      await openCircuit();

      const decision = await service.beforeAttempt('wh-1', NOW);

      expect(decision.allowed).toBe(false);
      expect(decision.status).toBe(WebhookCircuitStatus.OPEN);
      expect(decision.retryAt).toEqual(new Date(NOW.getTime() + 300_000));
    });

    it('allows a probe delivery once the cooldown elapsed', async () => {
      await openCircuit();

      const decision = await service.beforeAttempt(
        'wh-1',
        new Date(NOW.getTime() + 300_001),
      );

      expect(decision.allowed).toBe(true);
      expect(decision.status).toBe(WebhookCircuitStatus.HALF_OPEN);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.HALF_OPEN);
    });

    it('allows every delivery while the circuit is disabled', async () => {
      build({ circuitEnabled: false });

      const decision = await service.beforeAttempt('wh-1', NOW);

      expect(decision.allowed).toBe(true);
    });

    it('does not overwrite a circuit that was re-opened while deciding', async () => {
      await openCircuit();

      // A failure re-opens the circuit with a fresh cooldown right between the
      // read and the compare-and-set of the probe decision.
      const freshCooldown = new Date(NOW.getTime() + 600_000);
      store.beforeUpdateMany = (row) => {
        row.status = WebhookCircuitStatus.OPEN;
        row.cooldownEndsAt = freshCooldown;
      };

      const decision = await service.beforeAttempt(
        'wh-1',
        new Date(NOW.getTime() + 300_001),
      );

      // The stale decision must not probe a circuit that is open again, and it
      // must not clear the new cooldown either.
      expect(decision.allowed).toBe(false);
      expect(decision.retryAt).toEqual(freshCooldown);
      expect(store.get('wh-1')?.cooldownEndsAt).toEqual(freshCooldown);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.OPEN);
    });

    it('admits only a single probe delivery while the circuit is half-open', async () => {
      await openCircuit();

      const afterCooldown = new Date(NOW.getTime() + 300_001);
      const first = await service.beforeAttempt('wh-1', afterCooldown);
      expect(first.allowed).toBe(true);
      expect(first.status).toBe(WebhookCircuitStatus.HALF_OPEN);

      // A second delivery must not probe the endpoint again while the first
      // probe is still in flight.
      const second = await service.beforeAttempt('wh-1', afterCooldown);
      expect(second.allowed).toBe(false);
      expect(second.status).toBe(WebhookCircuitStatus.HALF_OPEN);
      expect(second.retryAt).toBeInstanceOf(Date);
    });

    it('allows a new probe when the previous one was lost', async () => {
      await openCircuit();

      const afterCooldown = new Date(NOW.getTime() + 300_001);
      await service.beforeAttempt('wh-1', afterCooldown);

      // The probe lease expires: the probe was lost, so a new one is allowed.
      const afterLease = new Date(NOW.getTime() + 300_001 + 300_000);
      const decision = await service.beforeAttempt('wh-1', afterLease);

      expect(decision.allowed).toBe(true);
      expect(decision.status).toBe(WebhookCircuitStatus.HALF_OPEN);
    });
  });

  describe('recordFailure', () => {
    it('counts the consecutive failures without opening the circuit', async () => {
      const outcome = await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      expect(outcome.opened).toBe(false);
      expect(outcome.consecutiveFailures).toBe(1);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.CLOSED);
      expect(emit).not.toHaveBeenCalled();
    });

    it('opens the circuit when the threshold is reached', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      const outcome = await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      expect(outcome.opened).toBe(true);
      expect(outcome.status).toBe(WebhookCircuitStatus.OPEN);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.OPEN);
      expect(store.get('wh-1')?.cooldownEndsAt).toEqual(new Date(NOW.getTime() + 300_000));
    });

    it('emits the circuit-opened domain event exactly once', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        'webhook.circuit_opened',
        expect.objectContaining({
          webhookId: 'wh-1',
          status: 'OPEN',
          consecutiveFailures: 3,
          threshold: 3,
          cooldownEndsAt: new Date(NOW.getTime() + 300_000).toISOString(),
          failureCode: 'HTTP_503',
        }),
        expect.objectContaining({ organizationId: 'org-1', aggregateType: 'webhook' }),
      );
    });

    it('does not extend a cooldown that is already running', async () => {
      await openCircuit();
      const openedAt = store.get('wh-1')?.cooldownEndsAt;

      await service.recordFailure(
        'wh-1',
        'org-1',
        failure(),
        undefined,
        new Date(NOW.getTime() + 1_000),
      );

      expect(store.get('wh-1')?.cooldownEndsAt).toEqual(openedAt);
    });

    it('re-opens the circuit when the probe delivery fails', async () => {
      await openCircuit();
      await service.beforeAttempt('wh-1', new Date(NOW.getTime() + 300_001));

      const outcome = await service.recordFailure(
        'wh-1',
        'org-1',
        failure(),
        undefined,
        new Date(NOW.getTime() + 300_002),
      );

      expect(outcome.opened).toBe(true);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.OPEN);
    });

    it('keeps the failure metadata for the operator', async () => {
      await service.recordFailure(
        'wh-1',
        'org-1',
        failure('TIMEOUT', 'Webhook request timed out'),
        undefined,
        NOW,
      );

      const state = store.get('wh-1');
      expect(state?.lastFailureCode).toBe('TIMEOUT');
      expect(state?.lastFailureReason).toBe('Webhook request timed out');
      expect(state?.lastFailureAt).toEqual(NOW);
      expect(state?.totalFailures).toBe(1);
    });

    it('does nothing while the circuit is disabled', async () => {
      build({ circuitEnabled: false });

      const outcome = await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      expect(outcome.opened).toBe(false);
      expect(store.rows.size).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('resets the failure counter of a closed circuit', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      await service.recordSuccess('wh-1', 'org-1', undefined, NOW);

      expect(store.get('wh-1')?.consecutiveFailures).toBe(0);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.CLOSED);
      expect(emit).not.toHaveBeenCalled();
    });

    it('closes an open circuit and reports the recovery', async () => {
      await openCircuit();

      await service.recordSuccess('wh-1', 'org-1', 'https://example.com/hook', NOW);

      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.CLOSED);
      expect(store.get('wh-1')?.consecutiveFailures).toBe(0);
      expect(store.get('wh-1')?.cooldownEndsAt).toBeNull();
      expect(emit).toHaveBeenCalledWith(
        'webhook.circuit_closed',
        expect.objectContaining({ webhookId: 'wh-1', status: 'CLOSED' }),
        expect.objectContaining({ organizationId: 'org-1' }),
      );
    });

    it('closes a half-open circuit after a successful probe', async () => {
      await openCircuit();
      await service.beforeAttempt('wh-1', new Date(NOW.getTime() + 300_001));

      await service.recordSuccess('wh-1', 'org-1', undefined, NOW);

      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.CLOSED);
    });
  });

  describe('concurrency', () => {
    it('opens the circuit only once when failures arrive concurrently', async () => {
      await Promise.all([
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
      ]);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(store.get('wh-1')?.status).toBe(WebhookCircuitStatus.OPEN);
      expect(store.get('wh-1')?.consecutiveFailures).toBe(4);
    });

    it('counts every failure of a concurrent burst', async () => {
      await Promise.all([
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
      ]);

      expect(store.get('wh-1')?.consecutiveFailures).toBe(3);
      expect(store.get('wh-1')?.totalFailures).toBe(3);
    });

    it('keeps the state of two endpoints apart', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      const other = await service.beforeAttempt('wh-2', NOW);

      expect(other.allowed).toBe(true);
      expect(other.consecutiveFailures).toBe(0);
    });
  });

  describe('locking', () => {
    it('does not run the critical section twice when it fails', async () => {
      const release = vi.fn().mockResolvedValue(undefined);
      const lock = {
        acquire: vi.fn().mockResolvedValue(release),
        withLock: vi.fn(),
      } as unknown as RedisLock;
      build({}, lock);

      // The database write fails inside the locked block.
      store.update.mockRejectedValue(new Error('database unavailable'));

      await expect(
        service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW),
      ).rejects.toThrow('database unavailable');

      // The failure must be counted exactly once, not twice.
      expect(store.update).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('runs the critical section without the lock when it cannot be acquired', async () => {
      const lock = {
        acquire: vi.fn().mockRejectedValue(new Error('redis unavailable')),
        withLock: vi.fn(),
      } as unknown as RedisLock;
      build({}, lock);

      const outcome = await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      expect(outcome.consecutiveFailures).toBe(1);
      expect(store.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('getState', () => {
    it('returns null when no state was recorded', async () => {
      expect(await service.getState('wh-1')).toBeNull();
    });

    it('returns the persisted state of an endpoint', async () => {
      await service.recordFailure('wh-1', 'org-1', failure(), undefined, NOW);

      const state = await service.getState('wh-1');

      expect(state).toMatchObject({
        webhookId: 'wh-1',
        organizationId: 'org-1',
        status: WebhookCircuitStatus.CLOSED,
        consecutiveFailures: 1,
        totalFailures: 1,
        lastFailureCode: 'HTTP_503',
      });
    });
  });

  /** Drives the circuit into the open state. */
  async function openCircuit(): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
      await service.recordFailure('wh-1', 'org-1', failure(), 'https://example.com/hook', NOW);
    }
    emit.mockClear();
  }
});
